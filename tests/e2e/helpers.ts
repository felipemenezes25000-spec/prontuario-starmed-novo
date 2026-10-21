/**
 * Contratos compartilhados das 3 jornadas E2E. Dados 100% sintéticos (nonces);
 * credenciais vindas do runner (E2E_ADMIN_*), CA de teste em E2E_CA_DIR.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { base32Decode, totpAt } from '../../apps/api/src/totp';

export const API_URL = (process.env.E2E_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || '';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || '';

export const DOCTOR_PASSWORD = 'E2e-Doctor-P4ssw0rd-2026';

export function nonce(): string {
  return randomUUID().slice(0, 8);
}

export function syntheticEmail(prefix: string): string {
  return `starmed-e2e-${prefix}-${nonce()}@example.invalid`;
}

type ApiOpts = {
  token?: string | null;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /** status exato esperado; quando omitido, qualquer 2xx serve. */
  expected?: number;
};

export async function api<T = unknown>(path: string, opts: ApiOpts = {}): Promise<T> {
  const { token, method = 'GET', body, headers = {}, expected } = opts;
  const response = await fetch(API_URL + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = (await response.json().catch(() => null)) as T | null;
  const wanted = expected ?? (response.ok ? response.status : -1);
  if (response.status !== wanted) {
    throw new Error(`${method} ${path}: esperado ${wanted}, veio ${response.status}: ${JSON.stringify(data)}`);
  }
  return data as T;
}

export type LoginResponse = { accessToken?: string; mfaRequired?: boolean; mfaToken?: string };

export function login(email: string, password: string, expected = 201): Promise<LoginResponse> {
  return api<LoginResponse>('/auth/login', { method: 'POST', body: { email, password }, expected });
}

/** Admin sintético já bootstrAPado pelo runner (organização descartável).
 *  Sessão cacheada no worker (workers:1): 4 specs ×1 login custaria 4 do
 *  orçamento de 10/15min do rate limit de /auth/login — com cache são 1. */
let cachedAdminToken: string | null = null;
export async function adminToken(): Promise<string> {
  if (cachedAdminToken) return cachedAdminToken;
  const session = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!session.accessToken) throw new Error('login do admin não devolveu accessToken');
  cachedAdminToken = session.accessToken;
  return cachedAdminToken;
}

/** Cria um médico sintético (sem MFA) e devolve o e-mail usado. */
export async function createDoctor(admin: string, displayName: string): Promise<string> {
  const email = syntheticEmail('doctor');
  await api<{ id: string }>('/users', {
    token: admin,
    method: 'POST',
    body: { email, displayName: `${displayName} ${nonce()}`, role: 'doctor', password: DOCTOR_PASSWORD },
    expected: 201
  });
  return email;
}

/** TOTP válido para o relógio ATUAL (janela de30s do RFC 6238). */
export function totpNow(secretBase32: string): string {
  return totpAt(base32Decode(secretBase32), Date.now());
}

/** PEMs da CA de teste (gerada por scripts/e2e/gen-e2e-ca.ts antes da API subir). */
export function caFiles(): { signerCertPem: string; privateKeyPkcs8Pem: string; rootPem: string } {
  const dir = process.env.E2E_CA_DIR;
  if (!dir) throw new Error('E2E_CA_DIR ausente — o runner deve gerar a CA antes do Playwright');
  return {
    signerCertPem: readFileSync(resolve(dir, 'leaf.pem'), 'utf8'),
    privateKeyPkcs8Pem: readFileSync(resolve(dir, 'leaf-key.pem'), 'utf8'),
    rootPem: readFileSync(resolve(dir, 'root.pem'), 'utf8')
  };
}
