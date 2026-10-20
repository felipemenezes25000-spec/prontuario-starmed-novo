import { Body, Controller, Get, NotFoundException, Post, Req, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { Db } from './db';
import { env } from './config';
import { parse, uuid } from './domain';
import { Actor, Public, audit, hashPassword, requestContext, requireRole, setOrgContext, sha256Hex, verifyPassword } from './security';

/**
 * Portal do paciente (LGPD: acesso mínimo necessário — cada conta vê apenas o
 * próprio cadastro e documentos assinados). Sessão própria do portal JWT com
 * claim purpose:'portal' (não abre sessão clínica — o JwtGuard rejeita purpose).
 * Integração CRM/WhatsApp nasce DESLIGADA: sem CRM_PROVIDER_URL os mensajes
 * ficam em crm_outbox 'queued' (worker futuro consome).
 */

type PortalSession = { accountId: string; orgId: string; patientId: string };

const inviteSchema = z.object({ patientId: uuid, ttlHours: z.number().int().min(1).max(72) }).strict();
const activateSchema = z.object({
  inviteCode: z.string().trim().min(16).max(64),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(256)
}).strict();
const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(256) }).strict();
const requestSchema = z.object({
  preferredSpecialty: z.enum(['general', 'cardiology', 'orthopedics', 'pediatrics', 'neurology', 'psychiatry']),
  preferredPeriod: z.enum(['morning', 'afternoon', 'any']),
  notes: z.string().trim().max(1000).optional()
}).strict();
const notifySchema = z.object({
  channel: z.enum(['whatsapp', 'email', 'sms']),
  patientId: uuid,
  template: z.enum(['appointment_reminder', 'result_ready']),
  vars: z.record(z.string().max(500))
}).strict();

const TEMPLATES: Record<string, { subject: string; body: string; requiredVars: string[] }> = {
  appointment_reminder: {
    subject: 'Lembrete de consulta — {clinicName}',
    body: 'Olá {patientName}, sua consulta é em {date} às {time}. Responda CANCELAR se não puder comparecer.',
    requiredVars: ['patientName', 'date', 'time', 'clinicName']
  },
  result_ready: {
    subject: 'Resultado disponível — {clinicName}',
    body: 'Olá {patientName}, o resultado de {examName} já está disponível no portal.',
    requiredVars: ['patientName', 'examName', 'clinicName']
  }
};

export function renderTemplate(name: string, vars: Record<string, string>): { subject: string; body: string } {
  const template = TEMPLATES[name];
  if (!template) throw new Error(`Template desconhecido: ${name}`);
  for (const key of template.requiredVars)
    if (!vars[key]) throw new Error(`Template ${name} exige a variável ${key}`);
  const fill = (text: string) => text.replace(/\{(\w+)\}/g, (_m, key: string) => vars[key] ?? '');
  return { subject: fill(template.subject), body: fill(template.body) };
}

export function normalizeInvite(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateInviteCode(): string {
  let out = '';
  for (let i = 0; i < 20; i++) out += INVITE_ALPHABET[randomBytes(1)[0] % INVITE_ALPHABET.length];
  return out;
}

/** Convite single-use/expirado (puro, testável). */
export function inviteUsable(row: { code_hash: string; expires_at: Date; used_at: Date | null }, code: string, now: Date): boolean {
  if (row.used_at) return false;
  if (now.getTime() > new Date(row.expires_at).getTime()) return false;
  return row.code_hash === sha256Hex(normalizeInvite(code));
}

export async function issuePortalToken(session: PortalSession): Promise<string> {
  return new SignJWT({ purpose: 'portal', org: session.orgId, patient: session.patientId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(session.accountId)
    .setIssuer(env('AUTH_ISSUER')).setAudience(env('AUTH_AUDIENCE'))
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(env('AUTH_SECRET')));
}

export async function verifyPortalToken(token: string): Promise<PortalSession> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env('AUTH_SECRET')), {
      issuer: env('AUTH_ISSUER'), audience: env('AUTH_AUDIENCE'), algorithms: ['HS256']
    });
    if (payload.purpose !== 'portal' || !payload.sub || typeof payload.org !== 'string' || typeof payload.patient !== 'string')
      throw new Error('invalid');
    // Sessão do portal resolve o tenant a partir do TOKEN: publica o contexto
    // para que todas as queries RLS desta requisição rorem com a org certa.
    setOrgContext(payload.org);
    return { accountId: payload.sub, orgId: payload.org, patientId: payload.patient };
  } catch {
    throw new UnauthorizedException('Sessão do portal inválida ou expirada');
  }
}

type ReqWithPortal = { headers: { authorization?: string } };
async function portalSession(req: ReqWithPortal): Promise<PortalSession> {
  const value = req.headers?.authorization;
  if (!value || !/^Bearer\s+\S+$/i.test(value)) throw new UnauthorizedException();
  return verifyPortalToken(value.replace(/^Bearer\s+/i, ''));
}

@Controller('portal')
export class StaffPortalController {
  constructor(private db: Db) {}

  @Post('invites')
  async invite(@Req() req: { actor: Actor }, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const body = parse(inviteSchema, raw);
    const patient = await this.db.query('SELECT id FROM patients WHERE id=$1 AND org_id=$2', [body.patientId, actor.org_id]);
    if (!patient.rowCount) throw new NotFoundException('Paciente não encontrado');
    const code = generateInviteCode();
    const invite = await this.db.query<any>(
      'INSERT INTO portal_invites(org_id,patient_id,code_hash,expires_at,created_by) VALUES($1,$2,$3,now()+($4 || \' hours\')::interval,$5) RETURNING id,expires_at',
      [actor.org_id, body.patientId, sha256Hex(normalizeInvite(code)), String(body.ttlHours), actor.id]);
    await audit(this.db, actor, 'portal.invite.created', 'patient', body.patientId);
    return { inviteId: invite.rows[0].id, inviteCode: code, expiresAt: invite.rows[0].expires_at };
  }

  @Public()
  @Post('activate')
  async activate(@Body() raw: unknown) {
    const body = parse(activateSchema, raw);
    const codeHash = sha256Hex(normalizeInvite(body.inviteCode));
    const account = await this.db.tx(async c => {
      const invite = await c.query<any>(
        'UPDATE portal_invites SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING org_id,patient_id',
        [codeHash]);
      if (!invite.rowCount) throw new UnauthorizedException('Convite inválido ou expirado');
      const { org_id, patient_id } = invite.rows[0];
      // O convite (segredo) resolve o ANTES do contexto de tenant: publica o
      // contexto no store E na transação aberta para as escritas seguintes.
      setOrgContext(org_id);
      await c.query(`SELECT set_config('starmed.org_id',$1,true)`, [org_id]);
      const existing = await c.query('SELECT 1 FROM portal_accounts WHERE org_id=$1 AND lower(email)=lower($2)', [org_id, body.email]);
      if (existing.rowCount) throw new UnauthorizedException('Convite inválido ou expirado'); // sem oracle de e-mail
      const created = await c.query<any>(
        'INSERT INTO portal_accounts(org_id,patient_id,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
        [org_id, patient_id, body.email, await hashPassword(body.password)]);
      await c.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',
        [org_id, null, 'portal.account.created', 'patient', patient_id, JSON.stringify({requestId:requestContext.getStore()?.requestId??null})]);
      return { accountId: created.rows[0].id, orgId: org_id, patientId: patient_id };
    });
    return { activated: true, accessToken: await issuePortalToken(account) };
  }

  @Public()
  @Post('login')
  async login(@Body() raw: unknown) {
    const body = parse(loginSchema, raw);
    // E-mail é identificador do portal (único por org; colisão entre orgs usa a conta mais antiga).
    const res = await this.db.query<any>(
      'SELECT * FROM portal_accounts WHERE lower(email)=lower($1) AND active=true ORDER BY created_at LIMIT 1',
      [body.email]);
    const account = res.rows[0];
    const valid = account && await verifyPassword(body.password, account.password_hash);
    if (!valid) throw new UnauthorizedException('Credenciais inválidas');
    return {
      accessToken: await issuePortalToken({ accountId: account.id, orgId: account.org_id, patientId: account.patient_id }),
      patient: { id: account.patient_id }
    };
  }

  @Post('notifications/send')
  async notify(@Req() req: { actor: Actor }, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const body = parse(notifySchema, raw);
    const patient = await this.db.query<any>('SELECT full_name,phone FROM patients WHERE id=$1 AND org_id=$2', [body.patientId, actor.org_id]);
    if (!patient.rowCount) throw new NotFoundException('Paciente não encontrado');
    const rendered = renderTemplate(body.template, { ...body.vars, patientName: patient.rows[0].full_name });
    const recipient = body.channel === 'email' ? (body.vars.email ?? '') : (patient.rows[0].phone ?? '');
    if (!recipient) throw new UnauthorizedException('Destinatário ausente para o canal escolhido');
    const queued = await this.db.query<any>(
      'INSERT INTO crm_outbox(org_id,channel,recipient,template,rendered) VALUES($1,$2,$3,$4,$5) RETURNING id,status',
      [actor.org_id, body.channel, recipient, body.template, JSON.stringify(rendered)]);
    await audit(this.db, actor, 'portal.notification.queued', 'patient', body.patientId, { channel: body.channel, template: body.template });
    return { id: queued.rows[0].id, status: queued.rows[0].status, provider: process.env.CRM_PROVIDER_URL ? 'configured' : 'desligado' };
  }
}

@Controller('portal/me')
export class PatientPortalController {
  constructor(private db: Db) {}

  @Public()
  @Get('appointments')
  async appointments(@Req() req: ReqWithPortal) {
    const session = await portalSession(req);
    const rows = await this.db.query(
      `SELECT a.id, a.scheduled_at, a.duration_minutes, a.status, a.kind, u.display_name AS practitioner
       FROM appointments a JOIN users u ON u.id = a.practitioner_id
       WHERE a.org_id=$1 AND a.patient_id=$2 ORDER BY a.scheduled_at DESC LIMIT 100`,
      [session.orgId, session.patientId]);
    return rows.rows;
  }

  @Public()
  @Get('documents')
  async documents(@Req() req: ReqWithPortal) {
    const session = await portalSession(req);
    const rows = await this.db.query(
      `SELECT n.id, n.template_id, n.signed_at, n.version
       FROM encounters e JOIN clinical_notes n ON n.encounter_id = e.id AND n.org_id = e.org_id
       WHERE e.org_id=$1 AND e.patient_id=$2 AND n.status='signed' ORDER BY n.signed_at DESC LIMIT 100`,
      [session.orgId, session.patientId]);
    await this.db.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',
      [session.orgId, null, 'portal.documents.read', 'patient', session.patientId, JSON.stringify({requestId:requestContext.getStore()?.requestId??null})]);
    return rows.rows;
  }

  @Public()
  @Post('appointment-requests')
  async requestAppointment(@Req() req: ReqWithPortal, @Body() raw: unknown) {
    const session = await portalSession(req);
    const body = parse(requestSchema, raw);
    const created = await this.db.tx(async c => {
      const row = await c.query<any>(
        'INSERT INTO appointment_requests(org_id,patient_id,preferred_specialty,preferred_period,notes) VALUES($1,$2,$3,$4,$5) RETURNING id,status,created_at',
        [session.orgId, session.patientId, body.preferredSpecialty, body.preferredPeriod, body.notes ?? null]);
      // CRM nasce desligado: fica na fila para o worker futuro.
      await c.query(
        'INSERT INTO crm_outbox(org_id,channel,recipient,template,rendered) VALUES($1,$2,$3,$4,$5)',
        [session.orgId, 'whatsapp', '', 'appointment_request_received',
          JSON.stringify({ specialty: body.preferredSpecialty, period: body.preferredPeriod })]);
      return row.rows[0];
    });
    await this.db.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',
      [session.orgId, null, 'portal.appointment_request.created', 'patient', session.patientId, JSON.stringify({requestId:requestContext.getStore()?.requestId??null})]);
    return created;
  }
}
