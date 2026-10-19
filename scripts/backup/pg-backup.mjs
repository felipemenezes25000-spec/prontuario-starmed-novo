#!/usr/bin/env node
/**
 * Backup StarMed (pg_dump em formato custom -Fc) com manifesto SHA-256 e retenção.
 * Executor: pg_dump do PATH do host OU `docker exec <container> pg_dump` via --docker.
 * A senha NUNCA aparece em log: a URL é redigida em todo output e manifesto.
 *
 * Uso:
 *   node scripts/backup/pg-backup.mjs --out backups [--url <DATABASE_URL>] [--docker <container>] [--retain N]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = resolve(flag('--out') || 'backups');
const DOCKER = flag('--docker');
const RETAIN = Number(flag('--retain') || 0);
const REDACT = (url) => url.replace(/\/\/([^@/]+)@/, '//***@');

function fail(msg) { process.stderr.write('ERRO: ' + msg + '\n'); process.exit(1); }

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`${cmd}: ${result.error.message}`);
  return result;
}

function dumpUrl() {
  const fromFlag = flag('--url');
  const url = fromFlag || process.env.DATABASE_URL;
  if (!url) fail('informe --url ou DATABASE_URL');
  return url;
}

function main() {
  const url = dumpUrl();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `starmed-backup-${stamp}.dump`);

  let result;
  if (DOCKER) {
    // pg_dump dentro do container; dump vai pelo stdout em BINÁRIO (sem encoding —
    // decodificar como UTF-8 corromperia o -Fc) e a URL entra por env.
    result = spawnSync('docker', ['exec', '-i', '-e', `PGURL=${url}`, DOCKER,
      'sh', '-c', 'pg_dump -Fc --no-owner --no-privileges "$PGURL"'], { maxBuffer: 256 * 1024 * 1024 });
    if (result.error) fail(`docker: ${result.error.message}`);
    if (result.status !== 0) fail(`pg_dump (docker ${DOCKER}) saiu com ${result.status}: ${(result.stderr || '').toString().slice(-500)}`);
    writeFileSync(file, result.stdout);
  } else {
    result = run('pg_dump', ['-Fc', '--no-owner', '--no-privileges', '-f', file, url]);
    if (result.status !== 0) fail(`pg_dump saiu com ${result.status}: ${(result.stderr || '').slice(-500)}`);
  }

  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(file + '.sha256', `${sha256}  ${file.split(/[\\/]/).pop()}\n`);
  const manifest = {
    createdAt: new Date().toISOString(),
    url: REDACT(url),
    file: file.split(/[\\/]/).pop(),
    bytes: bytes.length,
    sha256,
    executor: DOCKER ? `docker:${DOCKER}` : 'host'
  };
  writeFileSync(join(OUT, 'manifest-latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  process.stderr.write(`Backup OK: ${file} (${bytes.length} bytes)\nSHA-256: ${sha256}\n`);

  if (RETAIN > 0) {
    const dumps = readdirSync(OUT).filter((f) => f.startsWith('starmed-backup-') && f.endsWith('.dump'))
      .map((f) => ({ f, t: statSync(join(OUT, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of dumps.slice(RETAIN)) {
      unlinkSync(join(OUT, old.f));
      unlinkSync(join(OUT, old.f + '.sha256'));
      process.stderr.write(`Retenção: removido ${old.f}\n`);
    }
  }
}
main();
