import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, requireRole } from './security';
import { OrderStatus, assertTransition, orderStatusSchema, validateTransition } from './orders';

/** Módulo hospitalar: leitos, admissões (ADT), antimicrobianos 344/ANVISA e pedidos LIS/PACS. */

type ReqWithActor = { actor: Actor };

const wardSchema = z.object({
  code: z.string().trim().min(2).max(30),
  name: z.string().trim().min(2).max(120),
  specialty: z.enum(['general', 'cardiology', 'orthopedics', 'pediatrics', 'neurology', 'psychiatry', 'gynecology']).default('general')
}).strict();
const bedsSchema = z.object({ labels: z.array(z.string().trim().min(1).max(30)).min(1).max(200) }).strict();
const admitSchema = z.object({ patientId: uuid, wardId: uuid, bedId: uuid }).strict();
const transferSchema = z.object({ wardId: uuid, bedId: uuid }).strict();
const dischargeSchema = z.object({ disposition: z.enum(['home', 'transfer_other', 'deceased', 'left_without_permission']) }).strict();
const antimicrobialSchema = z.object({
  admissionId: uuid.optional(),
  patientId: uuid,
  medicationName: z.string().trim().min(2).max(200),
  tussCode: z.string().trim().max(50).optional(),
  justification: z.string().trim().min(20).max(2000),
  cultureSent: z.boolean().default(false)
}).strict();
const suspendSchema = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();
const orderSchema = z.object({
  patientId: uuid,
  orderType: z.enum(['lab', 'imaging']),
  loincCode: z.string().trim().max(50).optional(),
  description: z.string().trim().min(3).max(500),
  priority: z.enum(['routine', 'urgent']).default('routine')
}).strict();
// O schema ESTENDIDO de PATCH orders/:id/status (ciclo 023: resultValue/
// resultReference/resultUnits/communicatedTo + campos legados preservados)
// mora em orders.ts — fonte única compartilhada com a máquina de transições.

export type AdmissionStatus = 'admitted' | 'transferred' | 'discharged';

/** Máquina de estados pura das admissões (testável sem banco). */
export function admit(current: AdmissionStatus | null): void {
  if (current !== null) throw new ConflictException('Paciente já tem admissão ativa');
}
export function transfer(current: AdmissionStatus): void {
  if (current !== 'admitted') throw new ConflictException('Transferência exige admissão ativa');
}
export function discharge(current: AdmissionStatus): void {
  if (current !== 'admitted') throw new ConflictException('Alta exige admissão ativa');
}

// Ciclo completo do pedido diagnóstico (ST-P1-005): a máquina de transições
// PURA vive em orders.ts (canTransition/ORDER_TRANSITIONS) e é compartilhada
// com o controller de resultados. Reexporta para os call sites/testes atuais.
export { ORDER_TRANSITIONS, canTransition } from './orders';
export type { OrderStatus } from './orders';
/** Mantém o contrato existente (hospital.test.ts): 409 'Transição inválida: a → b'. */
export function orderTransition(current: OrderStatus, next: OrderStatus): void {
  assertTransition(current, next);
}

export function occupancyRate(total: number, occupied: number): number {
  if (total === 0) return 0;
  return Math.round((occupied / total) * 1000) / 1000;
}

// ------------------------------------------------------------------ Flag 344
/**
 * Programa 344 (antimicrobianos/ANVISA) sob FEATURE FLAG: é um serviço de
 * MERCADO, e ainda não há decisão de mercado/regulatória da direção sobre
 * incluí-lo no market-fit. A flag evita expor o programa — inclusive listando
 * dados do banco como se estivesse ativo — antes dessa decisão: enquanto off
 * (ausente = off por padrão), POST/suspend respondem 409 honesto com auditoria
 * `hospital.344.blocked`, e o GET devolve {disabled:true} sem tocar a tabela.
 */
export const ANTIMICROBIAL_344_OFF_REASON =
  'Programa 344 desligado (FEATURE_ANTIMICROBIAL_344 ausente — decisão de mercado pendente)';

/** Pura: só liga com valores explícitos ('1'/'true'/'on'/'yes'). */
export function antimicrobial344Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return ['1', 'true', 'on', 'yes'].includes(String(env.FEATURE_ANTIMICROBIAL_344 || '').toLowerCase().trim());
}

// ------------------------------------------------ Checagem de medicação (027)
// medication_administrations (migração 027) é LIVRO DE REGISTRO do que a
// enfermagem administrou — nenhum trigger escreve aqui. `barcode` é OPCIONAL:
// enquanto o mercado não exige checagem por scanner, o campo já é gravado e o
// audit registra apenas a PRESENÇA dele (sem nome do medicamento nem nota —
// isso é dado clínico do paciente e não vai para audit_events).
export const administrationSchema = z.object({
  medicationName: z.string().trim().min(1).max(200),
  dose: z.string().trim().min(1).max(80).optional(),
  route: z.string().trim().min(1).max(80).optional(),
  barcode: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().min(1).max(500).optional(),
  prescriptionId: uuid.optional(),
  administeredAt: z.string().datetime({ offset: true })
    .refine(v => new Date(v).getTime() <= Date.now() + 5 * 60 * 1000,
      'administeredAt não pode ir além de 5 minutos no futuro')
    .optional()
}).strict();

/**
 * Chave PURA de checagem de duplicidade: mesma admissão + medicamento
 * normalizado (trim/minúsculas) + horário truncado no minuto. O handler compara
 * esta chave, linha a linha, contra as administrações já registradas no minuto
 * e responde 409 "Administração idêntica já registrada neste horário" — evita
 * duplo lançamento da mesma dose (clique duplo/reenvio), sem barra legítima.
 */
export function administrationDuplicateKey(input: {
  admissionId: string; medicationName: string; administeredAt: string | Date;
}): string {
  const at = input.administeredAt instanceof Date ? input.administeredAt : new Date(input.administeredAt);
  const minute = Number.isNaN(at.getTime()) ? 'invalid-date' : at.toISOString().slice(0, 16);
  // Espaços internos colapsam: 'Dipirona   500mg' ≡ 'dipirona 500mg' na checagem.
  const medication = input.medicationName.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${input.admissionId}|${medication}|${minute}`;
}

@Controller('hospital')
export class HospitalController {
  constructor(private db: Db) {}

  @Post('wards')
  async createWard(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const body = parse(wardSchema, raw);
    const existing = await this.db.query('SELECT 1 FROM hospital_wards WHERE org_id=$1 AND code=$2', [actor.org_id, body.code]);
    if (existing.rowCount) throw new ConflictException('Código de ala já existe');
    const ward = await this.db.query<any>(
      'INSERT INTO hospital_wards(org_id,code,name,specialty) VALUES($1,$2,$3,$4) RETURNING id,code,name,specialty',
      [actor.org_id, body.code, body.name, body.specialty]);
    await audit(this.db, actor, 'hospital.ward.created', 'hospital_ward', ward.rows[0].id);
    return ward.rows[0];
  }

  @Get('wards')
  async listWards(@Req() req: ReqWithActor) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const rows = await this.db.query('SELECT id,code,name,specialty FROM hospital_wards WHERE org_id=$1 ORDER BY code', [actor.org_id]);
    return rows.rows;
  }

  @Post('wards/:wardId/beds')
  async createBeds(@Req() req: ReqWithActor, @Param('wardId') rawWardId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const wardId = parse(uuid, rawWardId);
    const body = parse(bedsSchema, raw);
    const ward = await this.db.query('SELECT 1 FROM hospital_wards WHERE id=$1 AND org_id=$2', [wardId, actor.org_id]);
    if (!ward.rowCount) throw new NotFoundException('Ala não encontrada');
    const created = await this.db.tx(async c => {
      const ids: string[] = [];
      for (const label of body.labels) {
        const row = await c.query(
          'INSERT INTO hospital_beds(org_id,ward_id,label) VALUES($1,$2,$3) RETURNING id,label',
          [actor.org_id, wardId, label]);
        ids.push(row.rows[0].id);
      }
      return ids;
    });
    return { created: created.length, bedIds: created };
  }

  @Get('beds')
  async listBeds(@Req() req: ReqWithActor, @Query('wardId') wardId?: string, @Query('status') status?: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const filters = ['b.org_id=$1'];
    const params: unknown[] = [actor.org_id];
    if (wardId) { params.push(parse(uuid, wardId)); filters.push(`b.ward_id=$${params.length}`); }
    if (status) { params.push(status); filters.push(`b.status=$${params.length}`); }
    const rows = await this.db.query(
      `SELECT b.id,b.label,b.status,b.ward_id,w.code AS ward_code FROM hospital_beds b
       JOIN hospital_wards w ON w.id=b.ward_id AND w.org_id=b.org_id
       WHERE ${filters.join(' AND ')} ORDER BY w.code,b.label LIMIT 500`, params);
    return rows.rows;
  }

  @Post('admissions')
  async admitPatient(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const body = parse(admitSchema, raw);
    return this.db.tx(async c => {
      const active = await c.query('SELECT status FROM hospital_admissions WHERE patient_id=$1 AND org_id=$2 AND status=\'admitted\' LIMIT 1 FOR UPDATE', [body.patientId, actor.org_id]);
      admit(active.rowCount ? (active.rows[0].status as AdmissionStatus) : null);
      const bed = await c.query<any>('SELECT status FROM hospital_beds WHERE id=$1 AND org_id=$2 FOR UPDATE', [body.bedId, actor.org_id]);
      if (!bed.rowCount) throw new NotFoundException('Leito não encontrado');
      if (bed.rows[0].status !== 'available') throw new ConflictException('Leito não está disponível');
      const patient = await c.query('SELECT 1 FROM patients WHERE id=$1 AND org_id=$2', [body.patientId, actor.org_id]);
      if (!patient.rowCount) throw new NotFoundException('Paciente não encontrado');
      const row = await c.query<any>(
        'INSERT INTO hospital_admissions(org_id,patient_id,ward_id,bed_id) VALUES($1,$2,$3,$4) RETURNING id,status,admitted_at',
        [actor.org_id, body.patientId, body.wardId, body.bedId]);
      await c.query('UPDATE hospital_beds SET status=\'occupied\' WHERE id=$1 AND org_id=$2', [body.bedId, actor.org_id]);
      await audit(c, actor, 'hospital.admission.created', 'hospital_admission', row.rows[0].id);
      return row.rows[0];
    });
  }

  @Post('admissions/:admissionId/transfer')
  async transferPatient(@Req() req: ReqWithActor, @Param('admissionId') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const admissionId = parse(uuid, rawId);
    const body = parse(transferSchema, raw);
    return this.db.tx(async c => {
      const admission = await c.query<any>('SELECT status,bed_id FROM hospital_admissions WHERE id=$1 AND org_id=$2 FOR UPDATE', [admissionId, actor.org_id]);
      if (!admission.rowCount) throw new NotFoundException('Admissão não encontrada');
      transfer(admission.rows[0].status as AdmissionStatus);
      const bed = await c.query<any>('SELECT status FROM hospital_beds WHERE id=$1 AND org_id=$2 FOR UPDATE', [body.bedId, actor.org_id]);
      if (!bed.rowCount) throw new NotFoundException('Leito não encontrado');
      if (bed.rows[0].status !== 'available') throw new ConflictException('Leito de destino não está disponível');
      await c.query('UPDATE hospital_admissions SET ward_id=$3, bed_id=$4 WHERE id=$1 AND org_id=$2', [admissionId, actor.org_id, body.wardId, body.bedId]);
      await c.query('UPDATE hospital_beds SET status=\'available\' WHERE id=$1 AND org_id=$2', [admission.rows[0].bed_id, actor.org_id]);
      await c.query('UPDATE hospital_beds SET status=\'occupied\' WHERE id=$1 AND org_id=$2', [body.bedId, actor.org_id]);
      await audit(c, actor, 'hospital.admission.transferred', 'hospital_admission', admissionId);
      return { id: admissionId, status: 'admitted', bedId: body.bedId };
    });
  }

  @Post('admissions/:admissionId/discharge')
  async dischargePatient(@Req() req: ReqWithActor, @Param('admissionId') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const admissionId = parse(uuid, rawId);
    const body = parse(dischargeSchema, raw);
    return this.db.tx(async c => {
      const admission = await c.query<any>('SELECT status,bed_id FROM hospital_admissions WHERE id=$1 AND org_id=$2 FOR UPDATE', [admissionId, actor.org_id]);
      if (!admission.rowCount) throw new NotFoundException('Admissão não encontrada');
      discharge(admission.rows[0].status as AdmissionStatus);
      await c.query('UPDATE hospital_admissions SET status=\'discharged\', discharged_at=now(), discharge_disposition=$3 WHERE id=$1 AND org_id=$2', [admissionId, actor.org_id, body.disposition]);
      await c.query('UPDATE hospital_beds SET status=\'available\' WHERE id=$1 AND org_id=$2', [admission.rows[0].bed_id, actor.org_id]);
      await audit(c, actor, 'hospital.admission.discharged', 'hospital_admission', admissionId, { disposition: body.disposition });
      return { id: admissionId, status: 'discharged' };
    });
  }

  /**
   * Registro de administração de medicação pela enfermagem (checagem). Escrita
   * explicita do profissional — livro de registro, não automação de prescrição.
   * Integração honesta com prescrição: só aceita prescriptionId do MESMO org e
   * do paciente da admissão (match patient_id × hospital_admissions.patient_id).
   */
  @Post('admissions/:admissionId/administrations')
  async createAdministration(@Req() req: ReqWithActor, @Param('admissionId') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const admissionId = parse(uuid, rawId);
    const body = parse(administrationSchema, raw);
    const admission = await this.db.query('SELECT patient_id FROM hospital_admissions WHERE id=$1 AND org_id=$2', [admissionId, actor.org_id]);
    if (!admission.rowCount) throw new NotFoundException('Admissão não encontrada');
    if (body.prescriptionId) {
      const rx = await this.db.query(
        `SELECT 1 FROM prescriptions p
           JOIN hospital_admissions a ON a.patient_id = p.patient_id AND a.org_id = p.org_id
          WHERE p.id=$1 AND p.org_id=$2 AND a.id=$3`, [body.prescriptionId, actor.org_id, admissionId]);
      if (!rx.rowCount) throw new BadRequestException('Prescrição não pertence a este interno');
    }
    const administeredAt = body.administeredAt ? new Date(body.administeredAt) : new Date();
    // Checagem de duplicidade honesta (minuto): compara chave pura com o que já
    // existe no banco para esta admissão —409 evita duplo lançamento da dose.
    const dup = await this.db.query(
      `SELECT medication_name, administered_at FROM medication_administrations
        WHERE org_id=$1 AND admission_id=$2
          AND administered_at >= date_trunc('minute', $3::timestamptz)
          AND administered_at <  date_trunc('minute', $3::timestamptz) + interval '1 minute'
        LIMIT 50`, [actor.org_id, admissionId, administeredAt]);
    const key = administrationDuplicateKey({ admissionId, medicationName: body.medicationName, administeredAt });
    const duplicated = dup.rows.some((r: { medication_name: string; administered_at: Date }) =>
      administrationDuplicateKey({ admissionId, medicationName: r.medication_name, administeredAt: r.administered_at }) === key);
    if (duplicated) throw new ConflictException('Administração idêntica já registrada neste horário');
    const row = await this.db.query<any>(
      `INSERT INTO medication_administrations(org_id,admission_id,prescription_id,medication_name,dose,route,barcode,note,administered_by,administered_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id,prescription_id,medication_name,dose,route,barcode,administered_at`,
      [actor.org_id, admissionId, body.prescriptionId ?? null, body.medicationName, body.dose ?? null,
       body.route ?? null, body.barcode ?? null, body.note ?? null, actor.id, administeredAt]);
    // Audit só com METADADOS: alvo = admissão e presença de barcode. Nunca
    // medication_name/note (dado clínico do paciente) em audit_events.
    await audit(this.db, actor, 'hospital.medication.administered', 'hospital_admission', admissionId,
      { hasBarcode: !!body.barcode, linkedPrescription: !!body.prescriptionId });
    return row.rows[0];
  }

  /** Histórico de administrações do interno (prontuário autorizado — retorna note). */
  @Get('admissions/:admissionId/administrations')
  async listAdministrations(@Req() req: ReqWithActor, @Param('admissionId') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const admissionId = parse(uuid, rawId);
    const admission = await this.db.query('SELECT 1 FROM hospital_admissions WHERE id=$1 AND org_id=$2', [admissionId, actor.org_id]);
    if (!admission.rowCount) throw new NotFoundException('Admissão não encontrada');
    const rows = await this.db.query(
      `SELECT ma.id,ma.prescription_id,ma.medication_name,ma.dose,ma.route,ma.barcode,ma.note,
              ma.administered_at,ma.administered_by,u.display_name AS administered_by_name
         FROM medication_administrations ma
         LEFT JOIN users u ON u.id = ma.administered_by AND u.org_id = ma.org_id
        WHERE ma.org_id=$1 AND ma.admission_id=$2
        ORDER BY ma.administered_at DESC, ma.created_at DESC
        LIMIT 100`, [actor.org_id, admissionId]);
    await audit(this.db, actor, 'hospital.medication.listed', 'hospital_admission', admissionId, { count: rows.rows.length });
    return rows.rows;
  }

  @Post('antimicrobials')
  async antimicrobial(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    // Feature flag 344: off = 409 honesto + auditoria; nada é gravado.
    if (!antimicrobial344Enabled()) {
      await audit(this.db, actor, 'hospital.344.blocked', 'antimicrobial_344', null, { endpoint: 'POST /hospital/antimicrobials' });
      throw new ConflictException(ANTIMICROBIAL_344_OFF_REASON);
    }
    const body = parse(antimicrobialSchema, raw);
    const patient = await this.db.query('SELECT 1 FROM patients WHERE id=$1 AND org_id=$2', [body.patientId, actor.org_id]);
    if (!patient.rowCount) throw new NotFoundException('Paciente não encontrado');
    const row = await this.db.query<any>(
      'INSERT INTO antimicrobial_344(org_id,admission_id,patient_id,medication_name,tuss_code,justification,prescriber_id,culture_sent) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,status,created_at',
      [actor.org_id, body.admissionId ?? null, body.patientId, body.medicationName, body.tussCode ?? null, body.justification, actor.id, body.cultureSent]);
    await audit(this.db, actor, 'hospital.antimicrobial.started', 'antimicrobial_344', row.rows[0].id);
    return row.rows[0];
  }

  @Get('antimicrobials')
  async listAntimicrobials(@Req() req: ReqWithActor, @Query('admissionId') admissionId?: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    // Feature flag 344 off: NUNCA lista do banco como se o programa estivesse ativo.
    if (!antimicrobial344Enabled()) return { disabled: true, reason: ANTIMICROBIAL_344_OFF_REASON, items: [] };
    const filters = ['org_id=$1'];
    const params: unknown[] = [actor.org_id];
    if (admissionId) { params.push(parse(uuid, admissionId)); filters.push(`admission_id=$${params.length}`); }
    const rows = await this.db.query(
      `SELECT id,medication_name,tuss_code,justification,culture_sent,status,created_at
       FROM antimicrobial_344 WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params);
    return rows.rows;
  }

  @Post('antimicrobials/:id/suspend')
  async suspendAntimicrobial(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const id = parse(uuid, rawId);
    // Feature flag 344: off = 409 honesto + auditoria; nada é alterado.
    if (!antimicrobial344Enabled()) {
      await audit(this.db, actor, 'hospital.344.blocked', 'antimicrobial_344', id, { endpoint: 'POST /hospital/antimicrobials/:id/suspend' });
      throw new ConflictException(ANTIMICROBIAL_344_OFF_REASON);
    }
    const body = parse(suspendSchema, raw);
    const updated = await this.db.query(
      'UPDATE antimicrobial_344 SET status=\'suspended\', suspend_reason=$3 WHERE id=$1 AND org_id=$2 AND status=\'active\' RETURNING id',
      [id, actor.org_id, body.reason]);
    if (!updated.rowCount) throw new ConflictException('Antimicrobiano inexistente ou já inativo');
    await audit(this.db, actor, 'hospital.antimicrobial.suspended', 'antimicrobial_344', id);
    return { id, status: 'suspended' };
  }

  @Post('orders')
  async createOrder(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const body = parse(orderSchema, raw);
    const patient = await this.db.query('SELECT 1 FROM patients WHERE id=$1 AND org_id=$2', [body.patientId, actor.org_id]);
    if (!patient.rowCount) throw new NotFoundException('Paciente não encontrado');
    const row = await this.db.query<any>(
      'INSERT INTO diagnostic_orders(org_id,patient_id,requester_id,order_type,loinc_code,description,priority) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status,priority,ordered_at',
      [actor.org_id, body.patientId, actor.id, body.orderType, body.loincCode ?? null, body.description, body.priority]);
    await audit(this.db, actor, 'hospital.order.created', 'diagnostic_order', row.rows[0].id, { orderType: body.orderType });
    return row.rows[0];
  }

  /**
   * Transição do ciclo do pedido diagnóstico (ST-P1-005). ESTENDIDO sem quebrar
   * o smoke: ordered→in_progress com critical:true + ack continua funcionando.
   * Regras por etapa (validação PURA em orders.validateTransition): preliminary/
   * final exigem resultValue; final exige passar por preliminary; reviewed grava
   * reviewed_by/at; communicated exige communicatedTo E — para crítico — o
   * reconhecimento (critical-ack) prévio (J1 #12). Auditoria por transição +
   * 'result.communicated' extra; nenhum texto clínico livre nos details.
   */
  @Patch('orders/:id/status')
  async orderStatus(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const id = parse(uuid, rawId);
    const body = parse(orderStatusSchema, raw);
    return this.db.tx(async c => {
      const order = await c.query<any>(
        `SELECT status, critical, critical_ack_at, preliminary_at
           FROM diagnostic_orders WHERE id=$1 AND org_id=$2 FOR UPDATE`, [id, actor.org_id]);
      if (!order.rowCount) throw new NotFoundException('Pedido não encontrado');
      const current = order.rows[0];
      assertTransition(current.status as OrderStatus, body.status);
      // Efeitos desta MESMA transação nas regras de payload: marcar critical=true
      // zera o ack (comportamento legado preservado) — logo, comunicar um crítico
      // recém-marcado exige reconhecer ANTES (ou em chamada anterior).
      const effectiveCritical = body.critical === undefined ? current.critical === true : body.critical;
      const effectiveAckAt = body.critical === true ? null : current.critical_ack_at;
      const errors = validateTransition({
        from: current.status as OrderStatus, to: body.status,
        payload: { resultValue: body.resultValue, communicatedTo: body.communicatedTo },
        order: { critical: effectiveCritical, criticalAckAt: effectiveAckAt }
      });
      if (errors.length) throw new ConflictException(errors.join(' '));
      const updated = await c.query<any>(
        `UPDATE diagnostic_orders
            SET status=$3,
                result_summary=COALESCE($4,result_summary),
                pacs_url=COALESCE($5,pacs_url),
                critical=CASE WHEN $6::boolean IS NULL THEN critical ELSE $6 END,
                critical_ack_by=CASE WHEN $6::boolean IS NULL THEN critical_ack_by ELSE NULL END,
                critical_ack_at=CASE WHEN $6::boolean IS NULL THEN critical_ack_at ELSE NULL END,
                result_value=CASE WHEN $7::text IS NULL THEN result_value ELSE $7 END,
                result_reference=CASE WHEN $8::text IS NULL THEN result_reference ELSE $8 END,
                result_units=CASE WHEN $9::text IS NULL THEN result_units ELSE $9 END,
                preliminary_at=CASE WHEN $3='preliminary' THEN now() ELSE preliminary_at END,
                final_at=CASE WHEN $3='final' THEN now() ELSE final_at END,
                reviewed_by=CASE WHEN $3='reviewed' THEN $10::uuid ELSE reviewed_by END,
                reviewed_at=CASE WHEN $3='reviewed' THEN now() ELSE reviewed_at END,
                communicated_to=CASE WHEN $3='communicated' THEN $11 ELSE communicated_to END,
                communicated_at=CASE WHEN $3='communicated' THEN now() ELSE communicated_at END,
                updated_at=now()
          WHERE id=$1 AND org_id=$2
          RETURNING id,status,critical,critical_ack_at,result_value,result_reference,result_units,
                    preliminary_at,final_at,reviewed_by,reviewed_at,communicated_to,communicated_at,updated_at`,
        [id, actor.org_id, body.status, body.resultSummary ?? null, body.pacsUrl ?? null,
         body.critical ?? null, body.resultValue ?? null, body.resultReference ?? null,
         body.resultUnits ?? null, actor.id, body.communicatedTo ?? null]);
      // Auditoria por transição (metadados estruturados; requestId automático).
      await audit(c, actor, 'order.status.changed', 'diagnostic_order', id,
        body.critical === undefined ? { from: current.status, to: body.status }
          : { from: current.status, to: body.status, critical: body.critical });
      // Compat: o audit legado por status permanece para os E2E/smoke existentes.
      await audit(c, actor, 'hospital.order.' + body.status, 'diagnostic_order', id,
        body.critical === undefined ? { status: body.status } : { status: body.status, critical: body.critical });
      if (body.status === 'communicated')
        await audit(c, actor, 'result.communicated', 'diagnostic_order', id,
          { orderId: id, communicatedTo: body.communicatedTo });
      return updated.rows[0];
    });
  }

  /**
   * Confirmação de recebimento de resultado crítico (J1 #12). Notificação push não
   * conta: só o reconhecimento explícito de profissional habilitado encerra a
   * pendência, e ele fica em audit_events com actor e horário.
   */
  @Post('orders/:id/critical-ack')
  async acknowledgeCritical(@Req() req: ReqWithActor, @Param('id') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    const id = parse(uuid, rawId);
    return this.db.tx(async c => {
      const order = await c.query<any>(
        'SELECT critical, critical_ack_at FROM diagnostic_orders WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, actor.org_id]);
      if (!order.rowCount) throw new NotFoundException('Pedido não encontrado');
      if (!order.rows[0].critical) throw new ConflictException('Pedido não é um resultado crítico');
      if (order.rows[0].critical_ack_at) throw new ConflictException('Resultado crítico já reconhecido');
      const updated = await c.query<any>(
        `UPDATE diagnostic_orders SET critical_ack_by=$3, critical_ack_at=now(), updated_at=now()
          WHERE id=$1 AND org_id=$2 AND critical AND critical_ack_at IS NULL
          RETURNING id, critical_ack_at`,
        [id, actor.org_id, actor.id]);
      if (!updated.rowCount) throw new ConflictException('Resultado crítico já reconhecido');
      await audit(c, actor, 'hospital.order.critical.acknowledged', 'diagnostic_order', id);
      return updated.rows[0];
    });
  }

  /** Pendências de resultado crítico sem reconhecimento — tela de maior risco. */
  @Get('orders/critical/pending')
  async listCriticalPending(@Req() req: ReqWithActor) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const rows = await this.db.query(
      `SELECT id,order_type,loinc_code,description,status,priority,result_summary,critical_ack_at,ordered_at,updated_at
         FROM diagnostic_orders
        WHERE org_id=$1 AND critical AND critical_ack_at IS NULL AND status <> 'cancelled'
        ORDER BY updated_at DESC NULLS LAST LIMIT 200`, [actor.org_id]);
    return rows.rows;
  }

  /** Filtros: patientId/status (existentes) + critical/priority (ST-P1-005).
   *  Retorna as colunas do ciclo 023 (resultado estruturado + carimbos por etapa). */
  @Get('orders')
  async listOrders(@Req() req: ReqWithActor, @Query('patientId') patientId?: string, @Query('status') status?: string,
    @Query('critical') critical?: string, @Query('priority') priority?: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const filters = ['org_id=$1'];
    const params: unknown[] = [actor.org_id];
    if (patientId) { params.push(parse(uuid, patientId)); filters.push(`patient_id=$${params.length}`); }
    if (status) { params.push(status); filters.push(`status=$${params.length}`); }
    if (critical === 'true' || critical === 'false') { params.push(critical === 'true'); filters.push(`critical=$${params.length}`); }
    if (priority === 'routine' || priority === 'urgent') { params.push(priority); filters.push(`priority=$${params.length}`); }
    const rows = await this.db.query(
      `SELECT id,patient_id,order_type,loinc_code,description,status,priority,result_summary,pacs_url,
              critical,critical_ack_by,critical_ack_at,
              result_value,result_reference,result_units,
              preliminary_at,final_at,reviewed_by,reviewed_at,communicated_at,communicated_to,result_document_id,
              ordered_at,updated_at
       FROM diagnostic_orders WHERE ${filters.join(' AND ')} ORDER BY ordered_at DESC LIMIT 200`, params);
    return rows.rows;
  }

  @Get('metrics/beds')
  async bedMetrics(@Req() req: ReqWithActor) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const rows = await this.db.query<any>(
      'SELECT count(*) FILTER (WHERE status=\'occupied\') AS occupied, count(*) AS total FROM hospital_beds WHERE org_id=$1',
      [actor.org_id]);
    const total = Number(rows.rows[0].total);
    const occupied = Number(rows.rows[0].occupied);
    return { total, occupied, available: total - occupied, occupancyRate: occupancyRate(total, occupied) };
  }
}
