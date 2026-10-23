/**
 * Verificação PÚBLICA da receita (farmácia/paciente) — migração 030, lote 4 do
 * porte do repositório de referência (VerificationService.cs + Verify.tsx).
 *
 *   GET  /rx-verify/:token          — sem sessão; só AUTENTICIDADE (sem medicamento)
 *   POST /rx-verify/:token/details  — {code}: dados para dispensação
 *
 * Segredos: o token (URL/QR) é aleatório (192 bits) e o código (8 caracteres,
 * alfabeto Crockford, ~40 bits) fica só como HMAC-SHA256 com sal por documento.
 * 5 códigos errados bloqueiam o documento por 30 min; token desconhecido,
 * documento bloqueado e código errado respondem de forma indistinguível para
 * quem não tem o código (404 / 401 genéricos). Rate limit por IP em main.ts.
 *
 * Isto NÃO substitui o validador oficial do ITI (assinatura PAdES): é a
 * conferência de autenticidade/situação no próprio emissor.
 */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { maskCpf } from './br-identifiers';
import { primaryWebOrigin } from './web-origin';
import { Db } from './db';
import { parse } from './domain';
import { brazilDate, KIND_LABEL, type PrescriptionKind } from './prescription-compliance';
import { Public, QueryRunner, setOrgContext } from './security';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 30;

/** Código legível: 8 símbolos Crockford em dois grupos (ex.: "7K2M-9QXA"). */
export function newAccessCode(random: Buffer = randomBytes(8)): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += CROCKFORD[random[i] % 32];
  return out.slice(0, 4) + '-' + out.slice(4);
}

/** Normaliza o que a pessoa digitou: caixa, separadores e confusões O/0, I/L/1. */
export function normalizeAccessCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function codeHmac(salt: Buffer, code: string): Buffer {
  return createHmac('sha256', salt).update(normalizeAccessCode(code)).digest();
}

export function codeMatches(salt: Buffer, stored: Buffer, input: string): boolean {
  const candidate = codeHmac(salt, input);
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export type NewVerification = { token: string; code: string; salt: Buffer; hmac: Buffer };

export function newVerification(): NewVerification {
  const token = randomBytes(24).toString('base64url');
  const code = newAccessCode();
  const salt = randomBytes(16);
  return { token, code, salt, hmac: codeHmac(salt, code) };
}

/** URL impressa no PDF/QR. Base configurável; padrão = origem da web. */
export function rxVerifyUrl(token: string, env: Record<string, string | undefined> = process.env): string {
  const base = (env.RX_VERIFY_BASE_URL || `${primaryWebOrigin(env)}/verificar`).replace(/\/+$/, '');
  return `${base}/${token}`;
}

/** Iniciais do paciente ("Maria da Silva Souza" → "M. S. S."): conectivos fora. */
export function patientInitials(fullName: string): string {
  return fullName.split(/\s+/).filter(w => w && !/^(da|de|do|das|dos|e)$/i.test(w))
    .map(w => w[0].toUpperCase() + '.').join(' ');
}

export type PublicStatus = 'valid' | 'cancelled' | 'expired' | 'not_issued';

export function publicStatus(row: { status: string; valid_until: string | Date | null }, today: string): PublicStatus {
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status !== 'signed') return 'not_issued';
  const until = row.valid_until instanceof Date ? row.valid_until.toISOString().slice(0, 10) : row.valid_until;
  if (until && until < today) return 'expired';
  return 'valid';
}

/** Grava a verificação da receita na mesma transação da assinatura. */
export async function createPrescriptionVerification(c: QueryRunner, orgId: string, prescriptionId: string): Promise<NewVerification> {
  const v = newVerification();
  await c.query(
    'INSERT INTO prescription_verifications(prescription_id,org_id,public_token,code_salt,code_hmac) VALUES($1,$2,$3,$4,$5)',
    [prescriptionId, orgId, v.token, v.salt, v.hmac]);
  return v;
}

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
const detailsSchema = z.object({ code: z.string().trim().min(4).max(20) }).strict();

type VerificationRow = { prescription_id: string; org_id: string; code_salt: Buffer; code_hmac: Buffer; failed_attempts: number; locked_until: Date | null };

const NOT_FOUND = 'Receita não encontrada para este código de verificação';

@Controller('rx-verify')
export class RxVerifyController {
  constructor(private db: Db) {}

  private async lookup(rawToken: string): Promise<VerificationRow> {
    const ok = tokenSchema.safeParse(rawToken);
    if (!ok.success) throw new NotFoundException(NOT_FOUND);
    // tier2: lookup pelo token EXATO antes do contexto; depois publica a org
    // e só então lê a prescrição (tier1, RLS estrito).
    const r = await this.db.query<VerificationRow>(
      'SELECT prescription_id,org_id,code_salt,code_hmac,failed_attempts,locked_until FROM prescription_verifications WHERE public_token=$1',
      [ok.data]);
    if (!r.rowCount) throw new NotFoundException(NOT_FOUND);
    setOrgContext(r.rows[0].org_id);
    return r.rows[0];
  }

  private async loadPrescription(v: VerificationRow) {
    const r = await this.db.query<any>(
      `SELECT p.status,p.kind,p.valid_until,p.signed_at,p.signature_status,p.prescriber_registration,
              p.medication_name,p.medication_concentration,p.medication_form,p.dose,p.route,p.frequency,p.duration,
              p.quantity,p.instructions,u.display_name AS signer_name,pt.full_name AS patient_name,pt.cpf AS patient_cpf,
              d.sha256 AS document_sha256
         FROM prescriptions p
         JOIN encounters e ON e.id=p.encounter_id AND e.org_id=p.org_id
         JOIN patients pt ON pt.id=e.patient_id AND pt.org_id=p.org_id
         LEFT JOIN users u ON u.id=p.signed_by AND u.org_id=p.org_id
         LEFT JOIN clinical_documents d ON d.id=p.signed_document_id AND d.org_id=p.org_id
        WHERE p.id=$1 AND p.org_id=$2`, [v.prescription_id, v.org_id]);
    if (!r.rowCount) throw new NotFoundException(NOT_FOUND);
    return r.rows[0];
  }

  private async log(v: VerificationRow, action: string, details: Record<string, unknown> = {}) {
    await this.db.query(
      'INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id,details) VALUES($1,NULL,$2,$3,$4,$5)',
      [v.org_id, action, 'prescription', v.prescription_id, JSON.stringify(details)]);
  }

  @Public()
  @Get(':token')
  async publicView(@Param('token') rawToken: string) {
    const v = await this.lookup(rawToken);
    const p = await this.loadPrescription(v);
    const reg = p.prescriber_registration ?? null;
    await this.log(v, 'rx.verify.public');
    return {
      status: publicStatus(p, brazilDate(new Date())),
      kind: p.kind,
      kindLabel: KIND_LABEL[p.kind as PrescriptionKind] ?? p.kind,
      issuedAt: p.signed_at,
      validUntil: p.valid_until,
      signatureLevel: p.signature_status === 'pades' ? 'pades' : p.signature_status === 'attested' ? 'attested' : 'none',
      prescriber: { name: p.signer_name, councilNumber: reg?.councilNumber ?? null, councilState: reg?.councilState ?? null },
      patientInitials: patientInitials(String(p.patient_name ?? '')),
      documentSha256: p.document_sha256 ?? null,
      detailsRequireCode: true,
      note: 'Conferência no emissor. A validade jurídica da assinatura digital (PAdES/ICP-Brasil) é verificada no validador oficial do ITI.',
    };
  }

  @Public()
  @Post(':token/details')
  @HttpCode(200)
  async details(@Param('token') rawToken: string, @Body() raw: unknown) {
    const body = parse(detailsSchema, raw);
    const v = await this.lookup(rawToken);
    if (v.locked_until && v.locked_until > new Date()) {
      await this.log(v, 'rx.verify.locked');
      throw new UnauthorizedException('Código inválido ou consulta temporariamente bloqueada');
    }
    if (!codeMatches(Buffer.from(v.code_salt), Buffer.from(v.code_hmac), body.code)) {
      await this.db.query(
        `UPDATE prescription_verifications SET failed_attempts=failed_attempts+1,
           locked_until=CASE WHEN failed_attempts+1>=$2 THEN now()+($3||' minutes')::interval ELSE locked_until END
         WHERE prescription_id=$1`, [v.prescription_id, MAX_FAILED_ATTEMPTS, String(LOCK_MINUTES)]);
      await this.log(v, 'rx.verify.code_failed', { attempt: v.failed_attempts + 1 });
      throw new UnauthorizedException('Código inválido ou consulta temporariamente bloqueada');
    }
    await this.db.query('UPDATE prescription_verifications SET failed_attempts=0,locked_until=NULL WHERE prescription_id=$1', [v.prescription_id]);
    const p = await this.loadPrescription(v);
    await this.log(v, 'rx.verify.details');
    return {
      status: publicStatus(p, brazilDate(new Date())),
      kindLabel: KIND_LABEL[p.kind as PrescriptionKind] ?? p.kind,
      issuedAt: p.signed_at,
      validUntil: p.valid_until,
      patient: { name: p.patient_name, cpfMasked: maskCpf(p.patient_cpf) },
      medication: {
        name: p.medication_name, concentration: p.medication_concentration, form: p.medication_form,
        dose: p.dose, route: p.route, frequency: p.frequency, duration: p.duration, quantity: p.quantity,
        instructions: p.instructions,
      },
      documentSha256: p.document_sha256 ?? null,
    };
  }
}
