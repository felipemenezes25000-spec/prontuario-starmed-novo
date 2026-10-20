#!/usr/bin/env node
/**
 * Orquestrador E2E (local e CI): sobe o ambiente COMPLETO das 3 jornadas
 * Playwright e derruba tudo ao final.
 *
 *   1. Exige banco DESCARTÁVEL (STARMED_TEST_DB=true) + DATABASE_URL.
 *   2. Gera a CA de teste (.e2e/) e aponta ICP_BRASIL_TRUST_STORE para ela —
 *      é o "parâmetro injetável" que habilita a assinatura PAdES POSITIVA.
 *   3. Migra + bootstrap (admin sintético).
 *   4. Build (API + Web com VITE_API_URL fixo) e sobe API (:3001) + web (:5174).
 *   5. Roda `npx playwright test` e propaga o exit code; encerra os filhos.
 *
 * Env obrigatório: DATABASE_URL, AUTH_SECRET, BOOTSTRAP_ADMIN_EMAIL/PASSWORD
 * (E2E_ADMIN_* são derivados dos BOOTSTRAP_* quando ausentes).
 * Opcionais: API_PORT (3001), E2E_WEB_PORT (5174), E2E_SKIP_BUILD=true.
 */
import { spawn, execSync } from 'node:child_process';
import { platform } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_PORT = process.env.API_PORT || '3001';
const WEB_PORT = process.env.E2E_WEB_PORT || '5174';
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

if (process.env.STARMED_TEST_DB !== 'true')
  throw new Error('run-e2e: defina STARMED_TEST_DB=true (banco DESCARTÁVEL) junto de DATABASE_URL');
if (!process.env.DATABASE_URL) throw new Error('run-e2e: DATABASE_URL ausente');

const children = [];
function run(cmd, extraEnv = {}, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, {
      cwd: opts.cwd ?? REPO, shell: true, stdio: opts.quiet ? 'pipe' : 'inherit',
      env: { ...process.env, ...extraEnv }
    });
    children.push(child);
    let out = '';
    if (opts.quiet) {
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { out += d; });
    }
    child.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(`${cmd} → exit ${code}\n${out}`))));
    child.on('error', rej);
  });
}
async function waitFor(url, tries = 90, checkAlive) {
  for (let i = 1; i <= tries; i++) {
    if (checkAlive) checkAlive(); // processo morreu → falhar AGORA com o log, não em timeout
    try { const r = await fetch(url); if (r.ok) return; } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout aguardando ${url}`);
}
/** Porta HTTP já respondendo ANTES de subir = zumbi de um run anterior. */
async function assertPortFree(url, label) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    throw new Error(`${label} (${url}) já responde: processo de um run anterior ainda de pé. Mate-o antes de rodar o E2E (senão os testes rodam contra o código antigo).`);
  } catch (e) {
    if (String(e?.message ?? '').includes('run anterior')) throw e;
    // conexão recusada/timeout → porta livre
  }
}
/**
 * Teardown SÍNCRONO: antes, um spawn assíncrono de taskkill era morto pelo
 * process.exit imediato → API/preview zumbis seguravam as portas e o run seguinte
 * falhava em silêncio (EADDRINUSE no spawn não detectado) testando contra o
 * BUILD ANTIGO. No Windows o Windows já não garante kill de árvore via SIGTERM.
 */
function killAll() {
  for (const c of children) {
    try {
      if (platform() === 'win32') execSync(`taskkill /T /F /PID ${c.pid}`, { stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch { /* já morto */ }
  }
}

const e2eEnv = {
  ICP_BRASIL_TRUST_STORE: resolve(REPO, '.e2e', 'trust'),
  WEB_ORIGIN: WEB_URL,
  API_PORT,
  VITE_API_URL: API_URL,
  E2E_API_URL: API_URL,
  E2E_WEB_URL: WEB_URL,
  E2E_ADMIN_EMAIL: process.env.E2E_ADMIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD,
  E2E_CA_DIR: resolve(REPO, '.e2e', 'ca'),
  NODE_ENV: 'test'
};

let exitCode = 1;
let apiLog = '';
let webLog = '';
try {
  console.log('[e2e] 1/6 CA de teste + trust store injetável');
  await run('npx tsx scripts/e2e/gen-e2e-ca.ts .e2e');

  console.log('[e2e] 2/6 migrações (fail-closed) + bootstrap sintético');
  await run('npm run migrate -w @starmed/api');
  await run('npm run bootstrap -w @starmed/api');

  if (process.env.E2E_SKIP_BUILD !== 'true') {
    console.log('[e2e] 3/6 build API + Web (VITE_API_URL fixo)');
    await run('npm run build', { VITE_API_URL: API_URL });
  } else {
    console.log('[e2e] 3/6 build pulado (E2E_SKIP_BUILD=true)');
  }

  console.log('[e2e] 4/6 subir API e aguardar /health');
  await assertPortFree(`${API_URL}/health`, 'porta da API');
  const api = spawn('npm run start -w @starmed/api', {
    cwd: REPO, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...e2eEnv }
  });
  children.push(api);
  api.stdout.on('data', (d) => { apiLog += d; });
  api.stderr.on('data', (d) => { apiLog += d; });
  await waitFor(`${API_URL}/health`, 90, () => {
    if (api.exitCode !== null) throw new Error(`API encerrou cedo (exit ${api.exitCode}) — provável EADDRINUSE/log de build.\n${apiLog.slice(-4000)}`);
  });

  console.log('[e2e] 5/6 servir web (vite preview) e aguardar');
  await assertPortFree(WEB_URL, 'porta da web');
  const web = spawn(`npx vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`, {
    cwd: resolve(REPO, 'apps', 'web'), shell: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...e2eEnv }
  });
  children.push(web);
  web.stdout.on('data', (d) => { webLog += d; });
  web.stderr.on('data', (d) => { webLog += d; });
  await waitFor(WEB_URL, 90, () => {
    if (web.exitCode !== null) throw new Error(`preview da web encerrou cedo (exit ${web.exitCode}).\n${webLog.slice(-2000)}`);
  });

  console.log('[e2e] 6/6 playwright test');
  await run('npx playwright test --config tests/e2e/playwright.config.ts', e2eEnv);
  exitCode = 0;
} catch (e) {
  console.error(e.message ?? e);
  exitCode = 1;
} finally {
  if (apiLog) console.log(`\n[e2e] --- tail do log da API ---\n${apiLog.slice(-6000)}`);
  if (webLog) console.log(`\n[e2e] --- tail do log da web ---\n${webLog.slice(-3000)}`);
  killAll();
}
process.exit(exitCode);
