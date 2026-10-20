import { Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, requireRole } from './security';

/** Módulo hospitalar: leitos, admissões (ADT), antimicrobianos 344/ANVISA e pedidos LIS/PACS. */

type ReqWithActor = { actor: Actor };

const wardSchema = z.object({
  code: z.string().trim().min(2).max(30),
  name: z.string().trim().min(2).max(120),
  specialty: z.enum(['general', 'cardiology', 'orthopedics', 'pediatrics', 'neurology', 'psychiatry']).default('general')
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
const orderStatusSchema = z.object({
  status: z.enum(['in_progress', 'completed', 'cancelled']),
  resultSummary: z.string().trim().max(10000).optional(),
  pacsUrl: z.string().url().max(2000).optional(),
  // Resultado crítico (H-12 / J1 #12): ausente = não altera; true/false define o
  // flag e QUALQUER novo resultado zera o reconhecimento anterior (obrigatório
  // reconhecer de novo).
  critical: z.boolean().optional()
}).strict();

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

export type OrderStatus = 'ordered' | 'in_progress' | 'completed' | 'cancelled';
const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  ordered: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
};
export function orderTransition(current: OrderStatus, next: OrderStatus): void {
  if (!ORDER_TRANSITIONS[current].includes(next))
    throw new ConflictException(`Transição inválida: ${current} → ${next}`);
}

export function occupancyRate(total: number, occupied: number): number {
  if (total === 0) return 0;
  return Math.round((occupied / total) * 1000) / 1000;
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

  @Post('antimicrobials')
  async antimicrobial(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
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

  @Patch('orders/:id/status')
  async orderStatus(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const id = parse(uuid, rawId);
    const body = parse(orderStatusSchema, raw);
    return this.db.tx(async c => {
      const order = await c.query<any>('SELECT status FROM diagnostic_orders WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, actor.org_id]);
      if (!order.rowCount) throw new NotFoundException('Pedido não encontrado');
      orderTransition(order.rows[0].status as OrderStatus, body.status);
      const updated = await c.query<any>(
        `UPDATE diagnostic_orders
            SET status=$3,
                result_summary=COALESCE($4,result_summary),
                pacs_url=COALESCE($5,pacs_url),
                critical=CASE WHEN $6::boolean IS NULL THEN critical ELSE $6 END,
                critical_ack_by=CASE WHEN $6::boolean IS NULL THEN critical_ack_by ELSE NULL END,
                critical_ack_at=CASE WHEN $6::boolean IS NULL THEN critical_ack_at ELSE NULL END,
                updated_at=now()
          WHERE id=$1 AND org_id=$2
          RETURNING id,status,critical,critical_ack_at,updated_at`,
        [id, actor.org_id, body.status, body.resultSummary ?? null, body.pacsUrl ?? null, body.critical ?? null]);
      await audit(c, actor, 'hospital.order.' + body.status, 'diagnostic_order', id,
        body.critical === undefined ? { status: body.status } : { status: body.status, critical: body.critical });
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

  @Get('orders')
  async listOrders(@Req() req: ReqWithActor, @Query('patientId') patientId?: string, @Query('status') status?: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const filters = ['org_id=$1'];
    const params: unknown[] = [actor.org_id];
    if (patientId) { params.push(parse(uuid, patientId)); filters.push(`patient_id=$${params.length}`); }
    if (status) { params.push(status); filters.push(`status=$${params.length}`); }
    const rows = await this.db.query(
      `SELECT id,order_type,loinc_code,description,status,priority,result_summary,pacs_url,critical,critical_ack_at,ordered_at,updated_at
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
