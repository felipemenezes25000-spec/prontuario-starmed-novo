import { BadRequestException, Body, ConflictException, Controller, Get, HttpException, InternalServerErrorException, NotFoundException, Param, Post, Put, Req, Res, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
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
  preferredSpecialty: z.enum(['general', 'cardiology', 'orthopedics', 'pediatrics', 'neurology', 'psychiatry', 'gynecology']),
  preferredPeriod: z.enum(['morning', 'afternoon', 'any']),
  notes: z.string().trim().max(1000).optional()
}).strict();
const notifySchema = z.object({
  channel: z.enum(['whatsapp', 'email', 'sms']),
  patientId: uuid,
  template: z.enum(['appointment_reminder', 'result_ready']),
  vars: z.record(z.string().max(500))
}).strict();
// PATCH de preferências do titular: .strict() (chave desconhecida → 400),
// booleanos só, e PELO MENOS UM campo — opt-out (false) é sempre aceito.
const notificationsPatchSchema = z.object({
  whatsapp: z.boolean().optional(),
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  marketingOptIn: z.boolean().optional()
}).strict().refine(patch => Object.values(patch).some(v => v !== undefined), {
  message: 'Informe ao menos uma preferência de notificação (whatsapp, email, sms ou marketingOptIn)'
});

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

/* ---------------------------------------------------------------------------
 * Preferências de notificação por canal (migração 024 — JSONB em
 * portal_accounts.notification_prefs): canais de SERVIÇO ligados por padrão
 * (opt-out simples, LGPD) e marketing OPT-IN explícito (default false).
 * Funções PURAS, testadas em portal-prefs.test.ts sem tocar banco.
 * ------------------------------------------------------------------------- */
export type NotificationPrefs = { whatsapp: boolean; email: boolean; sms: boolean; marketing_opt_in: boolean };
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { whatsapp: true, email: true, sms: true, marketing_opt_in: false };

/** JSONB stored → contrato completo: chave ausente/inválida/nula cai no default da 024. */
export function normalizeNotificationPrefs(raw: unknown): NotificationPrefs {
  const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const out: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
  for (const key of ['whatsapp', 'email', 'sms', 'marketing_opt_in'] as const)
    if (typeof source[key] === 'boolean') out[key] = source[key] as boolean;
  return out;
}

/**
 * Merge PURO das preferências: valida tipos, normaliza marketingOptIn →
 * marketing_opt_in, preserva o RESTO (chaves extras já persistidas sobrevivem)
 * e LANÇA em patch inválido — o controller converte o erro em 400.
 * Qualquer canal true→false é SEMPRE aceito: opt-out obrigatório funciona.
 */
export function mergeNotificationPrefs(
  atual: unknown,
  patch: { whatsapp?: unknown; email?: unknown; sms?: unknown; marketingOptIn?: unknown }
): NotificationPrefs {
  const merged = normalizeNotificationPrefs(atual);
  if (atual && typeof atual === 'object' && !Array.isArray(atual))
    for (const [key, value] of Object.entries(atual as Record<string, unknown>))
      if (!(key in DEFAULT_NOTIFICATION_PREFS)) (merged as Record<string, unknown>)[key] = value;
  let applied = 0;
  for (const [rawKey, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue; // campo opcional ausente não conta
    const key = rawKey === 'marketingOptIn' ? 'marketing_opt_in' : rawKey;
    if (!(key in DEFAULT_NOTIFICATION_PREFS)) throw new Error(`Preferência de notificação desconhecida: ${rawKey}`);
    if (typeof value !== 'boolean') throw new Error(`Preferência ${rawKey} deve ser verdadeira ou falsa`);
    (merged as Record<string, unknown>)[key] = value;
    applied++;
  }
  if (!applied) throw new Error('Informe ao menos uma preferência de notificação');
  return merged;
}

/** Canal de SERVIÇO liberado para envio? prefs ausentes/inválidas → default da 024 (ligado). */
export function canNotify(rawPrefs: unknown, channel: 'whatsapp' | 'email' | 'sms'): boolean {
  return normalizeNotificationPrefs(rawPrefs)[channel];
}

/** Resposta da API em camelCase (marketingOptIn), sem vazar o shape interno do JSONB. */
export function toNotificationPrefsResponse(prefs: NotificationPrefs): { whatsapp: boolean; email: boolean; sms: boolean; marketingOptIn: boolean } {
  return { whatsapp: prefs.whatsapp, email: prefs.email, sms: prefs.sms, marketingOptIn: prefs.marketing_opt_in };
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
    // OPT-OUT OBRIGATÓRIO (migração 024): antes de enfileirar, lê as prefs da
    // conta portal do paciente — canal com false → 409, nada entra na fila.
    // Sem conta portal ainda, valem os defaults da 024 (serviço ligado).
    const prefsRow = await this.db.query<any>(
      'SELECT notification_prefs FROM portal_accounts WHERE org_id=$1 AND patient_id=$2 LIMIT 1',
      [actor.org_id, body.patientId]);
    const storedPrefs = prefsRow.rowCount ? prefsRow.rows[0].notification_prefs : null;
    if (!canNotify(storedPrefs, body.channel))
      throw new ConflictException('Paciente optou por não receber mensagens neste canal (opt-out)');
    // marketing_opt_in (default false) não é coberto aqui: só existem templates
    // de SERVIÇO hoje (appointment_reminder/result_ready). A preferência já é
    // editável pelo portal agora e bloqueará templates futuros de marketing
    // assim que forem adicionados ao TEMPLATES.
    const rendered = renderTemplate(body.template, { ...body.vars, patientName: patient.rows[0].full_name });
    const recipient = body.channel === 'email' ? (body.vars.email ?? '') : (patient.rows[0].phone ?? '');
    if (!recipient) throw new UnauthorizedException('Destinatário ausente para o canal escolhido');
    // patient_id (migração 024): vincula a fila ao PACIENTE para o histórico de
    // comprovação do portal (recipient por telefone/e-mail não é identidade).
    const queued = await this.db.query<any>(
      'INSERT INTO crm_outbox(org_id,channel,recipient,template,rendered,patient_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status',
      [actor.org_id, body.channel, recipient, body.template, JSON.stringify(rendered), body.patientId]);
    await audit(this.db, actor, 'portal.notification.queued', 'patient', body.patientId, { channel: body.channel, template: body.template });
    return { id: queued.rows[0].id, status: queued.rows[0].status, provider: process.env.CRM_PROVIDER_URL ? 'configured' : 'desligado' };
  }
}

/** Resposta manual (com @Res o Nest não serializa): mesmo formato de prescriptions. */
type PortalHttpResponse = { setHeader(name: string, value: string | number): unknown; end(chunk?: unknown): unknown };

/** Item da lista evoluída de documentos (notas assinadas + PDFs do paciente). */
type PortalDocumentItem = {
  id: string; kind: 'note' | 'pdf'; title: string;
  signedAt?: Date | null; createdAt?: Date | null;
  version?: number; sha256?: string; docType?: string;
};

const PDF_TITLES: Record<string, string> = { prescription: 'Prescrição', exam_result: 'Resultado de exame' };
const TECHNICAL_ID = /^[0-9a-f-]{8,}$/i;
/** template_id pode ser identificador técnico: texto ilegível vira rótulo honesto. */
function noteTitle(templateId: string | null): string {
  if (!templateId || TECHNICAL_ID.test(templateId)) return 'Documento assinado';
  return templateId;
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

  /** Trilha auditada do portal (sem ator de equipe: sessão do próprio titular). */
  private async auditPortal(action: string, session: PortalSession, details: Record<string, unknown> = {}) {
    await this.db.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',
      [session.orgId, null, action, 'patient', session.patientId,
       JSON.stringify({requestId: requestContext.getStore()?.requestId ?? null, ...details})]);
  }

  /**
   * Perfil mínimo do titular (LGPD: acesso necessário e suficiente): apenas os
   * campos do PACIENTE DO TOKEN — nunca senha, nunca dados de outra conta
   * (id/org saem do próprio JWT purpose:'portal').
   */
  @Public()
  @Get('profile')
  async profile(@Req() req: ReqWithPortal) {
    const session = await portalSession(req);
    const rows = await this.db.query<any>(
      `SELECT id, full_name, birth_date, administrative_gender, phone, insurance_id
       FROM patients WHERE id=$1 AND org_id=$2`,
      [session.patientId, session.orgId]);
    if (!rows.rowCount) throw new NotFoundException('Cadastro do paciente não encontrado');
    await this.auditPortal('portal.profile.read', session);
    const p = rows.rows[0];
    return {
      id: p.id, fullName: p.full_name, birthDate: p.birth_date,
      administrativeGender: p.administrative_gender, phone: p.phone, insuranceId: p.insurance_id
    };
  }

  /**
   * Lista EVOLUÍDA de documentos: (i) notas clínicas assinadas e (ii) PDFs de
   * clinical_documents do próprio paciente (doc_type prescription/exam_result),
   * em itens canônicos {id, kind:'note'|'pdf', title, signedAt|createdAt,
   * version?, sha256?, docType?}. O shape antigo {template_id,signed_at,version}
   * foi substituído em conjunto com a UI (PatientPortal.tsx — os dois lados
   * são desta fase); audit 'portal.documents.read' mantido.
   */
  @Public()
  @Get('documents')
  async documents(@Req() req: ReqWithPortal) {
    const session = await portalSession(req);
    const notes = await this.db.query<any>(
      `SELECT n.id, n.template_id, n.signed_at, n.version
       FROM encounters e JOIN clinical_notes n ON n.encounter_id = e.id AND n.org_id = e.org_id
       WHERE e.org_id=$1 AND e.patient_id=$2 AND n.status='signed' ORDER BY n.signed_at DESC LIMIT 100`,
      [session.orgId, session.patientId]);
    const pdfs = await this.db.query<any>(
      `SELECT id, doc_type, sha256, created_at FROM clinical_documents
       WHERE org_id=$1 AND patient_id=$2 AND doc_type IN ('prescription','exam_result')
       ORDER BY created_at DESC LIMIT 100`,
      [session.orgId, session.patientId]);
    const items: PortalDocumentItem[] = [
      ...notes.rows.map(n => ({ id: n.id, kind: 'note' as const, title: noteTitle(n.template_id), signedAt: n.signed_at, version: n.version })),
      ...pdfs.rows.map(d => ({ id: d.id, kind: 'pdf' as const, title: PDF_TITLES[d.doc_type] ?? d.doc_type, createdAt: d.created_at, sha256: d.sha256, docType: d.doc_type }))
    ];
    const stamp = (d: PortalDocumentItem) => {
      const v = d.signedAt ?? d.createdAt;
      return v ? new Date(String(v)).getTime() : 0;
    };
    items.sort((a, b) => stamp(b) - stamp(a));
    await this.auditPortal('portal.documents.read', session);
    return items;
  }

  /**
   * Conteúdo do documento — SEM link público persistente: os bytes (PDF) ou o
   * JSON da nota só saem NA RESPOSTA desta requisição autenticada pelo Bearer
   * do portal; nada é acessível por posse de URL, portanto NÃO há expiração de
   * link a gerenciar (o token continua valendo só 1h como a sessão inteira).
   * PDF: re-hash honesto antes de servir (espelha downloadPdf de prescriptions)
   * — content ausente → 404 declarando a ausência; hash divergente → 500
   * "documento corrompido"; bytes suspeitos nunca são entregues.
   */
  @Public()
  @Get('documents/:id/content')
  async documentContent(@Req() req: ReqWithPortal, @Param('id') rawId: string, @Res() res: PortalHttpResponse) {
    const session = await portalSession(req);
    const id = parse(uuid, rawId);
    let kind = 'unknown';
    try {
      // 1º clinical_documents (id + patient + org do token).
      const doc = await this.db.query<any>(
        'SELECT sha256, content FROM clinical_documents WHERE id=$1 AND org_id=$2 AND patient_id=$3',
        [id, session.orgId, session.patientId]);
      if (doc.rowCount) {
        kind = 'pdf';
        const row = doc.rows[0];
        if (row.content === null || row.content === undefined) {
          throw new NotFoundException('PDF não disponível: este documento não tem conteúdo persistido. Fale com a clínica para receber uma cópia.');
        }
        const content = Buffer.from(row.content);
        const digest = createHash('sha256').update(content).digest('hex');
        if (digest !== row.sha256)
          throw new InternalServerErrorException('Documento corrompido: o hash do arquivo não confere com o registrado — ele não será entregue até correção.');
        await this.auditPortal('portal.documents.content.read', session, { kind });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="documento-${id}.pdf"`);
        res.setHeader('Content-Length', String(content.length));
        return res.end(content);
      }
      // 2º senão clinical_notes assinada (id via encounters do próprio paciente).
      const note = await this.db.query<any>(
        `SELECT n.id, n.status, n.signed_at, n.content
         FROM encounters e JOIN clinical_notes n ON n.encounter_id = e.id AND n.org_id = e.org_id
         WHERE n.id=$1 AND e.org_id=$2 AND e.patient_id=$3`,
        [id, session.orgId, session.patientId]);
      if (note.rowCount) {
        kind = 'note';
        const row = note.rows[0];
        if (row.status !== 'signed')
          throw new NotFoundException('Esta nota ainda não foi assinada e não pode ser exibida como documento.');
        await this.auditPortal('portal.documents.content.read', session, { kind });
        const payload = { noteId: row.id, signedAt: row.signed_at, sections: row.content?.sections ?? {} };
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify(payload));
      }
      throw new NotFoundException('Documento não encontrado.');
    } catch (e) {
      // Tentativa também é auditoria quando falha (ausente/corrompido/não assinado).
      await this.auditPortal('portal.documents.content.read.failed', session,
        { kind, reason: e instanceof HttpException ? e.message : 'erro interno ao ler o documento' });
      throw e;
    }
  }

  /** Preferências de notificação atuais (defaults da migração 024 se nulo/ausente). */
  @Public()
  @Get('notifications')
  async notifications(@Req() req: ReqWithPortal) {
    const session = await portalSession(req);
    const rows = await this.db.query<any>(
      'SELECT notification_prefs FROM portal_accounts WHERE id=$1 AND org_id=$2',
      [session.accountId, session.orgId]);
    const stored = rows.rowCount ? rows.rows[0].notification_prefs : null;
    return { prefs: toNotificationPrefsResponse(normalizeNotificationPrefs(stored)) };
  }

  /**
   * Atualização das prefs: .strict() + ≥1 campo (zod → 400 em patch inválido);
   * merge puro valida de novo no servidor; qualquer canal true→false (opt-out)
   * é aceito — opt-out obrigatório nunca é recusado.
   */
  @Public()
  @Put('notifications')
  async updateNotifications(@Req() req: ReqWithPortal, @Body() raw: unknown) {
    const session = await portalSession(req);
    const patch = parse(notificationsPatchSchema, raw);
    const current = await this.db.query<any>(
      'SELECT notification_prefs FROM portal_accounts WHERE id=$1 AND org_id=$2',
      [session.accountId, session.orgId]);
    if (!current.rowCount) throw new UnauthorizedException('Sessão do portal inválida');
    const stored = current.rows[0].notification_prefs;
    const before = normalizeNotificationPrefs(stored);
    const merged = (() => {
      try { return mergeNotificationPrefs(stored, patch); }
      catch (e) { throw new BadRequestException(e instanceof Error ? e.message : 'Preferências inválidas'); }
    })();
    const changed = (Object.keys(DEFAULT_NOTIFICATION_PREFS) as (keyof NotificationPrefs)[])
      .filter(k => before[k] !== merged[k])
      .map(k => ({ key: k, from: before[k], to: merged[k] })); // booleans são prefs, não PHI
    await this.db.query('UPDATE portal_accounts SET notification_prefs=$3 WHERE id=$1 AND org_id=$2',
      [session.accountId, session.orgId, JSON.stringify(merged)]);
    await this.auditPortal('portal.notifications.prefs_updated', session, { changed });
    return { prefs: toNotificationPrefsResponse(merged), changed: changed.map(c => c.key) };
  }

  /**
   * Comprovação de entrega: crm_outbox do PRÓPRIO paciente (migração 024,
   * índice por paciente) — status REAL da fila. O status só vira 'sent' quando
   * o worker scripts/crm/dispatch-outbox.mjs processa a fila; sem
   * CRM_PROVIDER_URL o envio nasce desligado e a linha fica 'queued'. Isso é
   * exibido como está no portal — nunca fingimos "entregue".
   */
  @Public()
  @Get('notifications/history')
  async notificationsHistory(@Req() req: ReqWithPortal) {
    const session = await portalSession(req);
    const rows = await this.db.query<any>(
      `SELECT id, channel, template, status, provider_message_id, error_detail, created_at
       FROM crm_outbox WHERE org_id=$1 AND patient_id=$2 ORDER BY created_at DESC LIMIT 100`,
      [session.orgId, session.patientId]);
    await this.auditPortal('portal.notifications.history.read', session);
    return rows.rows.map(r => ({
      id: r.id, channel: r.channel, template: r.template, status: r.status,
      providerMessageId: r.provider_message_id, errorDetail: r.error_detail, createdAt: r.created_at
    }));
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
      // CRM nasce desligado: fica na fila para o worker futuro. patient_id
      // (migração 024) vincula ao titular para o histórico de comprovação.
      await c.query(
        'INSERT INTO crm_outbox(org_id,channel,recipient,template,rendered,patient_id) VALUES($1,$2,$3,$4,$5,$6)',
        [session.orgId, 'whatsapp', '', 'appointment_request_received',
          JSON.stringify({ specialty: body.preferredSpecialty, period: body.preferredPeriod }), session.patientId]);
      return row.rows[0];
    });
    await this.db.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',
      [session.orgId, null, 'portal.appointment_request.created', 'patient', session.patientId, JSON.stringify({requestId:requestContext.getStore()?.requestId??null})]);
    return created;
  }
}
