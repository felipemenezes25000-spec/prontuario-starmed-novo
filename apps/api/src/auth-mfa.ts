import { Body, ConflictException, Controller, Get, Injectable, NotFoundException, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Db } from './db';
import { env } from './config';
import { mfaActivateSchema, mfaPasswordConfirmSchema, mfaRecoverySchema, mfaVerifySchema, parse } from './domain';
import {
  Actor, Public, SessionUser, audit, openSecret, sealSecret, sessionResponse, setOrgContext, verifyMfaStepToken,
  verifyPassword
} from './security';
import {
  base32Decode, buildOtpauthUri, generateRecoveryCodes, generateTotpSecret, recoveryCodeHash, verifyTotp
} from './totp';

type ReqWithActor = { actor: Actor };
type MfaUserRow = SessionUser & { active: boolean; mfa_secret: string | null; mfa_enabled: boolean; mfa_enrolled_at: Date | null; password_hash: string };

@Injectable()
export class MfaService {
  constructor(private db: Db) {}
  private static readonly columns = 'id,org_id,email,role,auth_version,display_name,active,mfa_secret,mfa_enabled,mfa_enrolled_at,password_hash';
  async loadSessionUser(actor: Actor): Promise<MfaUserRow> {
    const r = await this.db.query<MfaUserRow>(
      `SELECT ${MfaService.columns} FROM users WHERE id=$1 AND org_id=$2`,
      [actor.id, actor.org_id]);
    if (!r.rowCount) throw new NotFoundException('Usuário não encontrado');
    return r.rows[0];
  }
  async loadMfaUser(mfaToken: string): Promise<MfaUserRow> {
    let claims;
    try { claims = await verifyMfaStepToken(mfaToken); }
    catch { throw new UnauthorizedException('Token de verificação inválido ou expirado'); }
    const r = await this.db.query<MfaUserRow>(
      `SELECT ${MfaService.columns} FROM users WHERE id=$1 AND org_id=$2`,
      [claims.id, claims.org_id]);
    const user = r.rows[0];
    if (!user || !user.active || user.auth_version !== claims.auth_version || !user.mfa_enabled || !user.mfa_secret)
      throw new UnauthorizedException('Token de verificação inválido ou expirado');
    return user;
  }
  currentTotp(secretSealed: string, code: string): boolean {
    return verifyTotp(base32Decode(openSecret(secretSealed)), code, Date.now());
  }
}

@Controller('auth/mfa')
export class MfaController {
  constructor(private db: Db, private mfa: MfaService) {}

  @Get('status')
  async status(@Req() req: ReqWithActor) {
    const user = await this.mfa.loadSessionUser(req.actor);
    return { enabled: user.mfa_enabled, enrolledAt: user.mfa_enrolled_at, methods: user.mfa_enabled ? ['totp', 'recovery'] : [] };
  }

  @Post('enroll')
  async enroll(@Req() req: ReqWithActor) {
    const actor = req.actor;
    const user = await this.mfa.loadSessionUser(actor);
    if (user.mfa_enabled) throw new ConflictException('MFA já ativado; desative antes de reinscrever');
    const { secretBase32 } = generateTotpSecret();
    await this.db.query('UPDATE users SET mfa_secret=$3 WHERE id=$1 AND org_id=$2', [actor.id, actor.org_id, sealSecret(secretBase32)]);
    await audit(this.db, actor, 'auth.mfa.enroll.request', 'user', actor.id);
    return {
      secretBase32,
      otpauthUri: buildOtpauthUri({ account: actor.email, issuer: env('AUTH_ISSUER'), secretBase32 }),
      algorithm: 'SHA1', digits: 6, periodSeconds: 30
    };
  }

  @Post('activate')
  async activate(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    const body = parse(mfaActivateSchema, raw);
    const user = await this.mfa.loadSessionUser(actor);
    if (user.mfa_enabled) throw new ConflictException('MFA já ativado');
    if (!user.mfa_secret) throw new ConflictException('Inicie a inscrição em /auth/mfa/enroll');
    if (!this.mfa.currentTotp(user.mfa_secret, body.code)) {
      await audit(this.db, actor, 'auth.mfa.activate.failed', 'user', actor.id);
      throw new UnauthorizedException('Código inválido');
    }
    const recoveryCodes = generateRecoveryCodes();
    await this.db.tx(async c => {
      await c.query('UPDATE users SET mfa_enabled=true, mfa_enrolled_at=now() WHERE id=$1 AND org_id=$2', [actor.id, actor.org_id]);
      await c.query('DELETE FROM mfa_recovery_codes WHERE org_id=$1 AND user_id=$2', [actor.org_id, actor.id]);
      for (const code of recoveryCodes)
        await c.query('INSERT INTO mfa_recovery_codes(org_id,user_id,code_hash) VALUES($1,$2,$3)', [actor.org_id, actor.id, recoveryCodeHash(code)]);
      await audit(c, actor, 'auth.mfa.activated', 'user', actor.id);
    });
    return { enabled: true, recoveryCodes };
  }

  @Post('recovery-codes')
  async regenerate(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    const body = parse(mfaPasswordConfirmSchema, raw);
    const user = await this.mfa.loadSessionUser(actor);
    if (!user.mfa_enabled || !user.mfa_secret) throw new ConflictException('MFA não ativado');
    if (!await verifyPassword(body.password, user.password_hash)) throw new UnauthorizedException('Credenciais inválidas');
    if (!this.mfa.currentTotp(user.mfa_secret, body.code)) throw new UnauthorizedException('Código inválido');
    const recoveryCodes = generateRecoveryCodes();
    await this.db.tx(async c => {
      await c.query('DELETE FROM mfa_recovery_codes WHERE org_id=$1 AND user_id=$2', [actor.org_id, actor.id]);
      for (const code of recoveryCodes)
        await c.query('INSERT INTO mfa_recovery_codes(org_id,user_id,code_hash) VALUES($1,$2,$3)', [actor.org_id, actor.id, recoveryCodeHash(code)]);
    });
    await audit(this.db, actor, 'auth.mfa.recovery.regenerated', 'user', actor.id);
    return { recoveryCodes };
  }

  @Post('disable')
  async disable(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    const body = parse(mfaPasswordConfirmSchema, raw);
    const user = await this.mfa.loadSessionUser(actor);
    if (!user.mfa_enabled || !user.mfa_secret) throw new ConflictException('MFA não ativado');
    if (!await verifyPassword(body.password, user.password_hash)) throw new UnauthorizedException('Credenciais inválidas');
    if (!this.mfa.currentTotp(user.mfa_secret, body.code)) throw new UnauthorizedException('Código inválido');
    // auth_version bump revokes every existing session for this user, including this one.
    await this.db.tx(async c => {
      await c.query("UPDATE users SET mfa_enabled=false, mfa_secret=NULL, mfa_enrolled_at=NULL, auth_version=auth_version+1 WHERE id=$1 AND org_id=$2", [actor.id, actor.org_id]);
      await c.query('DELETE FROM mfa_recovery_codes WHERE org_id=$1 AND user_id=$2', [actor.org_id, actor.id]);
    });
    await audit(this.db, actor, 'auth.mfa.disabled', 'user', actor.id);
    return { enabled: false, sessionsRevoked: true };
  }

  @Public()
  @Post('verify')
  async verify(@Body() raw: unknown) {
    const body = parse(mfaVerifySchema, raw);
    const user = await this.mfa.loadMfaUser(body.mfaToken);
    // Step-up é pré-sessão: publica o tenant aqui para as queries RLS seguintes.
    setOrgContext(user.org_id);
    if (!this.mfa.currentTotp(user.mfa_secret!, body.code)) {
      await audit(this.db, user, 'auth.mfa.verify.failed', 'user', user.id);
      throw new UnauthorizedException('Código inválido');
    }
    await audit(this.db, user, 'auth.login.mfa', 'user', user.id);
    return sessionResponse(user);
  }

  @Public()
  @Post('recovery')
  async recovery(@Body() raw: unknown) {
    const body = parse(mfaRecoverySchema, raw);
    const user = await this.mfa.loadMfaUser(body.mfaToken);
    setOrgContext(user.org_id);
    const hash = recoveryCodeHash(body.recoveryCode);
    const consumed = await this.db.query(
      'UPDATE mfa_recovery_codes SET used_at=now() WHERE org_id=$1 AND user_id=$2 AND code_hash=$3 AND used_at IS NULL RETURNING id',
      [user.org_id, user.id, hash]);
    if (!consumed.rowCount) {
      await audit(this.db, user, 'auth.mfa.recovery.failed', 'user', user.id);
      throw new UnauthorizedException('Código de recuperação inválido');
    }
    await audit(this.db, user, 'auth.mfa.recovery.used', 'user', user.id);
    return sessionResponse(user);
  }
}
