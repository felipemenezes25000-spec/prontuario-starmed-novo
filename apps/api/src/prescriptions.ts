import { Body, BadRequestException, ConflictException, Controller, ForbiddenException, Get, HttpException, InternalServerErrorException, NotFoundException, Param, Patch, Post, Req, Res, UnprocessableEntityException } from '@nestjs/common';
import { X509Certificate, createHash } from 'node:crypto';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, QueryRunner, requireCareContext, requireRole } from './security';
import { loadPolicy } from './pki/policy';
import { signPades, verifyPades } from './pki/pades';
import { embedSignature, readEmbeddedSignature, reserveSignatureSpace, verifyEmbeddedSignature } from './pki/pades-embed';
import { requestTimestamp, tsaConfigFromEnv, TsaError } from './pki/tsa';
import { TrustStore, TrustStoreError } from './pki/trust-store';
import { normalizeCertificatePem } from './pki/pem';
import { validateChain } from './pki/chain';
import { OIDS, documentTypeOid } from './pki/iti-oids';
import { checkRevocation, revocationModeFromEnv } from './pki/revocation';
import { qualifySignature, tsaCategoryToHttpStatus } from './signature';
import { ageInYears, brDate, complianceMissing, formatPhone, KIND_LABEL, kindBlockReason, PRESCRIPTION_KINDS, RX_RULES_VERSION, validUntil, type PrescriberRegistration, type PrescriptionKind } from './prescription-compliance';
import { loadRegistration } from './practitioners';
import { kindSubstanceConflict, sameActiveIngredient } from './medication-terms';

/** Fluxo de prescrição eletrônica: rascunho estruturado, segurança medicamentosa
 * (alergias registradas + duplicidade terapêutica), assinatura restrita a médico
 * ATIVO com idempotência (operationId) e PDF A4 próprio gravado EM ÍNTEGRA em
 * clinical_documents.content (bytes + sha256; migração 019).
 * Etapas de assinatura (C6/J1 #8-#10):
 *   1) POST /:id/sign      — atestação (signature_status='attested'): PDF emitido,
 *      persistido e hasheado; NUNCA "assinatura qualificada";
 *   2) POST /:id/sign-pades — PAdES/ICP-Brasil sobre OS BYTES DO PDF persistidos,
 *      cadeia validada fechada contra o trust store, OCSP opcional (REVOCATION_MODE
 *      =off|soft|hard, padrão off), ACT opcional (requireTimestamp), CMS persistido
 *      em document_signatures (prescription_id) e signature_status='pades'.
 * PENDÊNCIA HONESTA: o CMS sai DETACHED — o embarque PAdES no PDF (ByteRange)
 * segue pendente (pki/pades.ts não o implementa); a validação usa a evidência
 * armazenada ao lado do PDF, e a validação oficial continua sendo a do ITI. */

type ReqWithActor = { actor: Actor; headers?: Record<string, unknown> };
const breakGlassOf = (req: ReqWithActor) => req.headers?.['x-break-glass-reason'];
/** Subset estrutural da resposta Express usada no stream do PDF (padrão de sso.ts). */
type PdfHttpResponse = { setHeader(name: string, value: string | number): unknown; end(chunk?: unknown): unknown };

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
  // Tipo de receita (029). Bloqueios por tipo em prescription-compliance.ts.
  kind: z.enum(PRESCRIPTION_KINDS).default('simple'),
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
  kind: z.enum(PRESCRIPTION_KINDS).optional(),
  specialClass: z.string().trim().min(2).max(60).optional()
}).strict().refine(b => Object.values(b).some(v => v !== undefined), 'Informe ao menos um campo para edição');
const signPrescriptionSchema = z.object({
  operationId: uuid,
  overrideJustification: z.string().trim().min(20).max(2000).optional()
}).strict();
const cancelPrescriptionSchema = z.object({ reason: z.string().trim().min(8).max(1000) }).strict();
// Contrato do PAdES da prescrição: espelha signPadesRequestSchema de signature.ts
// (certificado/chave só em memória, nunca persistida) SEM expectedVersion/documentType:
// o documento é a prescrição :id e o tipo é sempre 'prescription' (OID do Cap. V).
const signPadesPrescriptionSchema = z.object({
  signerCertPem: z.string().trim().min(64, 'signerCertPem ausente ou truncado'),
  chainPems: z.array(z.string().trim().min(64)).max(10).default([]),
  privateKeyPkcs8Pem: z.string().trim().min(64, 'privateKeyPkcs8Pem ausente ou truncado'),
  councilNumber: z.string().regex(/^[0-9]{4,6}$/, 'councilNumber deve ter 4 a 6 dígitos'),
  councilState: z.string().regex(/^[A-Z]{2}$/, 'councilState deve ser uma UF (duas letras maiúsculas)'),
  requireTimestamp: z.boolean().default(false)
}).strict();

const PRESCRIPTION_COLUMNS =
  'p.id,p.encounter_id,p.prescriber_id,p.medication_code,p.medication_name,p.dose,p.dose_value,p.dose_unit,p.medication_form,' +
  'p.medication_concentration,p.route,p.frequency,p.duration,p.times,p.quantity,p.indication,p.instructions,p.special_class,' +
  'p.status,p.signature_status,p.signed_document_id,p.signed_by,p.signed_at,p.override_justification,p.cancel_reason,' +
  'p.cancelled_by,p.cancelled_at,p.created_at,p.updated_at,p.kind,p.valid_until,p.prescriber_registration';

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
/** Correspondência por texto OU pelo mesmo princípio ativo conhecido (lote 3:
 *  "Novalgina" × alergia a "dipirona"). Só acrescenta alertas. */
export function substanceMatch(a: string, b: string): boolean {
  return medTermsMatch(a, b) || sameActiveIngredient(a, b);
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
    if (!substanceMatch(input.medicationName, a.substance)) continue;
    if (a.criticality === 'high')
      alerts.push({ level: 'block', code: 'allergy_high', message: `Alergia crítica registrada (${a.substance}); prescrição bloqueada sem possibilidade de override.`, substance: a.substance, criticality: a.criticality });
    else
      alerts.push({ level: 'review_required', code: 'allergy_active', message: `Alergia ativa registrada (${a.substance}, criticidade ${a.criticality}); revisar antes de assinar.`, substance: a.substance, criticality: a.criticality });
  }
  for (const p of input.activePrescriptions) {
    if (!substanceMatch(input.medicationName, p.medication_name)) continue;
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

/** Tipo de receita bloqueado no ambiente (flag desligada ou dependência externa
 *  ausente) → 409 com o motivo honesto, sem gravar nada. */
export function ensureKindAllowed(kind: PrescriptionKind): void {
  const reason = kindBlockReason(kind);
  if (reason) throw new ConflictException(reason);
}
/** Substância regulada no tipo errado (ex.: clonazepam em receita simples) → 409. */
export function ensureKindFitsSubstance(kind: PrescriptionKind, medicationName: string): void {
  const reason = kindSubstanceConflict(kind, medicationName);
  if (reason) throw new ConflictException({ message: reason, code: 'kind_substance_mismatch' });
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
  /** 029: tipo de receita; ausente = simples (documentos anteriores). */
  kind?: PrescriptionKind;
  /** Último dia de validade (AAAA-MM-DD) quando o tipo tem validade regulatória. */
  validUntil?: string | null;
  /** Snapshot do registro profissional do assinante; ausente = documento anterior à 029. */
  prescriber?: PrescriberRegistration | null;
  patientSex?: string | null;
  patientAge?: number | null;
};

const SEX_LABEL: Record<string, string> = { male: 'Masculino', female: 'Feminino', other: 'Outro', unknown: 'Não informado' };

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
  const kind = input.kind ?? 'simple';
  // Antimicrobiano (RDC 471/2021): duas vias idênticas, cada uma começando em
  // página própria — 1ª retida pela farmácia, 2ª com o paciente.
  const vias = kind === 'antimicrobial' ? ['1ª via - retenção da farmácia', '2ª via - paciente'] : [null];
  const pages: PdfLine[][] = [];
  for (const via of vias) {
    const lines = prescriptionPdfLines(input, kind, via);
    for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  return renderPdf(pages);
}

function prescriptionPdfLines(input: PrescriptionPdfInput, kind: PrescriptionKind, via: string | null): PdfLine[] {
  const lines: PdfLine[] = [];
  const push = (text: string, size = 10) => lines.push({ text, size });
  push(`STARMed - ${input.orgName}`, 12);
  push(kind === 'simple' ? 'PRESCRIÇÃO MÉDICA ELETRÔNICA' : `PRESCRIÇÃO MÉDICA ELETRÔNICA - ${KIND_LABEL[kind].toUpperCase()}`, 13);
  if (via) push(via.toUpperCase(), 11);
  if (input.validUntil) push(`VALIDADE: até ${brDate(input.validUntil)} (10 dias contados da emissão, inclusive)`, 11);
  push(`Paciente: ${input.patientName}`);
  push(`Data de nascimento: ${input.patientBirthDate}`);
  if (kind === 'antimicrobial') {
    push(`Sexo: ${SEX_LABEL[input.patientSex ?? 'unknown'] ?? input.patientSex}`);
    if (input.patientAge != null) push(`Idade: ${input.patientAge} anos`);
  }
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
  push(`Prescrito e assinado por: ${input.prescriberName}`);
  const reg = input.prescriber;
  if (reg) {
    push(`CRM ${reg.councilNumber}/${reg.councilState}${reg.rqe ? ` - RQE ${reg.rqe}` : ''}${reg.specialty ? ` - ${reg.specialty}` : ''}`);
    if (reg.professionalAddress) for (const l of wrapPdfText(`Endereço profissional: ${reg.professionalAddress}`, 92)) push(l);
    if (reg.professionalPhone) push(`Telefone profissional: ${formatPhone(reg.professionalPhone)}`);
  } else {
    push('Registro profissional (CRM/UF): não registrado no momento da emissão.');
  }
  push(`Emitido em: ${input.signedAt}`);
  push(`Identificador SHA-256 dos dados: ${input.payloadSha256}`);
  push('Status na emissão: ATESTADO - PDF gerado, persistido e hasheado no servidor.', 11);
  push('Assinatura digital PAdES (ICP-Brasil): etapa SEPARADA, embarcada neste arquivo com ByteRange (ver POST /prescriptions/:id/sign-pades).', 10);
  push('Sem a etapa PAdES, esta folha NÃO constitui assinatura qualificada.', 10);
  push(`Regras de conformidade aplicadas: ${RX_RULES_VERSION}`, 9);
  return lines;
}

function renderPdf(pages: PdfLine[][]): Buffer {
  if (pages.length === 0) pages.push([]);

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

/** PDF persistido da prescrição com re-hash honesto (usado por GET :id/pdf e
 *  POST :id/sign-pades): content ausente → 404 declarando a ausência do artefato;
 *  hash divergente → 500 "documento corrompido" — bytes suspeitos NUNCA são
 *  servidos nem assinados (J1 #10 começa aqui: a assinatura cobre exatamente
 *  estes bytes). */
async function loadSignedPrescriptionPdf(db: QueryRunner, signedDocumentId: string | null, orgId: string): Promise<Buffer> {
  if (!signedDocumentId)
    throw new NotFoundException('PDF ainda não existe: o documento é emitido no ato da assinatura da prescrição.');
  const r = await db.query(
    'SELECT sha256, content FROM clinical_documents WHERE id=$1 AND org_id=$2', [signedDocumentId, orgId]);
  if (!r.rowCount) throw new NotFoundException('Documento da prescrição não encontrado.');
  const row = r.rows[0];
  if (row.content === null || row.content === undefined)
    throw new NotFoundException('PDF não disponível: o documento desta prescrição não tem conteúdo persistido (emitido antes da migração 019_prescription_pades).');
  const content = Buffer.from(row.content);
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== row.sha256)
    throw new InternalServerErrorException('Documento corrompido: o SHA-256 do conteúdo persistido diverge do hash registrado — o PDF não será servido nem assinado.');
  return content;
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
    ensureKindAllowed(body.kind);
    ensureKindFitsSubstance(body.kind, body.medication.name);
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
           medication_form,medication_concentration,route,frequency,duration,times,quantity,indication,instructions,kind)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18) RETURNING *`,
        [actor.org_id, encounterId, actor.id, body.medication.code ?? null, body.medication.name, doseText,
         body.dose.value, body.dose.unit, body.medication.form ?? null, body.medication.concentration ?? null,
         body.route, body.frequency, body.duration, JSON.stringify(body.times), body.quantity, body.indication, body.instructions, body.kind]);
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
    // Histórico de prescrições é prontuário completo: vínculo de cuidado ou
    // break-glass auditado para os papéis clínicos (admin supervisiona a org).
    if (actor.role === 'doctor' || actor.role === 'nurse')
      await requireCareContext(this.db, actor, patientId, breakGlassOf(req));
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
    const row = await this.db.query<any>(
      `SELECT ${PRESCRIPTION_COLUMNS}, e.patient_id
         FROM prescriptions p
         JOIN encounters e ON e.id=p.encounter_id AND e.org_id=p.org_id
        WHERE p.id=$1 AND p.org_id=$2`, [id, actor.org_id]);
    if (!row.rowCount) throw new NotFoundException('Prescrição não encontrada');
    if (actor.role === 'doctor' || actor.role === 'nurse')
      await requireCareContext(this.db, actor, row.rows[0].patient_id, breakGlassOf(req));
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
    if (body.kind) ensureKindAllowed(body.kind);
    const changed = Object.keys(body).filter(k => k !== 'specialClass');
    return this.db.tx(async c => {
      const current = await c.query<any>(
        `SELECT ${PRESCRIPTION_COLUMNS} FROM prescriptions p WHERE p.id=$1 AND p.org_id=$2 FOR UPDATE`, [id, actor.org_id]);
      if (!current.rowCount) throw new NotFoundException('Prescrição não encontrada');
      const row = current.rows[0];
      if (row.status !== 'draft') throw new ConflictException('Prescrição assinada ou cancelada é imutável: edição permitida apenas em rascunho');
      ensureKindFitsSubstance((body.kind ?? row.kind) as PrescriptionKind, body.medication?.name ?? row.medication_name);
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
           kind=COALESCE($17,kind),
           updated_at=now()
         WHERE id=$1 AND org_id=$2 RETURNING *`,
        [id, actor.org_id, body.medication?.code ?? null, body.medication?.name ?? null, doseText,
         body.dose?.value ?? null, body.dose?.unit ?? null, body.medication?.form ?? null, body.medication?.concentration ?? null,
         body.route ?? null, body.frequency ?? null, body.duration ?? null, body.times ? JSON.stringify(body.times) : null,
         body.quantity ?? null, body.indication ?? null, body.instructions ?? null, body.kind ?? null]);
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
      const me = await c.query<any>('SELECT role,active,display_name FROM users WHERE id=$1 AND org_id=$2', [actor.id, actor.org_id]);
      if (!me.rowCount || me.rows[0].role !== 'doctor' || !me.rows[0].active)
        throw new ForbiddenException('Apenas médicos ativos podem assinar prescrições');
      const loaded = await c.query<any>(
        `SELECT ${PRESCRIPTION_COLUMNS}, e.patient_id, pt.full_name AS patient_name, pt.birth_date, pt.administrative_gender,
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
      // 029: o tipo é rechecado NA ASSINATURA (a flag pode ter sido desligada
      // depois do rascunho) e a conformidade por tipo vem antes da segurança
      // medicamentosa: sem CRM/UF do ASSINANTE não se emite documento.
      const kind = row.kind as PrescriptionKind;
      ensureKindAllowed(kind);
      ensureKindFitsSubstance(kind, row.medication_name);
      const registration = await loadRegistration(c, actor.org_id, actor.id);
      const birthIso = row.birth_date instanceof Date ? row.birth_date.toISOString().slice(0, 10) : String(row.birth_date ?? '');
      const missing = complianceMissing({ kind, patient: { administrativeGender: row.administrative_gender ?? null, birthDate: birthIso || null }, registration });
      if (missing.length)
        throw new UnprocessableEntityException({ message: 'Receita não atende aos requisitos do tipo: complete os dados antes de assinar', missing, rulesVersion: RX_RULES_VERSION });
      const alerts = await computeSafetyAlerts(c, actor.org_id, row.patient_id, row.medication_name, id);
      if (hasBlockingAlert(alerts))
        throw new UnprocessableEntityException({ message: 'Segurança medicamentosa bloqueia a assinatura', alerts });
      if (hasReviewRequiredAlert(alerts) && !body.overrideJustification)
        throw new ConflictException({ message: 'Alertas de revisão obrigatória exigem overrideJustification', alerts });
      if (body.overrideJustification)
        await audit(c, actor, 'prescription.safety.override', 'prescription', id,
          { alertCodes: alerts.map(a => a.code), overrideJustification: body.overrideJustification });
      const signedAtDate = new Date();
      const validity = validUntil(kind, signedAtDate);
      const regSnapshot = registration ? {
        councilNumber: registration.councilNumber, councilState: registration.councilState, rqe: registration.rqe ?? null,
        specialty: registration.specialty ?? null, professionalAddress: registration.professionalAddress ?? null,
        professionalPhone: registration.professionalPhone ?? null, rulesVersion: RX_RULES_VERSION
      } : null;
      const payloadHash = prescriptionPayloadSha256({
        prescriptionId: id, kind, validUntil: validity, prescriberRegistration: regSnapshot, encounterId: row.encounter_id, patientId: row.patient_id, prescriberId: row.prescriber_id,
        medicationName: row.medication_name, medicationCode: row.medication_code, medicationForm: row.medication_form,
        medicationConcentration: row.medication_concentration, doseValue: row.dose_value, doseUnit: row.dose_unit,
        route: row.route, frequency: row.frequency, duration: row.duration, times: row.times,
        quantity: row.quantity, indication: row.indication, instructions: row.instructions
      });
      const signedAt = signedAtDate.toISOString();
      const birthDate = birthIso;
      const pdf = buildPrescriptionPdf({
        prescriptionId: id, encounterId: row.encounter_id, orgName: row.org_name, patientName: row.patient_name,
        patientBirthDate: birthDate, prescriberName: me.rows[0].display_name, medicationName: row.medication_name,
        medicationForm: row.medication_form, medicationConcentration: row.medication_concentration,
        doseText: row.dose ?? `${row.dose_value} ${row.dose_unit}`, route: row.route, frequency: row.frequency,
        duration: row.duration, times: row.times ?? [], quantity: row.quantity, indication: row.indication,
        instructions: row.instructions, signedAt, payloadSha256: payloadHash,
        kind, validUntil: validity, prescriber: regSnapshot, patientSex: row.administrative_gender ?? null,
        patientAge: birthDate ? ageInYears(birthDate, signedAtDate) : null
      });
      const pdfSha256 = createHash('sha256').update(pdf).digest('hex');
      const storageKey = `prescriptions/${actor.org_id}/${id}.pdf`;
      // Persistimos os BYTES do PDF junto do hash (migração 019): sem o conteúdo
      // o artefato assinável se perdia — só o sha256 ficava. INSERT novo é coerente
      // porque a prescrição nasce 'signed' uma única vez (replay de operationId
      // devolve a resposta original antes deste ponto, sem duplicar documento).
      const document = await c.query<any>(
        `INSERT INTO clinical_documents(org_id,patient_id,encounter_id,doc_type,storage_key,mime_type,sha256,content,created_by)
         VALUES($1,$2,$3,'prescription',$4,'application/pdf',$5,$6,$7) RETURNING id,storage_key,mime_type,sha256,created_at`,
        [actor.org_id, row.patient_id, row.encounter_id, storageKey, pdfSha256, pdf, actor.id]);
      const signed = await c.query<any>(
        `UPDATE prescriptions SET status='signed',signed_by=$3,signed_at=now(),signed_document_id=$4,
           signature_status='attested',override_justification=COALESCE($5,override_justification),
           valid_until=$6,prescriber_registration=$7::jsonb,updated_at=now()
         WHERE id=$1 AND org_id=$2 AND status='draft' RETURNING id,status,signature_status,signed_document_id,signed_at,kind,valid_until`,
        [id, actor.org_id, actor.id, document.rows[0].id, body.overrideJustification ?? null, validity, regSnapshot ? JSON.stringify(regSnapshot) : null]);
      if (!signed.rowCount) throw new ConflictException('Prescrição deixou de ser rascunho durante a assinatura');
      await audit(c, actor, 'prescription.signed', 'prescription', id,
        { documentId: document.rows[0].id, signatureStatus: 'attested', overridden: hasReviewRequiredAlert(alerts) });
      const response = {
        ...signed.rows[0],
        document: document.rows[0],
        document_sha256: pdfSha256,
        payload_sha256: payloadHash,
        safetyAlerts: alerts,
        signature_note: 'Documento emitido, persistido (bytes + SHA-256) e hasheado (atestado). A assinatura PAdES/ICP-Brasil é uma etapa SEPARADA (POST /prescriptions/:id/sign-pades): enquanto signature_status="attested", este documento NÃO constitui assinatura qualificada.'
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

  /** Download do PDF persistido (doctor/nurse): os bytes são re-hasheados contra
   *  o sha256 registrado ANTES de sair; falha honesta (404 sem artefato, 500
   *  corrompido). Nunca link público — sempre via Bearer na sessão. */
  @Get(':id/pdf')
  async downloadPdf(@Req() req: ReqWithActor, @Param('id') rawId: string, @Res() res: PdfHttpResponse) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    const id = parse(uuid, rawId);
    const loaded = await this.db.query<any>(
      `SELECT p.signed_document_id, e.patient_id
         FROM prescriptions p
         JOIN encounters e ON e.id = p.encounter_id AND e.org_id = p.org_id
        WHERE p.id = $1 AND p.org_id = $2`, [id, actor.org_id]);
    if (!loaded.rowCount) throw new NotFoundException('Prescrição não encontrada');
    try {
      const content = await loadSignedPrescriptionPdf(this.db, loaded.rows[0].signed_document_id, actor.org_id);
      await audit(this.db, actor, 'prescription.pdf.read', 'prescription', id,
        { documentId: loaded.rows[0].signed_document_id, patientId: loaded.rows[0].patient_id,
          sha256: createHash('sha256').update(content).digest('hex') });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="prescricao-${id}.pdf"`);
      res.setHeader('Content-Length', String(content.length));
      return res.end(content);
    } catch (e) {
      // Tentativa de download também é auditoria quando falha (artefato ausente/corrompido).
      await audit(this.db, actor, 'prescription.pdf.failed', 'prescription', id,
        { reason: e instanceof HttpException ? e.message : 'erro interno ao ler o documento' });
      throw e;
    }
  }

  /** Emissao PAdES/ICP-Brasil (AD-RT com carimbo, ou AD-RB) sobre a prescrição
   *  JÁ ATESTADA, assinando OS BYTES DO PDF persistidos (J1 #10: o CMS cobre
   *  exatamente estes bytes; alterar 1 byte do PDF invalida a verificação).
   *  Espelha notes/sign-pades (signature.ts): cadeia FECHADA no trust store
   *  (J1 #8), OCSP opcional por REVOCATION_MODE=off|soft|hard, ACT opcional com
   *  falha explícita (nunca AD-RB silencioso sob requireTimestamp).
   *  LIMITAÇÃO HONESTA: pki/pades.ts emite CMS DETACHED — o embarque PAdES no
   *  PDF (ByteRange) segue pendente; a evidência vive em document_signatures. */
  @Post(':id/sign-pades')
  async signPadesPrescription(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['doctor']);
    const id = parse(uuid, rawId);
    const body = parse(signPadesPrescriptionSchema, raw);

    // 1) Pré-condições SEM transação: rede (ACT/OCSP) acontece fora do tx.
    const me = await this.db.query<any>('SELECT role,active FROM users WHERE id=$1 AND org_id=$2', [actor.id, actor.org_id]);
    if (!me.rowCount || me.rows[0].role !== 'doctor' || !me.rows[0].active)
      throw new ForbiddenException('Apenas médicos ativos podem assinar prescrições');
    const loaded = await this.db.query<any>(
      `SELECT p.id,p.status,p.signature_status,p.signed_document_id
         FROM prescriptions p WHERE p.id=$1 AND p.org_id=$2`, [id, actor.org_id]);
    if (!loaded.rowCount) throw new NotFoundException('Prescrição não encontrada');
    const row = loaded.rows[0];
    if (row.status !== 'signed')
      throw new BadRequestException('Somente prescrições atestadas (status signed) podem receber assinatura PAdES');
    if (row.signature_status === 'pades')
      throw new ConflictException('Prescrição já possui assinatura PAdES registrada');
    const pdf = await loadSignedPrescriptionPdf(this.db, row.signed_document_id, actor.org_id);

    // 2) Cadeia do signer contra o trust store ICP-Brasil: falha FECHADA (J1 #8:
    //    certificado errado/expirado/fora da cadeia rejeitado, com o motivo real).
    let trust: TrustStore;
    try {
      trust = TrustStore.default();
    } catch (e) {
      throw new BadRequestException(e instanceof TrustStoreError ? e.message : 'Certificado fora do trust store ICP-Brasil');
    }
    let presented: X509Certificate[];
    try {
      presented = [new X509Certificate(normalizeCertificatePem(body.signerCertPem)), ...body.chainPems.map((p) => new X509Certificate(normalizeCertificatePem(p)))];
    } catch {
      throw new BadRequestException('Certificado ou cadeia PEM ilegível');
    }
    const chain = validateChain(presented[0], presented.slice(1), trust);
    if (!chain.ok) throw new BadRequestException(`Cadeia de certificação rejeitada (${chain.code}): ${chain.reason}`);

    // 3) Carimbo de tempo: só com requireTimestamp E ACT configurada. A LPA
    //    (ad-rt/ad-rb) acompanha a decisão e é carregada antes da rede (falha
    //    de leitura da política não deve custar um round-trip na ACT).
    const tsa = tsaConfigFromEnv();
    if (body.requireTimestamp && !tsa)
      throw new BadRequestException('Carimbo de tempo exigido, mas nenhuma ACT está configurada (TSA_URL)');
    const wantsTimestamp = Boolean(body.requireTimestamp && tsa);
    const policy = loadPolicy(wantsTimestamp ? 'ad-rt' : 'ad-rb');

    // 4) Revogação (OCSP): padrão DESLIGADO (REVOCATION_MODE=off, sem rede em CI);
    //    'hard' bloqueia revoked/unknown; 'soft' apenas reporta.
    const revocationMode = revocationModeFromEnv();
    const issuer = chain.path.length > 1 ? chain.path[1]
      : presented[0].subject === presented[0].issuer ? presented[0] : null;
    const revocation = await checkRevocation({ leaf: presented[0], issuer, mode: revocationMode });
    if (revocationMode === 'hard' && (revocation.status === 'revoked' || revocation.status === 'unknown'))
      throw new ForbiddenException({
        message: `Assinatura bloqueada (REVOCATION_MODE=hard): status de revogação "${revocation.status}" do certificado do signatário.`,
        revocation
      });

    // 5) Carimbo de tempo (ACT): falha com requireTimestamp ABORTA a emissão
    //    (TsaError → status honesto), nunca cai para AD-RB silenciosamente.
    let timestampTokenDer: Buffer | null = null;
    if (wantsTimestamp && tsa) {
      const imprint = createHash('sha256').update(pdf).digest();
      try {
        const tst = await requestTimestamp({ imprint }, tsa);
        timestampTokenDer = tst.tokenDer;
      } catch (e) {
        if (e instanceof TsaError)
          throw new HttpException(`Falha no carimbo de tempo (ACT): ${e.message}`, tsaCategoryToHttpStatus(e.category));
        throw e;
      }
    }

    // 6) EMBARQUE PAdES (ByteRange, C6/J1 #10): o layout reserva o espaço e grava
    //    o ByteRange REAL antes do assinamento; o CMS cobre os bytes FORA do
    //    buraco (o que o verificador recalcula). Ver pades-embed.ts.
    const reserved = reserveSignatureSpace(pdf);
    const geometry = readEmbeddedSignature(reserved);
    if (!geometry)
      throw new InternalServerErrorException('Falha ao preparar o espaço de assinatura do PDF (ByteRange)');
    const bytesToSign = Buffer.concat([
      reserved.subarray(0, geometry.byteRange[1]),
      reserved.subarray(geometry.byteRange[2], geometry.byteRange[3])
    ]);
    const signed = await signPades({
      content: bytesToSign,
      signerCertPem: body.signerCertPem,
      chainPems: body.chainPems,
      privateKeyPkcs8Pem: body.privateKeyPkcs8Pem,
      documentType: 'prescription',
      councilNumber: body.councilNumber,
      councilState: body.councilState,
      policy,
      timestampTokenDer
    });
    const embeddedPdf = embedSignature(reserved, signed.cms);
    const embeddedSha256 = createHash('sha256').update(embeddedPdf).digest('hex');
    const contentDigest = signed.digestSha256.toString('hex');
    const hasItiOids = documentTypeOid('prescription').startsWith(OIDS.POLICY_ARC + '.');
    // qualified=true SÓ se o carimbo entrou no CMS (tri-estado — nunca "assinatura válida").
    const signatureIsQualified = qualifySignature(signed.timestampApplied, hasItiOids);
    const timestampAuthority = signed.timestampApplied ? (tsa?.url ?? null) : null;

    // 7) Persistência em UMA transação: trava a prescrição (pode ter sido
    //    cancelada durante a rede), grava a evidência (note_id NULL,
    //    prescription_id preenchido, document_type='prescription') e transiciona
    //    attested → pades. Corrida de re-assinatura colide no índice único 019.
    return this.db.tx(async c => {
      const locked = await c.query<any>(
        'SELECT p.status,p.signature_status FROM prescriptions p WHERE p.id=$1 AND p.org_id=$2 FOR UPDATE OF p',
        [id, actor.org_id]);
      if (!locked.rowCount) throw new NotFoundException('Prescrição não encontrada');
      if (locked.rows[0].status !== 'signed')
        throw new ConflictException('Prescrição deixou de estar atestada durante a assinatura PAdES');
      if (locked.rows[0].signature_status === 'pades')
        throw new ConflictException('Prescrição já possui assinatura PAdES registrada');
      let record: { id: string; created_at: Date };
      try {
        const inserted = await c.query<any>(
          `INSERT INTO document_signatures(org_id,note_id,prescription_id,signer_user_id,cms,content_digest,document_type,
             council_number,council_state,policy_oid,timestamp_authority,signature_is_qualified,signature_path)
           VALUES($1,NULL,$2,$3,$4,$5,'prescription',$6,$7,$8,$9,$10,$11) RETURNING id, created_at`,
          [actor.org_id, id, actor.id, signed.cms, contentDigest, body.councilNumber, body.councilState,
           signed.policyOid, timestampAuthority, signatureIsQualified,
           JSON.stringify(chain.path.map((p) => ({ subject: p.subject, serialNumber: p.serialNumber, validTo: p.validTo })))]);
        record = inserted.rows[0];
      } catch (e: any) {
        if (e && e.code === '23505') throw new ConflictException('Prescrição já possui assinatura PAdES registrada');
        throw e;
      }
      const transition = await c.query<any>(
        `UPDATE prescriptions SET signature_status='pades', updated_at=now()
          WHERE id=$1 AND org_id=$2 AND status='signed' RETURNING id, signature_status`,
        [id, actor.org_id]);
      if (!transition.rowCount) throw new ConflictException('Prescrição deixou de estar atestada durante a assinatura PAdES');
      // O PDF EMBUTIDO (com /Contents preenchido) substitui o atestado na mesma
      // transação: content + sha256 novos — GET /:id/pdf re-hasheia e bate.
      if (row.signed_document_id) {
        await c.query(
          'UPDATE clinical_documents SET content=$3, sha256=$4 WHERE id=$1 AND org_id=$2',
          [row.signed_document_id, actor.org_id, embeddedPdf, embeddedSha256]);
      }
      await audit(c, actor, 'prescription.signed.pades', 'prescription', id, {
        signatureId: record.id,
        documentType: 'prescription',
        contentDigest,
        documentSha256: embeddedSha256,
        policyOid: signed.policyOid,
        timestampAuthority,
        signatureIsQualified,
        councilNumber: body.councilNumber,
        councilState: body.councilState,
        revocation
      });
      return {
        prescriptionId: id,
        signatureId: record.id,
        documentType: 'prescription',
        contentDigest,
        documentSha256: embeddedSha256,
        policyOid: signed.policyOid,
        timestampAuthority,
        signatureIsQualified,
        qualification: signatureIsQualified === true ? 'qualified' : signatureIsQualified === false ? 'not_qualified' : 'unknown',
        signer: { id: actor.id, councilNumber: body.councilNumber, councilState: body.councilState },
        revocation,
        padesEmbedding: {
          embedded: true,
          byteRange: geometry.byteRange,
          verifiedWith: 'POST /prescriptions/:id/verify-pades (ByteRange + CMS sobre os bytes externos ao buraco; 1 byte alterado invalida — J1 #10)'
        },
        note: 'Assinatura PAdES embarcada no PDF (ByteRange) e signature_status="pades". Isto NÃO é "assinatura válida" auto-declarada: a validação oficial (verificador do ITI) continua externa ao StarMed.',
        createdAt: record.created_at
      };
    });
  }

  /** Verificação da assinatura EMBUTIDA (J1 #10): geometria do ByteRange + CMS
   *  sobre os bytes externos ao buraco — adulterar 1 byte fora do buraco
   *  invalida a verificação; adulterar o buraco/geometria também. Resposta
   *  honesta em qualquer caso (nunca "válida" auto-declarada; o validador
   *  oficial do ITI continua sendo a referência externa). */
  @Post(':id/verify-pades')
  async verifyEmbedded(@Req() req: ReqWithActor, @Param('id') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    const id = parse(uuid, rawId);
    const loaded = await this.db.query<any>(
      'SELECT signed_document_id FROM prescriptions WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
    if (!loaded.rowCount) throw new NotFoundException('Prescrição não encontrada');
    const pdf = await loadSignedPrescriptionPdf(this.db, loaded.rows[0].signed_document_id, actor.org_id);
    const outcome = await verifyEmbeddedSignature(pdf, (cms, signedBytes) => verifyPades(cms, signedBytes));
    const checkedAt = new Date().toISOString();
    await audit(this.db, actor, 'prescription.pades.verified', 'prescription', id, { ok: outcome.ok });
    if (!outcome.ok)
      return { prescriptionId: id, byteRangeOk: false, tamperSuspect: true, reason: outcome.reason, checkedAt };
    const v = outcome.result;
    const qualification = qualifySignature(
      v.timestampPresent === true,
      typeof v.policyOid === 'string' ? v.policyOid.startsWith(OIDS.POLICY_ARC + '.') : null);
    return {
      prescriptionId: id,
      byteRangeOk: true,
      byteRange: outcome.byteRange,
      signatureValid: v.signatureValid === true,
      qualification: qualification === true ? 'qualified' : qualification === false ? 'not_qualified' : 'unknown',
      policyOid: v.policyOid ?? null,
      timestampPresent: v.timestampPresent === true,
      tamperSuspect: v.signatureValid !== true,
      checkedAt,
      note: 'Verificação local sobre os bytes embutidos (ByteRange/CMS); a validação oficial permanece no verificador do ITI.'
    };
  }
}
