import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { Db } from './db';
import { env } from './config';
import { requestContext, setOrgContext } from './context';

// Reexporta o contexto para os call sites existentes (guard, audit, portal,
// teleconsult, MFA...). O módulo de verdade é ./context (sem ciclo com db).
export { requestContext, setOrgContext };

const scrypt = promisify(rawScrypt);

export type Actor = { id:string; org_id:string; role:'admin'|'doctor'|'nurse'|'reception'; email:string; auth_version:number };
export const IS_PUBLIC_KEY = 'starmed:isPublic';
/** Marks a route as reachable without a session (health, login, MFA step-up, SSO callbacks). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export function requireRole(actor: Actor, allowed: Actor['role'][]) {
  if (!allowed.includes(actor.role)) throw new ForbiddenException('Insufficient role');
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(24).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return 'scrypt:' + salt + ':' + hash.toString('hex');
}
export async function verifyPassword(password: string, value: string): Promise<boolean> {
  const [kind,salt,hex] = value.split(':');
  if (kind!=='scrypt' || !salt || !hex || hex.length !== 128) return false;
  const found = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(Buffer.from(hex,'hex'), found);
}
const key = () => new TextEncoder().encode(env('AUTH_SECRET'));
const mfaStepLifetime = '5m';
export async function issueToken(actor: Actor) {
  return new SignJWT({role:actor.role,org:actor.org_id,ver:actor.auth_version})
    .setProtectedHeader({alg:'HS256'}).setSubject(actor.id)
    .setIssuer(env('AUTH_ISSUER')).setAudience(env('AUTH_AUDIENCE'))
    .setIssuedAt().setExpirationTime('4h').sign(key());
}
/** Short-lived token that only unlocks the MFA verification endpoints, never a session. */
export async function issueMfaStepToken(actor: Actor) {
  return new SignJWT({purpose:'mfa',role:actor.role,org:actor.org_id,ver:actor.auth_version})
    .setProtectedHeader({alg:'HS256'}).setSubject(actor.id)
    .setIssuer(env('AUTH_ISSUER')).setAudience(env('AUTH_AUDIENCE'))
    .setIssuedAt().setExpirationTime(mfaStepLifetime).sign(key());
}
export type MfaStepClaims = { id:string; org_id:string; auth_version:number };
export async function verifyMfaStepToken(token: string): Promise<MfaStepClaims> {
  const {payload} = await jwtVerify(token, key(), {issuer:env('AUTH_ISSUER'),audience:env('AUTH_AUDIENCE'),algorithms:['HS256']});
  if (payload.purpose !== 'mfa' || !payload.sub || typeof payload.org !== 'string' || typeof payload.ver !== 'number')
    throw new Error('Invalid MFA step token');
  return { id:payload.sub, org_id:payload.org, auth_version:payload.ver };
}
export type SessionUser = Actor & { display_name:string };
export async function sessionResponse(user: SessionUser) {
  return {
    accessToken: await issueToken(user),
    user: { id:user.id, displayName:user.display_name, role:user.role, orgId:user.org_id, email:user.email }
  };
}

/** AES-256-GCM sealing for TOTP secrets at rest (key derived from AUTH_SECRET via HKDF). */
const sealingKey = () => Buffer.from(hkdfSync('sha256', Buffer.from(env('AUTH_SECRET')), Buffer.from('starmed-mfa'), Buffer.from('secret-seal'), 32));
export function sealSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}
export function openSecret(sealed: string): string {
  const [version, ivB64, tagB64, ctB64] = sealed.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('Segredo selado malformado');
  const decipher = createDecipheriv('aes-256-gcm', sealingKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private db:Db, private reflector:Reflector) {}
  async canActivate(context:ExecutionContext):Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const req=context.switchToHttp().getRequest<any>();
    const value=req.headers?.authorization;
    if (!value || !/^Bearer\s+\S+$/i.test(value)) throw new UnauthorizedException();
    try {
      const token=value.replace(/^Bearer\s+/i,'');
      const {payload}=await jwtVerify(token,key(),{issuer:env('AUTH_ISSUER'),audience:env('AUTH_AUDIENCE'),algorithms:['HS256']});
      // Step-up tokens (MFA/SSO handoff) are scoped tokens and must never open a session.
      if (payload.purpose !== undefined) throw new Error('Scoped token cannot open a session');
      if (!payload.sub || typeof payload.org!=='string' || typeof payload.ver!=='number') throw new Error('Invalid claims');
      const user=await this.db.query<Actor & {active:boolean}>(
        'SELECT id,org_id,email,role,auth_version,active FROM users WHERE id=$1 AND org_id=$2',
        [payload.sub,payload.org]);
      const actor=user.rows[0];
      if (!actor || !actor.active || actor.auth_version!==payload.ver) throw new Error('Account revoked');
      setOrgContext(actor.org_id);
      req.actor=actor;
      return true;
    } catch { throw new UnauthorizedException('Invalid or expired session'); }
  }
}
export type QueryRunner = { query(sql:string, values?:any[]):Promise<any> };
export async function audit(db:QueryRunner, actor:Actor, action:string, targetType:string, targetId:string|null, details:Record<string,unknown>={}) {
  // O ator define o contexto de tenant (importa em rotas públicas com sessão
  // resolvida por segredo: login, MFA step-up, SSO) — e requestId do contexto
  // entra em TODOS os eventos (correlação). Nunca texto clínico — só metadados
  // passados pelos call sites.
  setOrgContext(actor.org_id);
  const store = requestContext.getStore();
  const enriched = store?.requestId ? { ...details, requestId: store.requestId } : details;
  await db.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',
     [actor.org_id,actor.id,action,targetType,targetId,JSON.stringify(enriched)]);
}
