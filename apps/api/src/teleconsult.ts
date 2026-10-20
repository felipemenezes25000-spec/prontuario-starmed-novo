import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, Public, audit, requestContext, requireRole, sha256Hex } from './security';

/**
 * Teleconsulta: signaling WebRTC por REST (oferta/resposta/ICE via filas com seq).
 * A mídia em si é peer-to-peer no navegador; aqui vivem salas, consentimento
 * explícito de gravação, convite single-use do paciente e a fila append-only.
 */

type ReqWithActor = { actor: Actor };

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
      await c.query(
        'INSERT INTO teleconsult_invites(org_id,room_id,patient_id,code_hash,expires_at) ' +
        'SELECT $1,$2,e.patient_id,$4,now()+interval \'6 hours\' FROM encounters e WHERE e.id=$2 AND e.org_id=$1',
        [actor.org_id, inserted.rows[0].id, null, sha256Hex(normalizeInvite(inviteCode))]);
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
    const invites = await this.db.query<any>(
      'SELECT i.id,i.code_hash,i.expires_at,i.used_at,i.org_id FROM teleconsult_invites i JOIN teleconsult_rooms r ON r.id=i.room_id WHERE r.id=$1',
      [id]);
    const now = new Date();
    const match = invites.rows.find((row) => isValidInvite(row, body.inviteCode, now));
    if (!match) throw new UnauthorizedException('Convite inválido ou expirado');
    await this.db.query('UPDATE teleconsult_invites SET used_at=now() WHERE id=$1 AND used_at IS NULL', [match.id]);
    const orgId: string = match.org_id;
    const room = await this.db.query<any>('SELECT id,status,recording_consent FROM teleconsult_rooms WHERE id=$1 AND org_id=$2', [id, orgId]);
    if (!room.rowCount) throw new NotFoundException('Sala não encontrada');
    const current = room.rows[0].status as RoomStatus;
    if (current === 'closed') throw new ConflictException('Sala encerrada');
    if (room.rows[0].recording_consent === null) throw new ConflictException('Registre o consentimento de gravação (aceito ou recusado) antes de entrar');
    const next = transitionRoom(current, 'join');
    await this.db.query('UPDATE teleconsult_rooms SET status=$2 WHERE id=$1', [id, next]);
    // Sem sessão do paciente nesta etapa: a auditoria registra o ato sem actor de usuário.
    await this.db.query('INSERT INTO audit_events(org_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)',
      [orgId, 'teleconsult.patient.joined', 'teleconsult_room', id,
       JSON.stringify({requestId:requestContext.getStore()?.requestId??null})]);
    return { id, status: next };
  }

  private async join(actor: Actor, roomId: string, kind: 'clinician' | 'patient') {
    const room = await this.db.query<any>('SELECT id,status,recording_consent FROM teleconsult_rooms WHERE id=$1 AND org_id=$2', [roomId, actor.org_id]);
    if (!room.rowCount) throw new NotFoundException('Sala não encontrada');
    const current = room.rows[0].status as RoomStatus;
    if (current === 'closed') throw new ConflictException('Sala encerrada');
    if (room.rows[0].recording_consent === null) throw new ConflictException('Registre o consentimento de gravação (aceito ou recusado) antes de entrar');
    const next = transitionRoom(current, 'join');
    await this.db.query('UPDATE teleconsult_rooms SET status=$3 WHERE id=$1 AND org_id=$2', [roomId, actor.org_id, next]);
    await audit(this.db, actor, 'teleconsult.joined', 'teleconsult_room', roomId, { kind });
    return { id: roomId, status: next };
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
    const inserted = await this.db.tx(async c => {
      await c.query('SELECT id FROM teleconsult_rooms WHERE id=$1 FOR UPDATE', [id]);
      const last = await c.query('SELECT COALESCE(MAX(seq),0) AS seq FROM teleconsult_signals WHERE room_id=$1', [id]);
      const row = await c.query(
        'INSERT INTO teleconsult_signals(room_id,sender_kind,kind,payload,seq) VALUES($1,$2,$3,$4,$5) RETURNING seq,kind,created_at',
        [id, body.senderKind, body.kind, JSON.stringify(body.payload ?? {}), nextSeq(Number(last.rows[0].seq))]);
      if (body.kind === 'bye')
        await c.query('UPDATE teleconsult_rooms SET status=\'closed\', closed_at=now() WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
      return row.rows[0];
    });
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
}
