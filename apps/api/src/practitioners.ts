/**
 * Registro profissional do prescritor (CRM/UF, RQE, contato profissional) —
 * migração 029. Também expõe os tipos de receita disponíveis no ambiente.
 *
 *   GET /users/:userId/registration   — admin da org ou o próprio médico
 *   PUT /users/:userId/registration   — admin da org ou o próprio médico
 *   GET /prescription-kinds           — tipos liberados/bloqueados + motivo honesto
 *
 * CRM não tem dígito verificador nacional: valida-se formato + UF (checkCrm).
 * Conferir se o CRM está ATIVO no conselho é etapa externa (portal do CFM, sem
 * API pública) — o cadastro não afirma isso.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { checkCrm } from './br-identifiers';
import { Db } from './db';
import { parse, uuid } from './domain';
import { kindAvailability, RX_RULES_VERSION, type PrescriberRegistration } from './prescription-compliance';
import { Actor, audit, QueryRunner, requireRole } from './security';

type ReqWithActor = { actor: Actor };

const optionalText = (min: number, max: number) =>
  z.preprocess(v => (v === '' ? undefined : v), z.string().trim().min(min).max(max).optional());

export const registrationSchema = z.object({
  councilNumber: z.string().trim().min(1).max(20),
  councilState: z.string().trim().min(2).max(2),
  rqe: z.preprocess(v => (v === '' ? undefined : v), z.string().trim().regex(/^[0-9]{1,8}$/, 'RQE deve ter só dígitos').optional()),
  specialty: optionalText(2, 120),
  professionalAddress: optionalText(5, 300),
  professionalPhone: z.preprocess(v => (v === '' ? undefined : v),
    z.string().max(25).transform(s => s.replace(/\D/g, '')).refine(s => /^[0-9]{10,13}$/.test(s), 'Telefone com DDD (10 a 13 dígitos)').optional()),
}).strict();
export type RegistrationBody = z.infer<typeof registrationSchema>;

/** Valida CRM/UF (formato) e grava/atualiza o registro de um MÉDICO da org. */
export async function upsertRegistration(c: QueryRunner, actor: Actor, userId: string, body: RegistrationBody) {
  const crm = checkCrm(body.councilNumber, body.councilState);
  if (!crm.ok) throw new BadRequestException({ message: 'Registro profissional inválido', issues: [{ path: 'councilNumber', message: crm.error }] });
  const user = await c.query('SELECT role FROM users WHERE id=$1 AND org_id=$2', [userId, actor.org_id]);
  if (!user.rowCount) throw new NotFoundException('Usuário não encontrado');
  if (user.rows[0].role !== 'doctor') throw new ConflictException('Registro de CRM se aplica apenas a usuários médicos');
  try {
    const r = await c.query(
      `INSERT INTO practitioner_registrations(user_id,org_id,council,council_number,council_state,rqe,specialty,professional_address,professional_phone,updated_by)
       VALUES($1,$2,'CRM',$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id) DO UPDATE SET council_number=EXCLUDED.council_number, council_state=EXCLUDED.council_state,
         rqe=EXCLUDED.rqe, specialty=EXCLUDED.specialty, professional_address=EXCLUDED.professional_address,
         professional_phone=EXCLUDED.professional_phone, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING ${REGISTRATION_COLUMNS}`,
      [userId, actor.org_id, crm.number, crm.state, body.rqe ?? null, body.specialty ?? null,
       body.professionalAddress ?? null, body.professionalPhone ?? null, actor.id]);
    await audit(c, actor, 'practitioner.registration.upserted', 'user', userId, { councilState: crm.state });
    return r.rows[0];
  } catch (e: any) {
    if (e?.code === '23505') throw new ConflictException('Este CRM/UF já está vinculado a outro usuário desta organização');
    throw e;
  }
}

export const REGISTRATION_COLUMNS =
  'council, council_number AS "councilNumber", council_state AS "councilState", rqe, specialty, ' +
  'professional_address AS "professionalAddress", professional_phone AS "professionalPhone", updated_at AS "updatedAt"';

export async function loadRegistration(c: QueryRunner, orgId: string, userId: string): Promise<PrescriberRegistration | null> {
  const r = await c.query(`SELECT ${REGISTRATION_COLUMNS} FROM practitioner_registrations WHERE user_id=$1 AND org_id=$2`, [userId, orgId]);
  return r.rowCount ? r.rows[0] : null;
}

function requireSelfOrAdmin(actor: Actor, userId: string) {
  requireRole(actor, ['admin', 'doctor']);
  if (actor.role !== 'admin' && actor.id !== userId) throw new ForbiddenException('Somente o próprio médico ou o administrador da organização');
}

@Controller('users/:userId/registration')
export class PractitionerRegistrationController {
  constructor(private db: Db) {}

  @Get()
  async get(@Req() req: ReqWithActor, @Param('userId') rawId: string) {
    const actor = req.actor;
    const userId = parse(uuid, rawId);
    requireSelfOrAdmin(actor, userId);
    const reg = await loadRegistration(this.db, actor.org_id, userId);
    if (!reg) throw new NotFoundException('Registro profissional não cadastrado');
    return reg;
  }

  @Put()
  async put(@Req() req: ReqWithActor, @Param('userId') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    const userId = parse(uuid, rawId);
    requireSelfOrAdmin(actor, userId);
    const body = parse(registrationSchema, raw);
    return this.db.tx(c => upsertRegistration(c, actor, userId, body));
  }
}

@Controller('prescription-kinds')
export class PrescriptionKindsController {
  @Get()
  list(@Req() req: ReqWithActor) {
    requireRole(req.actor, ['admin', 'doctor', 'nurse']);
    return { rulesVersion: RX_RULES_VERSION, kinds: kindAvailability() };
  }
}
