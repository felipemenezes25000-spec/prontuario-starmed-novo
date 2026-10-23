import { ConflictException, Controller, ForbiddenException, Get, Injectable, Query, Res, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Db } from './db';
import { primaryWebOrigin } from './web-origin';
import { role as roleSchema } from './domain';
import { Actor, Public, audit, hashPassword, sessionResponse, sha256Hex } from './security';

/** Structural subset of the Express response used by the SSO callback. */
type HttpResponse = { status(code:number):HttpResponse; json(body:unknown):unknown; redirect(url:string):unknown };

/**
 * OIDC single sign-on (authorization code + PKCE). SSO is optional and only
 * active when OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI are configured.
 * Account linking is by (issuer, subject) with e-mail fallback; auto-provisioning
 * is opt-in via SSO_AUTO_PROVISION=true and defaults to a non-clinical role.
 */

export type OidcConfig = { issuer:string; clientId:string; clientSecret?:string; redirectUri:string; scopes:string };
export type OidcDiscovery = {
  issuer:string; authorization_endpoint:string; token_endpoint:string; jwks_uri:string;
  id_token_signing_alg_values_supported?:string[];
};

export function ssoConfigFromEnv(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const redirectUri = process.env.OIDC_REDIRECT_URI;
  if (!issuer || !clientId || !redirectUri) return null;
  return {
    issuer, clientId, redirectUri,
    clientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
    scopes: process.env.OIDC_SCOPES || 'openid email profile'
  };
}

export function pkcePair(): { verifier:string; challenge:string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizationUrl(discovery: Pick<OidcDiscovery,'authorization_endpoint'>, params: {
  clientId:string; redirectUri:string; state:string; nonce:string; codeChallenge:string; scopes:string;
}): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scopes);
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

@Injectable()
export class OidcService {
  private cached: { discovery:OidcDiscovery; fetchedAt:number } | null = null;
  constructor(private db: Db) {}
  config(): OidcConfig {
    const config = ssoConfigFromEnv();
    if (!config) throw new ConflictException('SSO não configurado neste ambiente');
    return config;
  }
  async discover(config: OidcConfig): Promise<OidcDiscovery> {
    if (this.cached && Date.now() - this.cached.fetchedAt < 600_000) return this.cached.discovery;
    const response = await fetch(new URL('/.well-known/openid-configuration', config.issuer), {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new ConflictException('Provedor OIDC indisponível');
    const discovery = await response.json() as OidcDiscovery;
    if (discovery.issuer !== config.issuer || !discovery.authorization_endpoint || !discovery.token_endpoint || !discovery.jwks_uri)
      throw new ConflictException('Discovery OIDC inválido');
    this.cached = { discovery, fetchedAt: Date.now() };
    return discovery;
  }
  async createFlow(stateHash:string, nonce:string, verifier:string, redirectUri:string) {
    await this.db.query('DELETE FROM sso_flows WHERE expires_at < now()');
    await this.db.query(
      'INSERT INTO sso_flows(state_hash,nonce,code_verifier,redirect_uri,expires_at) VALUES($1,$2,$3,$4,now()+interval \'10 minutes\')',
      [stateHash, nonce, verifier, redirectUri]);
  }
  async consumeFlow(stateHash:string) {
    const r = await this.db.query<any>(
      'UPDATE sso_flows SET consumed_at=now() WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING nonce,code_verifier,redirect_uri',
      [stateHash]);
    return r.rows[0] ?? null;
  }
  async exchangeCode(config:OidcConfig, discovery:OidcDiscovery, params:{code:string; redirectUri:string; verifier:string}) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code: params.code,
      redirect_uri: params.redirectUri, code_verifier: params.verifier
    });
    const headers: Record<string,string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (config.clientSecret && (process.env.OIDC_CLIENT_AUTH || 'basic') === 'basic') {
      headers.authorization = 'Basic ' + Buffer.from(config.clientId + ':' + config.clientSecret).toString('base64');
    } else {
      form.set('client_id', config.clientId);
      if (config.clientSecret) form.set('client_secret', config.clientSecret);
    }
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST', headers, body: form.toString(), signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new UnauthorizedException('Troca de código SSO recusada');
    return await response.json() as { id_token?:string; access_token?:string };
  }
  async verifyIdToken(discovery:OidcDiscovery, config:OidcConfig, idToken:string, expectedNonce:string): Promise<{sub:string; email?:string}> {
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: config.issuer, audience: config.clientId,
      algorithms: discovery.id_token_signing_alg_values_supported?.filter(a=>['RS256','PS256','ES256','EdDSA'].includes(a)) ?? ['RS256','PS256','ES256','EdDSA']
    });
    if (payload.nonce !== expectedNonce) throw new UnauthorizedException('Nonce SSO não confere');
    if (!payload.sub) throw new UnauthorizedException('ID token sem subject');
    return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined };
  }
  async resolveUser(issuer:string, sub:string, email:string|undefined, actorForAudit:Actor|null) {
    const bySub = await this.db.query<any>('SELECT * FROM users WHERE sso_issuer=$1 AND sso_subject=$2 AND active=true', [issuer, sub]);
    if (bySub.rowCount) return bySub.rows[0];
    if (email) {
      const byEmail = await this.db.query<any>('SELECT * FROM users WHERE lower(email)=lower($1) AND active=true', [email]);
      if (byEmail.rowCount) {
        await this.db.query('UPDATE users SET sso_issuer=$2, sso_subject=$3 WHERE id=$1', [byEmail.rows[0].id, issuer, sub]);
        await audit(this.db, actorForAudit ?? byEmail.rows[0], 'auth.sso.linked', 'user', byEmail.rows[0].id);
        return byEmail.rows[0];
      }
    }
    if (process.env.SSO_AUTO_PROVISION !== 'true' || !email) throw new ForbiddenException('Conta não provisionada para SSO');
    const role = roleSchema.safeParse(process.env.SSO_DEFAULT_ROLE || 'reception');
    if (!role.success) throw new ConflictException('SSO_DEFAULT_ROLE inválido');
    const created = await this.db.query<any>(
      `INSERT INTO users(org_id,email,display_name,role,password_hash,sso_issuer,sso_subject)
       SELECT id,$2,$3,$4,$5,$6,$7 FROM organizations ORDER BY created_at LIMIT 1 RETURNING *`,
      [email.toLowerCase(), email, role.data, await hashPassword(randomBytes(32).toString('hex')), issuer, sub]);
    if (!created.rowCount) throw new ConflictException('Nenhuma organização cadastrada');
    await audit(this.db, actorForAudit ?? created.rows[0], 'auth.sso.provisioned', 'user', created.rows[0].id);
    return created.rows[0];
  }
}

@Controller('auth/sso')
export class SsoController {
  constructor(private db: Db, private oidc: OidcService) {}

  @Public()
  @Get('config')
  config() {
    const config = ssoConfigFromEnv();
    return config
      ? { enabled: true, issuer: config.issuer, clientId: config.clientId, scopes: config.scopes }
      : { enabled: false };
  }

  @Public()
  @Get('start')
  async start() {
    const config = this.oidc.config();
    const discovery = await this.oidc.discover(config);
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    await this.oidc.createFlow(sha256Hex(state), nonce, verifier, config.redirectUri);
    return {
      authorizationUrl: buildAuthorizationUrl(discovery, {
        clientId: config.clientId, redirectUri: config.redirectUri,
        state, nonce, codeChallenge: challenge, scopes: config.scopes
      })
    };
  }

  @Public()
  @Get('callback')
  async callback(
    @Res() res: HttpResponse,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('format') format?: string
  ) {
    const config = this.oidc.config();
    const asJson = format === 'json';
    const webCallback = process.env.SSO_WEB_CALLBACK || primaryWebOrigin() + '/auth/callback';
    const fail = (reason:string) => {
      if (asJson) return res.status(401).json({ statusCode: 401, message: reason });
      return res.redirect(webCallback + '#error=' + encodeURIComponent(reason));
    };
    try {
      if (error) return fail('SSO recusado pelo provedor');
      if (!code || !state) return fail('Parâmetros SSO ausentes');
      const flow = await this.oidc.consumeFlow(sha256Hex(state));
      if (!flow) return fail('State SSO inválido ou expirado');
      const discovery = await this.oidc.discover(config);
      const tokens = await this.oidc.exchangeCode(config, discovery, {
        code, redirectUri: flow.redirect_uri, verifier: flow.code_verifier
      });
      if (!tokens.id_token) return fail('Provedor não retornou id_token');
      const identity = await this.oidc.verifyIdToken(discovery, config, tokens.id_token, flow.nonce);
      const user = await this.oidc.resolveUser(config.issuer, identity.sub, identity.email, null);
      await audit(this.db, user as Actor, 'auth.sso.login', 'user', user.id);
      const session = await sessionResponse(user);
      if (asJson) return res.json({ ...session, sso: true });
      return res.redirect(webCallback + '#access_token=' + encodeURIComponent(session.accessToken) +
        '&token_type=Bearer&expires_in=14400&user=' + encodeURIComponent(JSON.stringify(session.user)));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Falha SSO';
      return fail(message);
    }
  }
}
