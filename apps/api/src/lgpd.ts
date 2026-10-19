import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, requireRole } from './security';
import { verifyPortalToken } from './portal';
import { Public } from './security';

/**
 * LGPD/ANPD — direitos do titular (art. 18): acesso/portabilidade (exportação),
 * correção, exclusão/anonimização (art. 16/I: dado clínico com obrigação legal
 * NÃO é excluído — é recusado com motivo registrado) e revogação de consentimento
 * (opt-in versionado, append-only). Cada atendimento gera trilha auditável.
 */

type ReqWithActor = { actor: Actor };

const requestSchema = z.object({
  patientId: uuid,
  kind: z.enum(['access', 'portability', 'correction', 'deletion', 'anonymization', 'consent_revocation']),
  channel: z.enum(['portal', 'in_person', 'phone', 'email']).default('in_person'),
  deadlineDays: z.number().int().min(1).max(15).default(15)
}).strict();
const completeSchema = z.object({
  correction: z.record(z.string().max(2000)).optional(),
  refusalJustification: z.string().trim().min(10).max(2000).optional()
}).strict();
const refuseSchema = z.object({ reason: z.string().trim().min(10).max(2000) }).strict();
const consentSchema = z.object({
  patientId: uuid,
  purpose: z.enum(['treatment', 'research', 'marketing', 'ai_training', 'third_party_sharing']),
  granted: z.boolean()
}).strict();

export type ExportPackage = {
  generatedAt: string;
  patient: Record<string, unknown>;
  allergies: unknown[];
  conditions: unknown[];
  consents: unknown[];
  auditTrail: unknown[];
  notice: string;
};

/** Pacote de exportação/portabilidade (puro, testável). */
export function buildExportPackage(input: {
  patient: Record<string, unknown>;
  allergies: unknown[];
  conditions: unknown[];
  consents: unknown[];
  auditTrail: unknown[];
}): ExportPackage {
  return {
    generatedAt: new Date().toISOString(),
    patient: input.patient,
    allergies: input.allergies,
    conditions: input.conditions,
    consents: input.consents,
    auditTrail: input.auditTrail,
    notice: 'Dados exportados a pedido do titular (LGPD art. 18, V/VI). Identificadores clínicos preservados para continuidade do cuidado.'
  };
}

/** Campos anonimizados na base (mínimo para estatística sem reidentificação). */
export function anonymizationPatch(): Record<string, string | null> {
  return { full_name: '[ANONIMIZADO]', phone: null, insurance_id: null, social_determinants: '{}' };
}

/**
 * Exclusão só de dados não amarrados a obrigação legal (LGPD art. 16/I).
 * Prontuário assinado é obrigação legal do sistema de saúde → recusa.
 */
export function deletionVerdict(hasSignedNotes: boolean): { allowed: boolean; reason?: string } {
  return hasSignedNotes
    ? { allowed: false, reason: 'Prontuário com documentos assinados possui obrigação legal de guarda (LGPD art. 16/I; CFM 2.314/2022); solicitação recusada com trilha auditada.' }
    : { allowed: true };
}

@Controller('lgpd')
export class LgpdController {
  constructor(private db: Db) {}

  @Post('requests')
  async createRequest(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const body = parse(requestSchema, raw);
    const patient = await this.db.query('SELECT 1 FROM patients WHERE id=$1 AND org_id=$2', [body.patientId, actor.org_id]);
    if (!patient.rowCount) throw new NotFoundException('Paciente não encontrado');
    const row = await this.db.query<any>(
      'INSERT INTO lgpd_requests(org_id,patient_id,kind,deadline_days,requested_channel) VALUES($1,$2,$3,$4,$5) RETURNING id,kind,status,due_at,created_at',
      [actor.org_id, body.patientId, body.kind, body.deadlineDays, body.channel]);
    await audit(this.db, actor, 'lgpd.request.created', 'patient', body.patientId, { kind: body.kind });
    return row.rows[0];
  }

  @Get('requests')
  async listRequests(@Req() req: ReqWithActor, @Query('status') status?: string, @Query('patientId') patientId?: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const filters = ['org_id=$1'];
    const params: unknown[] = [actor.org_id];
    if (status) { params.push(status); filters.push(`status=$${params.length}`); }
    if (patientId) { params.push(parse(uuid, patientId)); filters.push(`patient_id=$${params.length}`); }
    const rows = await this.db.query(
      `SELECT id,patient_id,kind,status,due_at,fulfilled_at,refused_reason,requested_channel,created_at
       FROM lgpd_requests WHERE ${filters.join(' AND ')} ORDER BY due_at ASC LIMIT 200`, params);
    return rows.rows;
  }

  @Post('requests/:id/complete')
  async completeRequest(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin']);
    const id = parse(uuid, rawId);
    const body = parse(completeSchema, raw);
    const request = await this.db.query<any>('SELECT * FROM lgpd_requests WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, actor.org_id]);
    if (!request.rowCount) throw new NotFoundException('Pedido não encontrado');
    const row = request.rows[0];
    if (row.status !== 'requested' && row.status !== 'in_progress') throw new ConflictException('Pedido já finalizado');

    if (row.kind === 'access' || row.kind === 'portability') {
      const patient = await this.db.query('SELECT * FROM patients WHERE id=$1 AND org_id=$2', [row.patient_id, actor.org_id]);
      const allergies = await this.db.query('SELECT * FROM patient_allergies WHERE org_id=$1 AND patient_id=$2', [actor.org_id, row.patient_id]);
      const conditions = await this.db.query('SELECT * FROM patient_conditions WHERE org_id=$1 AND patient_id=$2', [actor.org_id, row.patient_id]);
      const consents = await this.db.query('SELECT * FROM lgpd_consents WHERE org_id=$1 AND patient_id=$2 ORDER BY created_at DESC', [actor.org_id, row.patient_id]);
      const trail = await this.db.query(
        "SELECT action,target_type,target_id,occurred_at FROM audit_events WHERE org_id=$1 AND (target_id=$2 OR (actor_id IS NULL AND target_id=$2)) ORDER BY occurred_at DESC LIMIT 500",
        [actor.org_id, row.patient_id]);
      const pack = buildExportPackage({ patient: patient.rows[0], allergies: allergies.rows, conditions: conditions.rows, consents: consents.rows, auditTrail: trail.rows });
      await this.db.query('UPDATE lgpd_requests SET status=\'completed\', fulfilled_at=now() WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
      await audit(this.db, actor, 'lgpd.request.fulfilled.export', 'patient', row.patient_id, { kind: row.kind });
      return { id, status: 'completed', package: pack };
    }

    if (row.kind === 'deletion' || row.kind === 'anonymization') {
      const signed = await this.db.query(
        'SELECT 1 FROM encounters e JOIN clinical_notes n ON n.encounter_id=e.id AND n.org_id=e.org_id WHERE e.org_id=$1 AND e.patient_id=$2 AND n.status=\'signed\' LIMIT 1',
        [actor.org_id, row.patient_id]);
      const verdict = deletionVerdict(Boolean(signed.rowCount));
      if (!verdict.allowed) {
        await this.db.query('UPDATE lgpd_requests SET status=\'refused\', refused_reason=$3 WHERE id=$1 AND org_id=$2', [id, actor.org_id, verdict.reason]);
        await audit(this.db, actor, 'lgpd.request.refused', 'patient', row.patient_id, { kind: row.kind, reason: 'obrigação legal' });
        return { id, status: 'refused', reason: verdict.reason };
      }
      const patch = anonymizationPatch();
      await this.db.query(
        'UPDATE patients SET full_name=$3, phone=$4, insurance_id=$5, social_determinants=$6, updated_at=now() WHERE id=$1 AND org_id=$2',
        [row.patient_id, actor.org_id, patch.full_name, patch.phone, patch.insurance_id, patch.social_determinants]);
      await this.db.query('UPDATE lgpd_requests SET status=\'completed\', fulfilled_at=now() WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
      await audit(this.db, actor, 'lgpd.request.fulfilled.anonymized', 'patient', row.patient_id, { kind: row.kind });
      return { id, status: 'completed', applied: 'anonymization' };
    }

    if (row.kind === 'correction') {
      if (!body.correction || Object.keys(body.correction).length === 0)
        throw new ForbiddenException('Correção exige o objeto correction');
      const allowedKeys = new Set(['full_name', 'phone', 'administrative_gender']);
      for (const key of Object.keys(body.correction))
        if (!allowedKeys.has(key)) throw new ForbiddenException(`Campo não corrigível pelo portal: ${key}`);
      await this.db.query(
        `UPDATE patients SET full_name=COALESCE($3,full_name), phone=COALESCE($4,phone), administrative_gender=COALESCE($5,administrative_gender), updated_at=now() WHERE id=$1 AND org_id=$2`,
        [row.patient_id, actor.org_id, body.correction.full_name ?? null, body.correction.phone ?? null, body.correction.administrative_gender ?? null]);
      await this.db.query('UPDATE lgpd_requests SET status=\'completed\', fulfilled_at=now() WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
      await audit(this.db, actor, 'lgpd.request.fulfilled.correction', 'patient', row.patient_id, { fields: Object.keys(body.correction) });
      return { id, status: 'completed', applied: 'correction' };
    }

    // consent_revocation: revoga todos os consentimentos ativos (opt-in → opt-out registrado).
    await this.db.tx(async c => {
      await c.query(
        'INSERT INTO lgpd_consents(org_id,patient_id,purpose,granted,recorded_by,source) SELECT org_id,patient_id,purpose,FALSE,$3,\'staff\' FROM lgpd_consents WHERE org_id=$1 AND patient_id=$2 AND granted=TRUE GROUP BY org_id,patient_id,purpose',
        [actor.org_id, row.patient_id, actor.id]);
      await c.query('UPDATE lgpd_requests SET status=\'completed\', fulfilled_at=now() WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
    });
    await audit(this.db, actor, 'lgpd.request.fulfilled.consent_revoked', 'patient', row.patient_id);
    return { id, status: 'completed', applied: 'consent_revocation' };
  }

  @Post('requests/:id/refuse')
  async refuseRequest(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin']);
    const id = parse(uuid, rawId);
    const body = parse(refuseSchema, raw);
    const updated = await this.db.query(
      'UPDATE lgpd_requests SET status=\'refused\', refused_reason=$3 WHERE id=$1 AND org_id=$2 AND status IN (\'requested\',\'in_progress\') RETURNING id,status',
      [id, actor.org_id, body.reason]);
    if (!updated.rowCount) throw new ConflictException('Pedido inexistente ou já finalizado');
    await audit(this.db, actor, 'lgpd.request.refused', 'lgpd_request', id, { reason: body.reason });
    return updated.rows[0];
  }

  @Post('consents')
  async recordConsent(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const body = parse(consentSchema, raw);
    const row = await this.db.query<any>(
      'INSERT INTO lgpd_consents(org_id,patient_id,purpose,granted,recorded_by,source) VALUES($1,$2,$3,$4,$5,\'staff\') RETURNING id,purpose,granted,created_at',
      [actor.org_id, body.patientId, body.purpose, body.granted, actor.id]);
    await audit(this.db, actor, 'lgpd.consent.recorded', 'patient', body.patientId, { purpose: body.purpose, granted: body.granted });
    return row.rows[0];
  }

  @Get('consents/:patientId')
  async listConsents(@Req() req: ReqWithActor, @Param('patientId') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const patientId = parse(uuid, rawId);
    const rows = await this.db.query(
      `SELECT DISTINCT ON (purpose) purpose, granted, source, created_at
       FROM lgpd_consents WHERE org_id=$1 AND patient_id=$2 ORDER BY purpose, created_at DESC`,
      [actor.org_id, patientId]);
    return rows.rows;
  }
}

@Controller('portal/me')
export class PatientLgpdController {
  constructor(private db: Db) {}

  @Public()
  @Post('lgpd/requests')
  async selfRequest(@Req() req: { headers: { authorization?: string } }, @Body() raw: unknown) {
    const session = await this.portalSession(req);
    const body = parse(requestSchema.omit({ patientId: true }), raw);
    const row = await this.db.query<any>(
      'INSERT INTO lgpd_requests(org_id,patient_id,kind,deadline_days,requested_channel) VALUES($1,$2,$3,$4,$5) RETURNING id,kind,status,due_at',
      [session.orgId, session.patientId, body.kind, body.deadlineDays, body.channel]);
    await this.db.query('INSERT INTO audit_events(org_id,action,target_type,target_id) VALUES($1,$2,$3,$4)',
      [session.orgId, 'lgpd.request.created.portal', 'patient', session.patientId]);
    return row.rows[0];
  }

  @Public()
  @Post('consents')
  async selfConsent(@Req() req: { headers: { authorization?: string } }, @Body() raw: unknown) {
    const session = await this.portalSession(req);
    const body = parse(consentSchema.omit({ patientId: true }), raw);
    const row = await this.db.query<any>(
      'INSERT INTO lgpd_consents(org_id,patient_id,purpose,granted,source) VALUES($1,$2,$3,$4,\'portal\') RETURNING id,purpose,granted,created_at',
      [session.orgId, session.patientId, body.purpose, body.granted]);
    await this.db.query('INSERT INTO audit_events(org_id,action,target_type,target_id) VALUES($1,$2,$3,$4)',
      [session.orgId, 'lgpd.consent.recorded.portal', 'patient', session.patientId]);
    return row.rows[0];
  }

  @Public()
  @Get('consents')
  async selfListConsents(@Req() req: { headers: { authorization?: string } }) {
    const session = await this.portalSession(req);
    const rows = await this.db.query(
      `SELECT DISTINCT ON (purpose) purpose, granted, created_at
       FROM lgpd_consents WHERE org_id=$1 AND patient_id=$2 ORDER BY purpose, created_at DESC`,
      [session.orgId, session.patientId]);
    return rows.rows;
  }

  private async portalSession(req: { headers: { authorization?: string } }) {
    const value = req.headers?.authorization;
    if (!value || !/^Bearer\s+\S+$/i.test(value)) throw new UnauthorizedException('Sessão do portal inválida');
    try { return await verifyPortalToken(value.replace(/^Bearer\s+/i, '')); }
    catch { throw new UnauthorizedException('Sessão do portal inválida'); }
  }
}
