#!/usr/bin/env node
/**
 * Restore drill (DR): restaura um dump -Fc em banco temporário e roda queries smoke.
 * Executor: psql/pg_restore do PATH do host OU `docker exec` (--docker <container>,
 * usando socket interno como usuário postgres — sem credenciais no comando).
 * O banco temporário é REMOVIDO ao final, mesmo em falha.
 *
 * Uso:
 *   node scripts/backup/restore-verify.mjs --dump <file.dump> [--docker <container>] [--url <admin DATABASE_URL>]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DUMP = flag('--dump');
const DOCKER = flag('--docker');
const ADMIN_URL = flag('--url') || process.env.DATABASE_URL;
const RESTORE_DB = 'starmed_restore_verify';

const log = (m) => process.stderr.write(m + '\n');
const fail = (m) => { log('ERRO: ' + m); process.exit(1); };
if (!DUMP) fail('--dump é obrigatório');
if (!DOCKER && !ADMIN_URL) fail('modo host exige --url ou DATABASE_URL (modo --docker usa socket do container)');

function run(cmd, cmdArgs, input) {
  const r = spawnSync(cmd, cmdArgs, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  return r;
}

function psql(sql) {
  return DOCKER
    ? run('docker', ['exec', '-i', DOCKER, 'psql', '-U', 'postgres', '-At', '-c', sql])
    : run('psql', [ADMIN_URL, '-At', '-c', sql]);
}

function restore() {
  const dumpBytes = readFileSync(resolve(DUMP));
  return DOCKER
    ? run('docker', ['exec', '-i', DOCKER, 'pg_restore', '-U', 'postgres', '-Fc', '--no-owner', '--no-privileges', '-d', RESTORE_DB], dumpBytes)
    : (() => {
        const serverBase = ADMIN_URL.replace(/\/[^/?]*$/, '');
        return run('pg_restore', ['-Fc', '--no-owner', '--no-privileges', '-d', `${serverBase}/${RESTORE_DB}`, resolve(DUMP)]);
      })();
}

function smoke() {
  const queries = [
    'SELECT count(*) FROM organizations',
    "SELECT to_regclass('clinical_notes') IS NOT NULL AS clinical_notes_exists",
    "SELECT to_regclass('audit_events') IS NOT NULL AS audit_events_exists"
  ];
  const out = [];
  for (const q of queries) {
    const r = DOCKER
      ? run('docker', ['exec', '-i', DOCKER, 'psql', '-U', 'postgres', '-d', RESTORE_DB, '-At', '-c', q])
      : (() => {
          const serverBase = ADMIN_URL.replace(/\/[^/?]*$/, '');
          return run('psql', [`${serverBase}/${RESTORE_DB}`, '-At', '-c', q]);
        })();
    if (r.status !== 0) fail(`query smoke falhou (${q}): ${r.stderr}`);
    out.push(`${q} => ${r.stdout.trim()}`);
  }
  return out;
}

function main() {
  log(`DROP/CREATE banco temporário ${RESTORE_DB}...`);
  psql(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
  const created = psql(`CREATE DATABASE ${RESTORE_DB}`);
  if (created.status !== 0) fail(`CREATE DATABASE falhou: ${created.stderr}`);
  let failed = false;
  try {
    log(`Restaurando ${DUMP}...`);
    const restoreResult = restore();
    if (restoreResult.status !== 0) fail(`pg_restore saiu com ${restoreResult.status}: ${(restoreResult.stderr || '').toString().slice(-800)}`);
    log('Queries smoke:');
    for (const line of smoke()) log('  ' + line);
    log('\nDRILL PASSOU: dump restaurado e schema íntegro.');
  } catch (e) {
    failed = true;
    log('DRILL FALHOU: ' + (e instanceof Error ? e.message : e));
  } finally {
    psql(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
    log(`Banco temporário ${RESTORE_DB} removido.`);
  }
  process.exit(failed ? 1 : 0);
}
main();
