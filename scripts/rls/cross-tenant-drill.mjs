#!/usr/bin/env node
/**
 * Drill E2E de isolamento multi-tenant (cross-tenant):
 * cria uma segunda organização direto no banco, loga como usuário das DUAS orgs
 * pela API e prova que nenhum recurso vaza entre elas (404, nunca 200/403 com corpo).
 * Banco/API DEVEM ser descartáveis (STARMED_TEST_DB=true).
 *
 * Uso:
 *   STARMED_TEST_DB=true node scripts/rls/cross-tenant-drill.mjs \
 *     --api http://127.0.0.1:3102 --url <DATABASE_URL da org A> --email <admin org A> --password <senha>
 */
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { Client } from 'pg';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const API = flag('--api') || 'http://127.0.0.1:3102';
const log = (m) => process.stderr.write(m + '\n');
const fail = (m) => { log('DRILL FALHOU: ' + m); process.exit(1); };

if (process.env.STARMED_TEST_DB !== 'true') fail('defina STARMED_TEST_DB=true (banco descartável)');
const adminEmail = flag('--email');
const adminPassword = flag('--password');
const dbUrl = flag('--url') || process.env.DATABASE_URL;
if (!adminEmail || !adminPassword || !dbUrl) fail('--email, --password e --url são obrigatórios');

async function login(email, password) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!r.ok) throw new Error(`login ${email}: HTTP ${r.status}`);
  return (await r.json()).accessToken;
}

async function get(path, token) {
  const r = await fetch(`${API}${path}`, { headers: { authorization: 'Bearer ' + token } });
  return r.status;
}

function scryptHash(password) {
  const salt = randomBytes(24).toString('hex');
  return 'scrypt:' + salt + ':' + scryptSync(password, salt, 64).toString('hex');
}

async function main() {
  const nonce = randomUUID().slice(0, 8);
  const created = {};
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const suffix = `drill-${nonce}`;
  try {
    // 1. Segunda organização + doctor + paciente via SQL direto (fora da API).
    // Leituras FHIR exigem papel doctor/nurse — usamos doctor dos dois lados.
    const org = (await db.query('INSERT INTO organizations(name) VALUES($1) RETURNING id', [`Org B ${suffix}`])).rows[0];
    created.orgId = org.id;
    const orgBEmail = `doctor-org-b-${suffix}@example.invalid`;
    const orgBPassword = 'OrgB-drill-' + randomUUID();
    await db.query(
      'INSERT INTO users(org_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [org.id, orgBEmail, 'Doctor Org B', 'doctor', scryptHash(orgBPassword)]);
    const patientB = (await db.query(
      'INSERT INTO patients(org_id,full_name,birth_date) VALUES($1,$2,$3) RETURNING id',
      [org.id, `Paciente Org B ${suffix}`, '1990-01-01'])).rows[0];
    log(`Org B criada (${org.id}) com paciente ${patientB.id}`);

    // 2. Paciente na org A (via API, com o admin informado) + doctor da org A para as buscas.
    const tokenA = await login(adminEmail, adminPassword);
    const doctorAPassword = 'OrgA-drill-' + randomUUID();
    const createdDoctor = await fetch(`${API}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokenA },
      body: JSON.stringify({ email: `doctor-org-a-${suffix}@example.invalid`, displayName: 'Doctor Org A', role: 'doctor', password: doctorAPassword })
    });
    if (createdDoctor.status !== 201) throw new Error(`criar doctor org A: HTTP ${createdDoctor.status}`);
    const doctorAToken = await login(`doctor-org-a-${suffix}@example.invalid`, doctorAPassword);
    const createdA = await fetch(`${API}/patients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + doctorAToken },
      body: JSON.stringify({ fullName: `Paciente Org A ${suffix}`, birthDate: '1991-02-02' })
    });
    if (createdA.status !== 201) throw new Error(`criar paciente org A: HTTP ${createdA.status}`);
    const patientA = await createdA.json();

    // 3. Doctor da org A NÃO vê o paciente da org B.
    const detailB = await get(`/fhir/R4/Patient/${patientB.id}`, doctorAToken);
    if (detailB !== 404) fail(`org A acessou recurso da org B (HTTP ${detailB}); isolamento vazou`);
    log('OK: org A não enxerga recursos da org B (404)');

    // 4. Usuário da org B vê só o seu.
    const tokenB = await login(orgBEmail, orgBPassword);
    const ownDetail = await get(`/fhir/R4/Patient/${patientB.id}`, tokenB);
    if (ownDetail !== 200) fail(`org B não acessou o próprio recurso (HTTP ${ownDetail})`);
    const foreignDetail = await get(`/fhir/R4/Patient/${patientA.id}`, tokenB);
    if (foreignDetail !== 404) fail(`org B acessou recurso da org A (HTTP ${foreignDetail}); isolamento vazou`);
    log('OK: org B acessa o próprio recurso (200) e não enxerga o da org A (404)');

    log('\nDRILL PASSOU: isolamento cross-tenant verificado de ponta a ponta pela API.');
  } finally {
    // Cleanup best-effort por ID direto: audit_events é append-only (por design), então
    // remoções podem ser bloqueadas por FK — aceitável porque o banco é descartável.
    if (created.orgId) {
      for (const [sql, param] of [
        ['DELETE FROM patients WHERE org_id=$1', created.orgId],
        ['DELETE FROM users WHERE org_id=$1', created.orgId],
        ['DELETE FROM organizations WHERE id=$1', created.orgId]
      ]) {
        await db.query(sql, [param]).catch((e) => log(`cleanup pulou: ${e.message.split('\n')[0]}`));
      }
    }
    await db.end();
    log('Organização de teste removida (ou banco descartável retém o resíduo).');
  }
}
main().catch((e) => fail(e.message));
