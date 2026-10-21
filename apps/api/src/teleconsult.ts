import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { env } from './config';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, Public, audit, requestContext, requireRole, setOrgContext, sha256Hex } from './security';

/**
 * Teleconsulta: signaling WebRTC por REST (oferta/resposta/ICE via filas com seq).
 * A mídia em si é peer-to-peer no navegador; aqui vivem salas, consentimento
 * explícito de gravação, convite single-use do paciente e a fila append-only.
 *
 * Fase 4 (ST-P1-007):
 *  - Paciente: o convite é single-use; depois de consumido ele troca SDP/ICE com
 *    um TOKEN DE SALA de 4h (claim purpose='teleconsult-room') — nunca localStorage.
 *  - ICE/TURN por env (`TELECONSULT_ICE_SERVERS`); sem env há P2P direto e NENHUMA
 *    credencial existe (capacidade nasce desligada, como a ACT).
 *  - Gravação: NÃO existe capacidade de gravação implementada; o consentimento
 *    registrado é exibido e "Gravação: desligada" é o padrão deste ambiente
 *    (armazenamento de mídia = pendência LGPD/DPO — ADR do marco).
 */

type ReqWithActor = { actor: Actor; headers?: Record<string, unknown> };
const headerOf = (req: ReqWithActor, name: string): string => {
  const v = req.headers?.[name];
  return typeof v === 'string' ? v : '';
};

const roomCreateSchema = z.object({ encounterId: uuid, appointmentId: uuid.optional() }).strict();
const consentSchema = z.object({ recordingConsent: z.boolean() }).strict();
const joinPatientSchema = z.object({ inviteCode: z.string().trim().min(16).max(64) }).strict();
const signalSchema = z.object({
  kind: z.enum(['offer', 'answer', 'ice', 'bye']),
  senderKind: z.enum(['clinician', 'patient']),
  payload: z.record(z.unknown()).optional()
}).strict();

export type RoomStatus = 'waiting' | 'open' | 'closed';

/** Máquina de estados pura da sala (testável sem banco). */
export function transitionRoom(current: RoomStatus, event: 'join' | 'bye'): RoomStatus {
  if (current === 'waiting' && event === 'join') return 'open';
  if (current === 'open' && event === 'bye') return 'closed';
  throw new ConflictException(`Transição inválida: sala '${current}' + evento '${event}'`);
}

/** Próximo seq da fila de sinais (testável). */
export function nextSeq(last: number): number { return last + 1; }

/** Convite: single-use, expiração e hash conferidos (testável). */
export function isValidInvite(row: { code_hash: string; expires_at: Date; used_at: Date | null }, code: string, now: Date): boolean {
  if (row.used_at) return false;
  if (now.getTime() > new Date(row.expires_at).getTime()) return false;
  return row.code_hash === sha256Hex(normalizeInvite(code));
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

// ------------------------------------------------------------ Fase 4 ------
const ROOM_PURPOSE = 'teleconsult-room';
const roomKey = () => new TextEncoder().encode(env('AUTH_SECRET'));

/** Token de sala do PACIENTE (4h, sem usuário): claims puras e testáveis. */
export async function signPatientRoomToken(roomId: string, orgId: string): Promise<string> {
  return new SignJWT({ purpose: ROOM_PURPOSE, roomId, org: orgId, kind: 'patient' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('4h')
    .sign(roomKey());
}

export type PatientRoomClaims = { purpose: string; roomId: string; org: string; kind: string };

/** Verificação do token de sala: assinatura + exp + propósito + roomId casado.
 *  Qualquer divergência → 401 (nunca conta o motivo exato ao cliente). */
export async function verifyPatientRoomToken(token: string, roomId: string): Promise<PatientRoomClaims> {
  try {
    const { payload } = await jwtVerify(token, roomKey());
    const claims = {
      purpose: String(payload.purpose ?? ''),
      roomId: String(payload.roomId ?? ''),
      org: String(payload.org ?? ''),
      kind: String(payload.kind ?? '')
    };
    if (claims.purpose !== ROOM_PURPOSE || claims.kind !== 'patient' || claims.roomId !== roomId || !claims.org)
      throw new Error('claims inválidos');
    return claims;
  } catch {
    throw new UnauthorizedException('Sessão de teleconsulta inválida ou expirada');
  }
}

export type IceConfig = { iceServers: Array<Record<string, unknown>>; warning?: string };

/** ICE/TURN por env (`TELECONSULT_ICE_SERVERS` = JSON array). Ausente → P2P
 *  direto sem nenhum servidor/credencial; JSON inválido → degrada com aviso
 *  honesto (nunca lança: a sala não pode morrer por configuração). Pura. */
export function iceConfigFromEnv(raw: string | undefined): IceConfig {
  if (!raw || !raw.trim()) return { iceServers: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('não é array');
    return { iceServers: parsed as Array<Record<string, unknown>> };
  } catch {
    return { iceServers: [], warning: 'TELECONSULT_ICE_SERVERS inválido — usando sem servidores externos (P2P direto).' };
  }
}

@Controller('teleconsult')
export class TeleconsultController {
  constructor(private db: Db) {}

  @Post('rooms')
  async createRoom(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const body = parse(roomCreateSchema, raw);
    const encounter = await this.db.query('SELECT id FROM encounters WHERE id=$1 AND org_id=$2', [body.encounterId, actor.org_id]);
    if (!encounter.rowCount) throw new NotFoundException('Atendimento não encontrado');
    const open = await this.db.query('SELECT id FROM teleconsult_rooms WHERE encounter_id=$1 AND status<>$2', [body.encounterId, 'closed']);
    if (open.rowCount) throw new ConflictException('Já existe sala de teleconsulta para este atendimento');
    const inviteCode = generateInviteCode();
    const room = await this.db.tx(async c => {
      const inserted = await c.query(
        'INSERT INTO teleconsult_rooms(org_id,encounter_id,appointment_id,created_by) VALUES($1,$2,$3,$4) RETURNING id,status,created_at',
        [actor.org_id, body.encounterId, body.appointmentId ?? null, actor.id]);
      // BUG LATENTE (Fase 4): o WHERE usava o id da SALA — 0 linhas selecionadas
      // e o convite NUNCA existia (join sempre 401). O id do ATENDIMENTO é $4.
      await c.query(
        'INSERT INTO teleconsult_invites(org_id,room_id,patient_id,code_hash,expires_at) ' +
        'SELECT $1,$2,e.patient_id,$3,now()+interval \'6 hours\' FROM encounters e WHERE e.id=$4 AND e.org_id=$1',
        [actor.org_id, inserted.rows[0].id, sha256Hex(normalizeInvite(inviteCode)), body.encounterId]);
      await c.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',
        [actor.org_id, actor.id, 'teleconsult.room.created', 'teleconsult_room', inserted.rows[0].id, JSON.stringify({requestId:requestContext.getStore()?.requestId??null})]);
      return inserted.rows[0];
    });
    return { ...room, inviteCode, inviteExpiresInHours: 6 };
  }

  @Get('rooms/:id')
  async getRoom(@Req() req: ReqWithActor, @Param('id') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const id = parse(uuid, rawId);
    const room = await this.db.query('SELECT id,status,recording_consent,created_at,closed_at FROM teleconsult_rooms WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
    if (!room.rowCount) throw new NotFoundException('Sala não encontrada');
    const last = await this.db.query('SELECT COALESCE(MAX(seq),0) AS seq FROM teleconsult_signals WHERE room_id=$1', [id]);
    return { ...room.rows[0], lastSeq: Number(last.rows[0].seq) };
  }

  @Post('rooms/:id/consent')
  async consent(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['doctor']);
    const id = parse(uuid, rawId);
    const body = parse(consentSchema, raw);
    const updated = await this.db.query(
      'UPDATE teleconsult_rooms SET recording_consent=$3 WHERE id=$1 AND org_id=$2 RETURNING id,status',
      [id, actor.org_id, body.recordingConsent]);
    if (!updated.rowCount) throw new NotFoundException('Sala não encontrada');
    await audit(this.db, actor, 'teleconsult.consent.recorded', 'teleconsult_room', id, { recordingConsent: body.recordingConsent });
    return { id, recordingConsent: body.recordingConsent };
  }

  @Post('rooms/:id/join')
  async joinStaff(@Req() req: ReqWithActor, @Param('id') rawId: string) {
    return this.join(req.actor, parse(uuid, rawId), 'clinician');
  }

  @Public()
  @Post('rooms/:id/join-patient')
  async joinPatient(@Param('id') rawId: string, @Body() raw: unknown) {
    const id = parse(uuid, rawId);
    const body = parse(joinPatientSchema, raw);
    // Só a tabela de convites (tier2) — o JOIN com a sala (tier1) viria antes do
    // contexto de tenant e a RLS esconderia a sala, negando o acesso legítimo.
    // O código do convite é o que autoriza; o hash não vaza.
    const invites = await this.db.query<any>(
      'SELECT i.id,i.code_hash,i.expires_at,i.used_at,i.org_id FROM teleconsult_invites i WHERE i.room_id=$1',
      [id]);
    const now = new Date();
    const match = invites.rows.find((row) => isValidInvite(row, body.inviteCode, now));
    if (!match) throw new UnauthorizedException('Convite inválido ou expirado');
    // Convite válido (segredo) resolve o tenant ANTES das leituras/escritas de
    // dado clínico desta requisição pública (RLS via starmed.org_id).
    setOrgContext(match.org_id);
    const orgId: string = match.org_id;
    const room = await this.db.query<any>('SELECT id,status,recording_consent FROM teleconsult_rooms WHERE id=$1 AND org_id=$2', [id, orgId]);
    if (!room.rowCount) throw new NotFoundException('Sala não encontrada');
    const current = room.rows[0].status as RoomStatus;
    if (current === 'closed') throw new ConflictException('Sala encerrada');
    if (room.rows[0].recording_consent === null) throw new ConflictException('Registre o consentimento de gravação (aceito ou recusado) antes de entrar');
    // O convite só é consumido DEPOIS das validações da sala: um join recusado
    // (sem consentimento, sala fechada) NÃO pode queimar o código de uso único.
    await this.db.query('UPDATE teleconsult_invites SET used_at=now() WHERE id=$1 AND used_at IS NULL', [match.id]);
    // Sala 'open' = ciclo já aberto por outro participante: entrar não MUDA o
    // estado (transitionRoom('open','join') continua inválido como máquina pura —
    // contrato do teste existente — mas a participação é legítima).
    const next = current === 'open' ? 'open' : transitionRoom(current, 'join');
    await this.db.query('UPDATE teleconsult_rooms SET status=$2 WHERE id=$1', [id, next]);
    // Sem sessão do paciente nesta etapa: a auditoria registra o ato sem actor de usuário.
    await this.db.query('INSERT INTO audit_events(org_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)',
      [orgId, 'teleconsult.patient.joined', 'teleconsult_room', id,
       JSON.stringify({requestId:requestContext.getStore()?.requestId??null})]);
    // Fase 4: o convite é single-use — o TOKEN DE SALA (4h) é o que permite o
    // paciente trocar SDP/ICE depois de entrar (nunca persistido no navegador).
    const patientToken = await signPatientRoomToken(id, orgId);
    return { id, status: next, patientToken, expiresInHours: 4 };
  }

  private async join(actor: Actor, roomId: string, kind: 'clinician' | 'patient') {
    const room = await this.db.query<any>('SELECT id,status,recording_consent FROM teleconsult_rooms WHERE id=$1 AND org_id=$2', [roomId, actor.org_id]);
    if (!room.rowCount) throw new NotFoundException('Sala não encontrada');
    const current = room.rows[0].status as RoomStatus;
    if (current === 'closed') throw new ConflictException('Sala encerrada');
    if (room.rows[0].recording_consent === null) throw new ConflictException('Registre o consentimento de gravação (aceito ou recusado) antes de entrar');
    // Sala 'open': o segundo participante entra sem mudar o ciclo (ver nota no
    // join-patient — transitionRoom('open','join') segue inválido como máquina pura).
    const next = current === 'open' ? 'open' : transitionRoom(current, 'join');
    await this.db.query('UPDATE teleconsult_rooms SET status=$3 WHERE id=$1 AND org_id=$2', [roomId, actor.org_id, next]);
    await audit(this.db, actor, 'teleconsult.joined', 'teleconsult_room', roomId, { kind });
    return { id: roomId, status: next };
  }

  /** Núcleo transacional do append: seq monotônico sob FOR UPDATE; `bye`
   *  fecha a sala. Compartilhado pelos lados staff e paciente. */
  private async appendSignal(
    c: PoolClient, roomId: string, orgId: string,
    senderKind: 'clinician' | 'patient',
    kind: 'offer' | 'answer' | 'ice' | 'bye',
    payload: Record<string, unknown>
  ) {
    await c.query('SELECT id FROM teleconsult_rooms WHERE id=$1 FOR UPDATE', [roomId]);
    const last = await c.query('SELECT COALESCE(MAX(seq),0) AS seq FROM teleconsult_signals WHERE room_id=$1', [roomId]);
    // org_id NOT NULL veio da migração 018 (RLS): SEM ele o INSERT falha —
    // sinalização nunca tinha sido exercitada antes da Fase 4.
    const row = await c.query(
      'INSERT INTO teleconsult_signals(org_id,room_id,sender_kind,kind,payload,seq) VALUES($1,$2,$3,$4,$5,$6) RETURNING seq,kind,created_at',
      [orgId, roomId, senderKind, kind, JSON.stringify(payload), nextSeq(Number(last.rows[0].seq))]);
    if (kind === 'bye')
      await c.query(`UPDATE teleconsult_rooms SET status='closed', closed_at=now() WHERE id=$1 AND org_id=$2`, [roomId, orgId]);
    return row.rows[0];
  }

  @Post('rooms/:id/signals')
  async signal(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const id = parse(uuid, rawId);
    const body = parse(signalSchema, raw);
    const room = await this.db.query<any>('SELECT id,status FROM teleconsult_rooms WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
    if (!room.rowCount) throw new NotFoundException('Sala não encontrada');
    if (room.rows[0].status === 'closed') throw new ConflictException('Sala encerrada');
    const inserted = await this.db.tx(c => this.appendSignal(c, id, actor.org_id, body.senderKind, body.kind, body.payload ?? {}));
    await audit(this.db, actor, 'teleconsult.signal.' + body.kind, 'teleconsult_room', id);
    return inserted;
  }

  @Get('rooms/:id/signals')
  async signals(@Req() req: ReqWithActor, @Param('id') rawId: string, @Query('after') after = '0') {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const id = parse(uuid, rawId);
    const afterSeq = Math.max(0, Number.parseInt(after, 10) || 0);
    const room = await this.db.query('SELECT 1 FROM teleconsult_rooms WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
    if (!room.rowCount) throw new NotFoundException('Sala não encontrada');
    const rows = await this.db.query(
      'SELECT seq,sender_kind,kind,payload,created_at FROM teleconsult_signals WHERE room_id=$1 AND seq>$2 ORDER BY seq LIMIT 500',
      [id, afterSeq]);
    return rows.rows;
  }

  // ------------------------------------------------------------ Fase 4 ----

  /** Lado PACIENTE do signaling: token de sala (header `x-teleconsult-token`,
   *  emitido no join-patient) resolvendo o tenant; mesmo append-only. */
  @Public()
  @Post('rooms/:id/signals/patient')
  async patientSignal(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const roomId = parse(uuid, rawId);
    const claims = await verifyPatientRoomToken(headerOf(req, 'x-teleconsult-token'), roomId);
    setOrgContext(claims.org);
    const body = parse(signalSchema, raw);
    if (body.senderKind !== 'patient') throw new UnauthorizedException('Token de paciente exige senderKind patient');
    const room = await this.db.query<any>('SELECT id,status FROM teleconsult_rooms WHERE id=$1 AND org_id=$2', [roomId, claims.org]);
    if (!room.rowCount) throw new NotFoundException('Sala não encontrada');
    if (room.rows[0].status === 'closed') throw new ConflictException('Sala encerrada');
    const inserted = await this.db.tx(c => this.appendSignal(c, roomId, claims.org, 'patient', body.kind, body.payload ?? {}));
    // Sem usuário logado: auditoria do ato no padrão de join-patient (sem actor).
    await this.db.query('INSERT INTO audit_events(org_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)',
      [claims.org, 'teleconsult.signal.' + body.kind, 'teleconsult_room', roomId,
       JSON.stringify({ via: 'patient', requestId: requestContext.getStore()?.requestId ?? null })]);
    return inserted;
  }

  @Public()
  @Get('rooms/:id/signals/patient')
  async patientSignals(@Req() req: ReqWithActor, @Param('id') rawId: string, @Query('after') after = '0') {
    const roomId = parse(uuid, rawId);
    const claims = await verifyPatientRoomToken(headerOf(req, 'x-teleconsult-token'), roomId);
    setOrgContext(claims.org);
    const afterSeq = Math.max(0, Number.parseInt(after, 10) || 0);
    const room = await this.db.query('SELECT 1 FROM teleconsult_rooms WHERE id=$1 AND org_id=$2', [roomId, claims.org]);
    if (!room.rowCount) throw new NotFoundException('Sala não encontrada');
    const rows = await this.db.query(
      'SELECT seq,sender_kind,kind,payload,created_at FROM teleconsult_signals WHERE room_id=$1 AND seq>$2 ORDER BY seq LIMIT 500',
      [roomId, afterSeq]);
    return rows.rows;
  }

  /** ICE/TURN do navegador: `TELECONSULT_ICE_SERVERS` (JSON). Sem env → P2P
   *  direto sem credencial nenhuma (capacidade nasce desligada). */
  @Public()
  @Get('ice-config')
  async iceConfig() {
    return iceConfigFromEnv(process.env.TELECONSULT_ICE_SERVERS);
  }
}
