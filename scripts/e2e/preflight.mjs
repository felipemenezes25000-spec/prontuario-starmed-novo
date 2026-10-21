#!/usr/bin/env node
/**
 * Pré-setup de sessão do E2E (roda DEPOIS do bootstrap e da API de pé, ANTES
 * do Playwright): loga o admin UMA vez e cria o doctor de setup compartilhado,
 * imprimindo JSON que o runner injeta como env nos workers
 * (E2E_PRESET_ADMIN_TOKEN / E2E_PRESET_DOCTOR_EMAIL / E2E_PRESET_DOCTOR_TOKEN).
 *
 * Por que env e não cache em memória: o Playwright isola cada spec — um `let`
 * de módulo (ou até globalThis) pode nascer frio num bundle e estourar o
 * rate limit de /auth/login (10/15min por IP, contagem comprovada em run
 * anterior: 11 hits). Com env herdadO do runner, os logins ficam DETERMINÍSTICOS:
 * 2 aqui + 5 de UI + 1 de enroll MFA = 8/10.
 *
 * Saída no STDOUT: SOMENTE JSON (o runner faz parse).
 */
const api = (process.env.E2E_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const adminEmail = process.env.E2E_ADMIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const adminPassword = process.env.E2E_ADMIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
const doctorPassword = process.env.E2E_DOCTOR_PASSWORD || 'E2e-Doctor-P4ssw0rd-2026';
if (!adminEmail || !adminPassword) {
  console.error('preflight: E2E_ADMIN_EMAIL/PASSWORD (ou BOOTSTRAP_*) ausentes');
  process.exit(1);
}

async function post(path, body, token) {
  const r = await fetch(api + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`preflight ${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

const admin = await post('/auth/login', { email: adminEmail, password: adminPassword });
if (!admin.accessToken) throw new Error('preflight: admin sem accessToken');
const doctorEmail = `starmed-e2e-setup-${Date.now()}@example.invalid`;
await post('/users', { email: doctorEmail, displayName: 'Dr E2E Setup', role: 'doctor', password: doctorPassword }, admin.accessToken);
const doctor = await post('/auth/login', { email: doctorEmail, password: doctorPassword });
if (!doctor.accessToken) throw new Error('preflight: doctor sem accessToken');
process.stdout.write(JSON.stringify({
  adminToken: admin.accessToken,
  doctorEmail,
  doctorToken: doctor.accessToken
}));
