import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { createHmac, randomBytes, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { Db } from './db';
import { env } from './config';

const scrypt = promisify(rawScrypt);
export type Actor = { id:string; org_id:string; role:'admin'|'doctor'|'nurse'|'reception'; email:string; auth_version:number };
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
export async function issueToken(actor: Actor) {
  return new SignJWT({role:actor.role,org:actor.org_id,ver:actor.auth_version})
    .setProtectedHeader({alg:'HS256'}).setSubject(actor.id)
    .setIssuer(env('AUTH_ISSUER')).setAudience(env('AUTH_AUDIENCE'))
    .setIssuedAt().setExpirationTime('4h').sign(key());
}
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private db:Db) {}
  async canActivate(context:ExecutionContext):Promise<boolean> {
    const req=context.switchToHttp().getRequest<any>();
    if ((req.method==='GET' && req.path==='/health') || (req.method==='POST' && req.path==='/auth/login')) return true;
    const value=req.headers?.authorization;
    if (!value || !/^Bearer\s+\S+$/i.test(value)) throw new UnauthorizedException();
    try {
      const token=value.replace(/^Bearer\s+/i,'');
      const {payload}=await jwtVerify(token,key(),{issuer:env('AUTH_ISSUER'),audience:env('AUTH_AUDIENCE'),algorithms:['HS256']});
      if (!payload.sub || typeof payload.org!=='string' || typeof payload.ver!=='number') throw new Error('Invalid claims');
      const user=await this.db.query<Actor & {active:boolean}>(
        'SELECT id,org_id,email,role,auth_version,active FROM users WHERE id=$1 AND org_id=$2',
        [payload.sub,payload.org]);
      const actor=user.rows[0];
      if (!actor || !actor.active || actor.auth_version!==payload.ver) throw new Error('Account revoked');
      req.actor=actor;
      return true;
    } catch { throw new UnauthorizedException('Invalid or expired session'); }
  }
}
export async function audit(db:Db, actor:Actor, action:string, targetType:string, targetId:string|null, details:Record<string,unknown>={}) {
  await db.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',
     [actor.org_id,actor.id,action,targetType,targetId,JSON.stringify(details)]);
}
