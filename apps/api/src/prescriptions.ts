import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Req, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, QueryRunner, requireRole } from './security';

/** Fluxo de prescrição eletrônica: rascunho estruturado, segurança medicamentosa
 * (alergias registradas + duplicidade terapêutica), assinatura restrita a médico
 * ATIVO com idempotência (operationId) e PDF A4 próprio gravado em clinical_documents.
 * PENDÊNCIA HONESTA: a assinatura PAdES do PDF (signature.ts/pki) não é integrada
 * aqui — enquanto a emissão de certificado/carimbo não existir para prescrições,
 * o status fica 'attested' (documento emitido e hasheado) e NUNCA "assinatura válida". */

type ReqWithActor = { actor: Actor };

// ---------------------------------------------------------------------------
// Schemas (zod) — campos estruturados obrigatórios; dose sem unidade ou rota
// ausente estouram em 400 via parse() de domain.ts.
// ---------------------------------------------------------------------------

const medicationSchema = z.object({
  name: z.string().trim().min(2).max(200),
  code: z.string().trim().min(1).max(50).optional(),
  form: z.enum(['tablet', 'capsule', 'solution', 'suspension', 'cream', 'ointment', 'injectable', 'inhaler', 'drops', 'other']).optional(),
  concentration: z.string().trim().min(1).max(60).optional()
}).strict();
const doseSchema = z.object({
  value: z.number().positive().max(10000),
  unit: z.string().trim().min(1).max(30)
}).strict();
const timeSlot = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário deve ter formato HH:MM');
const createPrescriptionSchema = z.object({
  operationId: uuid,
  medication: medicationSchema,
  dose: doseSchema,
  route: z.string().trim().min(2).max(60),
  frequency: z.string().trim().min(1).max(80),
  duration: z.string().trim().min(1).max(80),
  times: z.array(timeSlot).min(1).max(6),
  quantity: z.number().int().positive().max(9999),
  indication: z.string().trim().min(2).max(500),
  instructions: z.string().trim().min(2).max(2000),
  specialClass: z.string().trim().min(2).max(60).optional()
}).strict();
const updatePrescriptionSchema = z.object({
  medication: medicationSchema.optional(),
  dose: doseSchema.optional(),
  route: z.string().trim().min(2).max(60).optional(),
  frequency: z.string().trim().min(1).max(80).optional(),
  duration: z.string().trim().min(1).max(80).optional(),
  times: z.array(timeSlot).min(1).max(6).optional(),
  quantity: z.number().int().positive().max(9999).optional(),
  indication: z.string().trim().min(2).max(500).optional(),
  instructions: z.string().trim().min(2).max(2000).optional(),
  specialClass: z.string().trim().min(2).max(60).optional()
}).strict().refine(b => Object.values(b).some(v => v !== undefined), 'Informe ao menos um campo para edição');
const signPrescriptionSchema = z.object({
  operationId: uuid,
  overrideJustification: z.string().trim().min(20).max(2000).optional()
}).strict();
const cancelPrescriptionSchema = z.object({ reason: z.string().trim().min(8).max(1000) }).strict();

const PRESCRIPTION_COLUMNS =
  'p.id,p.encounter_id,p.prescriber_id,p.medication_code,p.medication_name,p.dose,p.dose_value,p.dose_unit,p.medication_form,' +
  'p.medication_concentration,p.route,p.frequency,p.duration,p.times,p.quantity,p.indication,p.instructions,p.special_class,' +
  'p.status,p.signature_status,p.signed_document_id,p.signed_by,p.signed_at,p.override_justification,p.cancel_reason,' +
  'p.cancelled_by,p.cancelled_at,p.created_at,p.updated_at';

// ---------------------------------------------------------------------------
// Segurança medicamentosa (pura, testável sem banco). Heurística SOMENTE sobre
// dados já registrados no prontuário (alergias/duplicidade) — não há — e não
// será inventada aqui — base farmacológica de interações.
// ---------------------------------------------------------------------------

export type SafetyAlertLevel = 'info' | 'review_required' | 'block';
export type SafetyAlert = {
  level: SafetyAlertLevel;
  code: 'no_allergy_record' | 'allergy_high' | 'allergy_active' | 'duplicate_therapy';
  message: string;
  substance?: string;
  criticality?: string;
  existingPrescriptionId?: string;
};
export type AllergyInput = { substance: string; criticality: string; clinical_status: string };
export type ActivePrescriptionInput = { id: string; medication_name: string };

/** Normaliza termo medicamentoso para comparação (caixa, acentos, pontuação). */
export function normalizeMedTerm(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Correspondência declarativa entre medicação e substância registrada. */
export function medTermsMatch(a: string, b: string): boolean {
  const na = normalizeMedTerm(a);
  const nb = normalizeMedTerm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const tokens = new Set(na.split(' '));
  return nb.split(' ').some(t => t.length >= 4 && tokens.has(t));
}
export function evaluatePrescriptionSafety(input: {
  medicationName: string;
  allergies: AllergyInput[];
  activePrescriptions: ActivePrescriptionInput[];
}): SafetyAlert[] {
  const alerts: SafetyAlert[] = [];
  if (input.allergies.length === 0)
    alerts.push({ level: 'info', code: 'no_allergy_record', message: 'Paciente sem alergias registradas; confirme a anamnese antes de assinar.' });
  for (const a of input.allergies) {
    if (a.clinical_status !== 'active') continue;
    if (!medTermsMatch(input.medicationName, a.substance)) continue;
    if (a.criticality === 'high')
      alerts.push({ level: 'block', code: 'allergy_high', message: `Alergia crítica registrada (${a.substance}); prescrição bloqueada sem possibilidade de override.`, substance: a.substance, criticality: a.criticality });
    else
      alerts.push({ level: 'review_required', code: 'allergy_active', message: `Alergia ativa registrada (${a.substance}, criticidade ${a.criticality}); revisar antes de assinar.`, substance: a.substance, criticality: a.criticality });
  }
  for (const p of input.activePrescriptions) {
    if (!medTermsMatch(input.medicationName, p.medication_name)) continue;
    alerts.push({ level: 'review_required', code: 'duplicate_therapy', message: `Mesma medicação já prescrita ativamente (${p.id}); verificar duplicidade terapêutica.`, existingPrescriptionId: p.id });
  }
  return alerts;
}
export function hasBlockingAlert(alerts: SafetyAlert[]): boolean {
  return alerts.some(a => a.level === 'block');
}
export function hasReviewRequiredAlert(alerts: SafetyAlert[]): boolean {
  return alerts.some(a => a.level === 'review_required');
}

/** Classes especiais (controle específico, tarja, antimicrobiano) exigem
 * configuração ativa por organização que AINDA NÃO existe no sistema (não há
 * tabela/flag de configuração). Recusamos com 409 em vez de emitir documento
 * com classe silenciosamente inválida. */
export function specialClassAdmitted(config: { specialClassesEnabled: boolean } | null): boolean {
  return Boolean(config && config.specialClassesEnabled);
}
export function ensureSpecialClassConfigured(specialClass: string | undefined | null): void {
  if (!specialClass) return;
  const SPECIAL_CLASS_CONFIG: { specialClassesEnabled: boolean } | null = null;
  if (!specialClassAdmitted(SPECIAL_CLASS_CONFIG))
    throw new ConflictException('Classe especial enviada, mas a feature está desabilitada: nenhuma configuração ativa no sistema para validá-la.');
}

// ---------------------------------------------------------------------------
// Builder de PDF mínimo próprio (sem dependência nova): página A4, Helvetica
// com WinAnsiEncoding (acentos em português preservados), escape de \ ( ),
// xref com offsets em bytes e suporte a múltiplas páginas.
// ---------------------------------------------------------------------------

export type PrescriptionPdfInput = {
  prescriptionId: string;
  encounterId: string;
  orgName: string;
  patientName: string;
  patientBirthDate: string;
  prescriberName: string;
  medicationName: string;
  medicationForm: string | null;
  medicationConcentration: string | null;
  doseText: string;
  route: string;
  frequency: string;
  duration: string;
  times: string[];
  quantity: number;
  indication: string;
  instructions: string;
  signedAt: string;
  payloadSha256: string;
};

export function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
/** Texto vira bytes Latin-1/WinAnsi: caracteres fora de 0x00-0xFF viram '?'. */
export function pdfString(value: string): string {
  return escapePdfText(value.replace(/[^\u0000-\u00ff]/g, '?'));
}
export function wrapPdfText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= maxChars) current += ' ' + word;
    else { lines.push(current); current = word; }
  }
  if (current.length) lines.push(current);
  return lines.length ? lines : [''];
}
/** SHA-256 dos dados estruturados da receita (identificador impresso no PDF). */
export function prescriptionPayloadSha256(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

const A4 = { width: 595, height: 842 };
const LINES_PER_PAGE = 52;

type PdfLine = { text: string; size: number };

export function buildPrescriptionPdf(input: PrescriptionPdfInput): Buffer {
  const lines: PdfLine[] = [];
  const push = (text: string, size = 10) => lines.push({ text, size });
  push(`STARMed - ${input.orgName}`, 12);
  push('PRESCRIÇÃO MÉDICA ELETRÔNICA', 13);
  push(`Paciente: ${input.patientName}`);
  push(`Data de nascimento: ${input.patientBirthDate}`);
  push(`Atendimento: ${input.encounterId}`);
  push(`Prescrição: ${input.prescriptionId}`);
  push('');
  push(`Medicação: ${input.medicationName}${input.medicationConcentration ? ' ' + input.medicationConcentration : ''}`, 11);
  if (input.medicationForm) push(`Forma farmacêutica: ${input.medicationForm}`);
  push(`Dose: ${input.doseText}`);
  push(`Via de administração: ${input.route}`);
  push(`Frequência: ${input.frequency}`);
  push(`Duração: ${input.duration}`);
  push(`Horários: ${input.times.join(' ')}`);
  push(`Quantidade: ${input.quantity}`);
  push(`Indicação: ${input.indication}`);
  push('');
  push('Instruções:', 11);
  for (const l of wrapPdfText(input.instructions, 92)) push('  ' + l);
  push('');
  push(`Prescrito por: ${input.prescriberName}`);
  push('Registro profissional (CRM/UF): pendência - não cadastrado no sistema.');
  push(`Emitido em: ${input.signedAt}`);
  push(`Identificador SHA-256 dos dados: ${input.payloadSha256}`);
  push('Status do documento: ATESTADO - PDF gerado e hasheado no servidor.', 11);
  push('Assinatura digital PAdES (ICP-Brasil): PENDENTE de integração - este documento NÃO constitui assinatura qualificada.', 10);

  const pages: PdfLine[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  if (pages.length === 0) pages.push(lines);

  const fontObj = 3 + pages.length * 2;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`
  ];
  for (let i = 0; i < pages.length; i++) {
    const pageObj = 3 + i * 2;
    const contentObj = pageObj + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);
    const body = ['BT', `56 ${A4.height - 56} Td`];
    for (const line of pages[i]) {
      body.push(`/F1 ${line.size} Tf`, '14 TL', `(${pdfString(line.text)}) Tj`, 'T*');
    }
    body.push('ET', '');
    const stream = body.join('\n');
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  let pdf = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

async function loadEncounter(db: QueryRunner, encounterId: string, orgId: string) {
  const r = await db.query('SELECT id,patient_id,doctor_id,status FROM encounters WHERE id=$1 AND org_id=$2', [encounterId, orgId]);
  if (!r.rowCount) throw new NotFoundException('Atendimento não encontrado');
  return r.rows[0];
}

async function computeSafetyAlerts(db: QueryRunner, orgId: string, patientId: string, medicationName: string, excludePrescriptionId?: string): Promise<SafetyAlert[]> {
  const allergies = await db.query(
    'SELECT substance,criticality,clinical_status FROM patient_allergies WHERE org_id=$1 AND patient_id=$2 LIMIT 200',
    [orgId, patientId]);
  const active = await db.query(
    `SELECT p.id,p.medication_name FROM prescriptions p
      JOIN encounters e ON e.id=p.encounter_id AND e.org_id=p.org_id
      WHERE p.org_id=$1 AND e.patient_id=$2 AND p.status='signed' AND p.id<>$3 LIMIT 100`,
    [orgId, patientId, excludePrescriptionId ?? '00000000-0000-0000-0000-000000000000']);
  return evaluatePrescriptionSafety({ medicationName, allergies: allergies.rows, activePrescriptions: active.rows });
}

@Controller('encounters/:encounterId/prescriptions')
export class EncounterPrescriptionsController {
  constructor(private db: Db) {}

  @Get()
  async listByEncounter(@Req() req: ReqWithActor, @Param('encounterId') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const encounterId = parse(uuid, rawId);
    await loadEncounter(this.db, encounterId, actor.org_id);
    const rows = await this.db.query(
      `SELECT ${PRESCRIPTION_COLUMNS}, u.display_name AS prescriber_name
       FROM prescriptions p JOIN users u ON u.id=p.prescriber_id AND u.org_id=p.org_id
       WHERE p.org_id=$1 AND p.encounter_id=$2 ORDER BY p.created_at DESC LIMIT 200`,
      [actor.org_id, encounterId]);
    await audit(this.db, actor, 'prescription.list.read', 'encounter', encounterId);
    return rows.rows;
  }

  @Post()
  async createDraft(@Req() req: ReqWithActor, @Param('encounterId') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const encounterId = parse(uuid, rawId);
    const body = parse(createPrescriptionSchema, raw);
    ensureSpecialClassConfigured(body.specialClass);
    return this.db.tx(async c => {
      const encounter = await loadEncounter(c, encounterId, actor.org_id);
      if (encounter.status === 'cancelled') throw new ConflictException('Atendimento cancelado não aceita prescrição');
      // Autorização ANTES de devolver resposta em cache de idempotência (mesma regra do note.draft).
      const replay = await c.query<any>('SELECT operation,response FROM idempotency_keys WHERE org_id=$1 AND key=$2', [actor.org_id, body.operationId]);
      if (replay.rowCount) {
        if (replay.rows[0].operation !== 'prescription.create:' + encounterId) throw new ConflictException('Chave de idempotência reutilizada');
        return replay.rows[0].response;
      }
      const doseText = `${body.dose.value} ${body.dose.unit}`;
      const inserted = await c.query<any>(
        `INSERT INTO prescriptions(org_id,encounter_id,prescriber_id,medication_code,medication_name,dose,dose_value,dose_unit,
           medication_form,medication_concentration,route,frequency,duration,times,quantity,indication,instructions)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17) RETURNING *`,
        [actor.org_id, encounterId, actor.id, body.medication.code ?? null, body.medication.name, doseText,
         body.dose.value, body.dose.unit, body.medication.form ?? null, body.medication.concentration ?? null,
         body.route, body.frequency, body.duration, JSON.stringify(body.times), body.quantity, body.indication, body.instructions]);
      const alerts = await computeSafetyAlerts(c, actor.org_id, encounter.patient_id, body.medication.name);
      const response = { ...inserted.rows[0], safetyAlerts: alerts };
      await audit(c, actor, 'prescription.draft.created', 'prescription', inserted.rows[0].id,
        { encounterId, safetyAlertLevels: alerts.map(a => a.level) });
      await c.query('INSERT INTO idempotency_keys(org_id,key,operation,response) VALUES($1,$2,$3,$4)',
        [actor.org_id, body.operationId, 'prescription.create:' + encounterId, JSON.stringify(response)]);
      return response;
    });
  }
}

@Controller('patients/:patientId/prescriptions')
export class PatientPrescriptionsController {
  constructor(private db: Db) {}

  @Get()
  async listByPatient(@Req() req: ReqWithActor, @Param('patientId') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const patientId = parse(uuid, rawId);
    const patient = await this.db.query('SELECT 1 FROM patients WHERE id=$1 AND org_id=$2', [patientId, actor.org_id]);
    if (!patient.rowCount) throw new NotFoundException('Paciente não encontrado');
    const rows = await this.db.query(
      `SELECT ${PRESCRIPTION_COLUMNS}, e.patient_id, u.display_name AS prescriber_name
       FROM prescriptions p
       JOIN encounters e ON e.id=p.encounter_id AND e.org_id=p.org_id
       JOIN users u ON u.id=p.prescriber_id AND u.org_id=p.org_id
       WHERE p.org_id=$1 AND e.patient_id=$2 ORDER BY p.created_at DESC LIMIT 200`,
      [actor.org_id, patientId]);
    await audit(this.db, actor, 'prescription.list.read', 'patient', patientId);
    return rows.rows;
  }
}

@Controller('prescriptions')
export class PrescriptionsController {
  constructor(private db: Db) {}

  @Get(':id')
  async getOne(@Req() req: ReqWithActor, @Param('id') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const id = parse(uuid, rawId);
    const row = await this.db.query<any>(`SELECT ${PRESCRIPTION_COLUMNS} FROM prescriptions p WHERE p.id=$1 AND p.org_id=$2`, [id, actor.org_id]);
    if (!row.rowCount) throw new NotFoundException('Prescrição não encontrada');
    await audit(this.db, actor, 'prescription.read', 'prescription', id);
    return row.rows[0];
  }

  @Patch(':id')
  async updateDraft(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const id = parse(uuid, rawId);
    const body = parse(updatePrescriptionSchema, raw);
    ensureSpecialClassConfigured(body.specialClass);
    const changed = Object.keys(body).filter(k => k !== 'specialClass');
    return this.db.tx(async c => {
      const current = await c.query<any>(
        `SELECT ${PRESCRIPTION_COLUMNS} FROM prescriptions p WHERE p.id=$1 AND p.org_id=$2 FOR UPDATE`, [id, actor.org_id]);
      if (!current.rowCount) throw new NotFoundException('Prescrição não encontrada');
      const row = current.rows[0];
      if (row.status !== 'draft') throw new ConflictException('Prescrição assinada ou cancelada é imutável: edição permitida apenas em rascunho');
      const encounter = await loadEncounter(c, row.encounter_id, actor.org_id);
      const doseText = body.dose ? `${body.dose.value} ${body.dose.unit}` : null;
      const updated = await c.query<any>(
        `UPDATE prescriptions SET
           medication_code=COALESCE($3,medication_code),
           medication_name=COALESCE($4,medication_name),
           dose=COALESCE($5,dose),
           dose_value=COALESCE($6,dose_value),
           dose_unit=COALESCE($7,dose_unit),
           medication_form=COALESCE($8,medication_form),
           medication_concentration=COALESCE($9,medication_concentration),
           route=COALESCE($10,route),
           frequency=COALESCE($11,frequency),
           duration=COALESCE($12,duration),
           times=COALESCE($13::jsonb,times),
           quantity=COALESCE($14,quantity),
           indication=COALESCE($15,indication),
           instructions=COALESCE($16,instructions),
           updated_at=now()
         WHERE id=$1 AND org_id=$2 RETURNING *`,
        [id, actor.org_id, body.medication?.code ?? null, body.medication?.name ?? null, doseText,
         body.dose?.value ?? null, body.dose?.unit ?? null, body.medication?.form ?? null, body.medication?.concentration ?? null,
         body.route ?? null, body.frequency ?? null, body.duration ?? null, body.times ? JSON.stringify(body.times) : null,
         body.quantity ?? null, body.indication ?? null, body.instructions ?? null]);
      const alerts = await computeSafetyAlerts(c, actor.org_id, encounter.patient_id, updated.rows[0].medication_name, id);
      await audit(c, actor, 'prescription.draft.updated', 'prescription', id, { changedFields: changed });
      return { ...updated.rows[0], safetyAlerts: alerts };
    });
  }

  @Post(':id/sign')
  async sign(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    // J1 #16: SOMENTE médico ativo assina — admin/nurse/reception recebem 403,
    // mesmo admin, via requireRole + rechecagem de role/active direto no banco.
    requireRole(actor, ['doctor']);
    const id = parse(uuid, rawId);
    const body = parse(signPrescriptionSchema, raw);
    return this.db.tx(async c => {
      const me = await c.query<any>('SELECT role,active FROM users WHERE id=$1 AND org_id=$2', [actor.id, actor.org_id]);
      if (!me.rowCount || me.rows[0].role !== 'doctor' || !me.rows[0].active)
        throw new ForbiddenException('Apenas médicos ativos podem assinar prescrições');
      const loaded = await c.query<any>(
        `SELECT ${PRESCRIPTION_COLUMNS}, e.patient_id, pt.full_name AS patient_name, pt.birth_date,
                u.display_name AS prescriber_name, o.name AS org_name
         FROM prescriptions p
         JOIN encounters e ON e.id=p.encounter_id AND e.org_id=p.org_id
         JOIN patients pt ON pt.id=e.patient_id AND pt.org_id=p.org_id
         JOIN users u ON u.id=p.prescriber_id AND u.org_id=p.org_id
         JOIN organizations o ON o.id=p.org_id
         WHERE p.id=$1 AND p.org_id=$2 FOR UPDATE OF p`,
        [id, actor.org_id]);
      if (!loaded.rowCount) throw new NotFoundException('Prescrição não encontrada');
      const row = loaded.rows[0];
      // Idempotência (J1 #9): repetição do mesmo operationId devolve a resposta
      // original sem duplicar documento nem transição de estado.
      const replay = await c.query<any>('SELECT operation,response FROM idempotency_keys WHERE org_id=$1 AND key=$2', [actor.org_id, body.operationId]);
      if (replay.rowCount) {
        if (replay.rows[0].operation !== 'prescription.sign:' + id) throw new ConflictException('Chave de idempotência reutilizada');
        return replay.rows[0].response;
      }
      if (row.status === 'cancelled') throw new ConflictException('Prescrição cancelada não pode ser assinada');
      if (row.status === 'signed') throw new ConflictException('Prescrição já assinada');
      const alerts = await computeSafetyAlerts(c, actor.org_id, row.patient_id, row.medication_name, id);
      if (hasBlockingAlert(alerts))
        throw new UnprocessableEntityException({ message: 'Segurança medicamentosa bloqueia a assinatura', alerts });
      if (hasReviewRequiredAlert(alerts) && !body.overrideJustification)
        throw new ConflictException({ message: 'Alertas de revisão obrigatória exigem overrideJustification', alerts });
      if (body.overrideJustification)
        await audit(c, actor, 'prescription.safety.override', 'prescription', id,
          { alertCodes: alerts.map(a => a.code), overrideJustification: body.overrideJustification });
      const payloadHash = prescriptionPayloadSha256({
        prescriptionId: id, encounterId: row.encounter_id, patientId: row.patient_id, prescriberId: row.prescriber_id,
        medicationName: row.medication_name, medicationCode: row.medication_code, medicationForm: row.medication_form,
        medicationConcentration: row.medication_concentration, doseValue: row.dose_value, doseUnit: row.dose_unit,
        route: row.route, frequency: row.frequency, duration: row.duration, times: row.times,
        quantity: row.quantity, indication: row.indication, instructions: row.instructions
      });
      const signedAt = new Date().toISOString();
      const birthDate = row.birth_date instanceof Date ? row.birth_date.toISOString().slice(0, 10) : String(row.birth_date);
      const pdf = buildPrescriptionPdf({
        prescriptionId: id, encounterId: row.encounter_id, orgName: row.org_name, patientName: row.patient_name,
        patientBirthDate: birthDate, prescriberName: row.prescriber_name, medicationName: row.medication_name,
        medicationForm: row.medication_form, medicationConcentration: row.medication_concentration,
        doseText: row.dose ?? `${row.dose_value} ${row.dose_unit}`, route: row.route, frequency: row.frequency,
        duration: row.duration, times: row.times ?? [], quantity: row.quantity, indication: row.indication,
        instructions: row.instructions, signedAt, payloadSha256: payloadHash
      });
      const pdfSha256 = createHash('sha256').update(pdf).digest('hex');
      const storageKey = `prescriptions/${actor.org_id}/${id}.pdf`;
      const document = await c.query<any>(
        `INSERT INTO clinical_documents(org_id,patient_id,encounter_id,doc_type,storage_key,mime_type,sha256,created_by)
         VALUES($1,$2,$3,'prescription',$4,'application/pdf',$5,$6) RETURNING id,storage_key,mime_type,sha256,created_at`,
        [actor.org_id, row.patient_id, row.encounter_id, storageKey, pdfSha256, actor.id]);
      const signed = await c.query<any>(
        `UPDATE prescriptions SET status='signed',signed_by=$3,signed_at=now(),signed_document_id=$4,
           signature_status='attested',override_justification=COALESCE($5,override_justification),updated_at=now()
         WHERE id=$1 AND org_id=$2 AND status='draft' RETURNING id,status,signature_status,signed_document_id,signed_at`,
        [id, actor.org_id, actor.id, document.rows[0].id, body.overrideJustification ?? null]);
      if (!signed.rowCount) throw new ConflictException('Prescrição deixou de ser rascunho durante a assinatura');
      await audit(c, actor, 'prescription.signed', 'prescription', id,
        { documentId: document.rows[0].id, signatureStatus: 'attested', overridden: hasReviewRequiredAlert(alerts) });
      const response = {
        ...signed.rows[0],
        document: document.rows[0],
        document_sha256: pdfSha256,
        payload_sha256: payloadHash,
        safetyAlerts: alerts,
        signature_note: 'Documento emitido e hasheado (atestado). Assinatura digital PAdES pendente de integração — não constitui assinatura qualificada.'
      };
      await c.query('INSERT INTO idempotency_keys(org_id,key,operation,response) VALUES($1,$2,$3,$4)',
        [actor.org_id, body.operationId, 'prescription.sign:' + id, JSON.stringify(response)]);
      return response;
    });
  }

  @Post(':id/cancel')
  async cancel(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const id = parse(uuid, rawId);
    const body = parse(cancelPrescriptionSchema, raw);
    return this.db.tx(async c => {
      const current = await c.query<any>('SELECT status FROM prescriptions WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, actor.org_id]);
      if (!current.rowCount) throw new NotFoundException('Prescrição não encontrada');
      if (current.rows[0].status === 'cancelled') throw new ConflictException('Prescrição já cancelada');
      const wasSigned = current.rows[0].status === 'signed';
      // Cancelamento NUNCA apaga: prescrição assinada vira 'cancelled' com rastro
      // completo (motivo, autor, horário) e o documento assinado permanece.
      await c.query(
        `UPDATE prescriptions SET status='cancelled',cancel_reason=$3,cancelled_by=$4,cancelled_at=now(),updated_at=now()
         WHERE id=$1 AND org_id=$2`,
        [id, actor.org_id, body.reason, actor.id]);
      await audit(c, actor, 'prescription.cancelled', 'prescription', id, { reason: body.reason, wasSigned });
      return { id, status: 'cancelled', wasSigned };
    });
  }
}
