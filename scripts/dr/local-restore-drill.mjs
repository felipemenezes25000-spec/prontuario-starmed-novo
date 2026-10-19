#!/usr/bin/env node
/**
 * Ensaio LOCAL e descartável de backup, restore e PITR (§25 da especificação-mãe).
 *
 * Prova mecânica, sem AWS e sem dado real:
 *   1. PostgreSQL 15 de origem com arquivamento de WAL → migrations + suíte de integração;
 *   2. backup base (pg_basebackup) para o PITR;
 *   3. pg_dump em formato custom → cifrado com AES-256-GCM (chave descartável) → decifrado e
 *      conferido por SHA-256 e pela tag GCM;
 *   4. restore num segundo PostgreSQL 15 vazio;
 *   5. impressão digital da origem e do restauro comparadas: linhas de TODAS as tabelas, RLS,
 *      índices, restrições, gatilhos, funções, políticas, sequências e MD5 do conteúdo das
 *      tabelas de evidência imutável e de auditoria;
 *   6. migrations + suíte de integração de novo no banco restaurado;
 *   7. PITR: dado gravado antes de um instante T, "exclusão indevida" depois de T, recuperação
 *      num terceiro PostgreSQL exatamente até T — o que veio antes volta, o que veio depois não;
 *   8. tempos por fase em JSON; resumo sem dado clínico em docs/release-evidence/dr/.
 *
 * Não mede RPO/RTO de AWS/RDS, rede, DNS, KMS ou volume de produção (productionClaim: false).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertShellSafeArgs } from './shell-args.mjs';
import {
  FINGERPRINT_SQL,
  checksumSql,
  compareFingerprints,
  decryptFile,
  encryptFile,
  evidenceTables,
  writeJson,
} from './fingerprint.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runId = `${Date.now()}-${process.pid}`;
const outDir = join(root, 'artifacts', 'dr');
const workDir = join(outDir, `work-${runId}`);
const evidenceDir = join(root, 'docs', 'release-evidence', 'dr');
const source = `renoveja-dr-source-${runId}`;
const target = `renoveja-dr-target-${runId}`;
const pitr = `renoveja-dr-pitr-${runId}`;
const volume = `renoveja-dr-volume-${runId}`;
const db = 'renoveja_dr';
const user = 'renoveja';
const password = `local_dr_${runId}`;
const image = 'postgres:15-alpine';
const skipIntegration = process.argv.includes('--sem-integracao');

const usaShell = process.platform === 'win32';

function run(command, args, options = {}) {
  // Falha alto se algum argumento fosse remontado errado pelo shell do Windows.
  // Ver scripts/dr/shell-args.mjs: é a armadilha que zerou o canário deste drill.
  assertShellSafeArgs(args, { command, shell: usaShell });

  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture
      ? [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
      : 'inherit',
    input: options.input,
    env: options.env ?? process.env,
    shell: usaShell,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ''}` : '';
    throw new Error(`${command} ${args.join(' ')} falhou com status ${result.status}.${detail}`);
  }
  return options.capture ? String(result.stdout ?? '').trim() : '';
}

/**
 * Roda SQL no container pela ENTRADA PADRÃO, nunca por `psql -c`.
 * `docker exec -i` encaminha stdin e o psql lê SQL de stdin por padrão, então nenhum
 * argumento carrega espaço e o comportamento é o mesmo em Windows e Linux.
 */
function psql(container, sql, extraArgs = []) {
  return run(
    'docker',
    ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-U', user, '-d', db, ...extraArgs],
    { capture: true, input: sql },
  );
}

const valor = (container, sql) => psql(container, sql, ['-tA']);

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Não foi possível reservar porta local.'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function connectionString(port) {
  return `Host=127.0.0.1;Port=${port};Database=${db};Username=${user};Password=${password};Pooling=false;Timeout=15`;
}

function startContainer(name, port) {
  run('docker', [
    'run', '-d',
    '--name', name,
    '-e', `POSTGRES_DB=${db}`,
    '-e', `POSTGRES_USER=${user}`,
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-p', `127.0.0.1:${port}:5432`,
    '-v', `${volume}:/dr`,
    image,
  ], { capture: true });
}

const pausa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function waitForPostgres(name, { writable = false } = {}) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const probe = spawnSync(
      'docker',
      ['exec', name, 'pg_isready', '-U', user, '-d', db],
      { encoding: 'utf8', stdio: 'ignore', shell: usaShell },
    );
    if (probe.status === 0) {
      if (!writable) return;
      try {
        if (valor(name, 'SELECT pg_is_in_recovery();') === 'f') return;
      } catch {
        /* ainda subindo */
      }
    }
    pausa(1000);
  }
  throw new Error(`PostgreSQL ${name} não ficou pronto em 180s.`);
}

function runIntegration(port) {
  run('node', ['scripts/run-integration-tests.mjs'], {
    env: {
      ...process.env,
      RENOVEJA_INTEGRATION_DB: connectionString(port),
      RENOVEJA_ALLOW_REMOTE_DB: '',
      RENOVEJA_ALLOW_REMOTE_INTEGRATION_DB: '',
    },
  });
}

function fingerprint(container, tabelasEvidencia) {
  const estrutura = JSON.parse(valor(container, FINGERPRINT_SQL));
  const conteudo = JSON.parse(valor(container, checksumSql(tabelasEvidencia)));
  return { ...estrutura, conteudo };
}

function cleanup() {
  for (const container of [source, target, pitr]) {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore', shell: usaShell });
  }
  spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore', shell: usaShell });
  rmSync(workDir, { recursive: true, force: true });
}

/** Script do terceiro contêiner: sobe o backup base e reaplica o WAL arquivado até o instante T. */
const PITR_SH = `#!/bin/sh
set -e
D=/var/lib/postgresql/pitr
mkdir -p "$D"
cp -a /dr/base/. "$D"/
rm -f "$D"/postmaster.pid
cat >> "$D"/postgresql.auto.conf <<EOF
archive_mode = 'off'
restore_command = 'cp /dr/wal/%f %p'
recovery_target_time = '$(cat /dr/pitr-target.txt)'
recovery_target_inclusive = false
recovery_target_action = 'promote'
EOF
touch "$D"/recovery.signal
chown -R postgres:postgres "$D"
chmod 700 "$D"
exec su-exec postgres postgres -D "$D"
`;

async function main() {
  if (process.env.RENOVEJA_INTEGRATION_DB || process.env.ConnectionStrings__DefaultConnection) {
    console.warn('Aviso: connection string externa do shell será ignorada. Este drill cria bancos locais próprios.');
  }

  run('docker', ['version'], { capture: true });
  run('dotnet', ['--version'], { capture: true });
  const gitSha = run('git', ['rev-parse', '--short', 'HEAD'], { capture: true });
  const tabelasEvidencia = evidenceTables(
    readFileSync(join(root, 'backend-dotnet/src/RenoveJa.Infrastructure/StarMed/StarMedHealthOsSchemaCatalog.cs'), 'utf8'),
  );

  const sourcePort = await freePort();
  const targetPort = await freePort();
  const evidence = {
    generatedAt: new Date().toISOString(),
    mode: 'local-disposable-restore-drill',
    gitSha,
    postgresImage: image,
    productionClaim: false,
    phases: {},
  };

  mkdirSync(workDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  run('docker', ['volume', 'create', volume], { capture: true });

  try {
    // ── origem com arquivamento de WAL ─────────────────────────────────────────────
    let t = Date.now();
    startContainer(source, sourcePort);
    waitForPostgres(source);
    run('docker', ['exec', source, 'mkdir', '-p', '/dr/wal'], { capture: true });
    run('docker', ['exec', source, 'chown', 'postgres:postgres', '/dr/wal'], { capture: true });
    psql(source, `ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_command = 'test ! -f /dr/wal/%f && cp %p /dr/wal/%f';
ALTER SYSTEM SET archive_timeout = '10s';`);
    run('docker', ['restart', source], { capture: true });
    waitForPostgres(source);
    evidence.phases.sourceBootMs = Date.now() - t;

    t = Date.now();
    if (!skipIntegration) runIntegration(sourcePort);
    else psql(source, 'CREATE TABLE public.dr_sem_integracao (id int primary key); INSERT INTO public.dr_sem_integracao SELECT generate_series(1, 1000);');
    evidence.phases.sourceMigrationAndIntegrationMs = Date.now() - t;

    // As tabelas do próprio ensaio moram em dr_ensaio, não em public. A suíte que roda de novo
    // no banco restaurado confere que toda tabela de public está no snapshot do esquema e no
    // catálogo de dados — e reprovaria, com razão, uma tabela que o produto não declara.
    const canary = `restore-canary-${runId}`;
    psql(source, `CREATE SCHEMA dr_ensaio;
CREATE TABLE dr_ensaio.restore_probe (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO dr_ensaio.restore_probe(id) VALUES ('${canary}');`);

    // ── backup base para o PITR ───────────────────────────────────────────────────
    t = Date.now();
    run('docker', ['exec', source, 'pg_basebackup', '-U', user, '-D', '/dr/base', '-Fp', '-Xs', '--checkpoint=fast'], { capture: true });
    evidence.phases.baseBackupMs = Date.now() - t;

    // ── dump lógico, cifrado e decifrado ─────────────────────────────────────────
    t = Date.now();
    run('docker', ['exec', source, 'pg_dump', '-U', user, '-d', db, '-Fc', '-Z', '6', '-f', '/dr/renoveja.dump'], { capture: true });
    evidence.phases.backupMs = Date.now() - t;

    t = Date.now();
    const plain = join(workDir, 'renoveja.dump');
    const cifrado = join(workDir, 'renoveja.dump.enc');
    const decifrado = join(workDir, 'renoveja.restore.dump');
    run('docker', ['cp', `${source}:/dr/renoveja.dump`, plain], { capture: true });
    const { key, manifest } = await encryptFile(plain, cifrado);
    rmSync(plain);
    run('docker', ['exec', source, 'rm', '-f', '/dr/renoveja.dump'], { capture: true });
    await decryptFile(cifrado, decifrado, key, manifest);
    evidence.phases.encryptDecryptVerifyMs = Date.now() - t;
    evidence.backupArtifact = {
      ...manifest,
      chave: 'descartável, só na memória do ensaio — nunca gravada',
    };

    // ── snapshot da origem para comparar ─────────────────────────────────────────
    t = Date.now();
    const fpOrigem = fingerprint(source, tabelasEvidencia);
    evidence.phases.sourceFingerprintMs = Date.now() - t;

    // ── restore num PostgreSQL vazio ─────────────────────────────────────────────
    t = Date.now();
    startContainer(target, targetPort);
    waitForPostgres(target);
    evidence.phases.targetBootMs = Date.now() - t;

    t = Date.now();
    run('docker', ['cp', decifrado, `${target}:/tmp/restore.dump`], { capture: true });
    run('docker', ['exec', target, 'pg_restore', '--no-owner', '--no-privileges', '-j', '4', '-U', user, '-d', db, '/tmp/restore.dump'], { capture: true });
    evidence.phases.restoreMs = Date.now() - t;

    const restoredCanary = valor(target, 'SELECT id FROM dr_ensaio.restore_probe LIMIT 1;');
    if (restoredCanary !== canary)
      throw new Error(`Canário de restore divergente: esperado ${canary}, obtido ${restoredCanary || '<vazio>'}`);

    t = Date.now();
    const fpRestauro = fingerprint(target, tabelasEvidencia);
    evidence.phases.targetFingerprintMs = Date.now() - t;
    const diffs = compareFingerprints(fpOrigem, fpRestauro);
    evidence.integrity = {
      fiel: diffs.length === 0,
      diferencas: diffs,
      objetos: fpOrigem.objetos,
      tabelasComparadas: Object.keys(fpOrigem.tabelas ?? {}).length,
      linhasComparadas: Object.values(fpOrigem.tabelas ?? {}).reduce((s, [n]) => s + Number(n), 0),
      sequenciasComparadas: Object.keys(fpOrigem.sequencias ?? {}).length,
      tabelasComConteudoConferido: Object.keys(fpOrigem.conteudo ?? {}).length,
      tabelasComRlsForcado: Object.values(fpOrigem.tabelas ?? {}).filter(([, , f]) => f).length,
    };
    if (diffs.length) throw new Error(`Restore infiel:\n${diffs.slice(0, 40).join('\n')}`);

    // RTO mecânico do caminho lógico: do backup cifrado ao banco íntegro e conferido.
    evidence.rtoLogicoMs =
      evidence.phases.encryptDecryptVerifyMs + evidence.phases.targetBootMs + evidence.phases.restoreMs + evidence.phases.targetFingerprintMs;

    t = Date.now();
    if (!skipIntegration) runIntegration(targetPort);
    evidence.phases.restoredMigrationAndIntegrationMs = Date.now() - t;

    // ── PITR: antes de T fica, depois de T some ─────────────────────────────────
    psql(source, `CREATE TABLE dr_ensaio.pitr_probe (id text PRIMARY KEY, fase text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE dr_ensaio.pitr_vitima (id int PRIMARY KEY, dado text NOT NULL);
INSERT INTO dr_ensaio.pitr_vitima SELECT g, md5(g::text) FROM generate_series(1, 5000) g;
INSERT INTO dr_ensaio.pitr_probe (id, fase) VALUES ('antes-1', 'antes'), ('antes-2', 'antes');`);
    pausa(1500);
    const instanteT = valor(source, "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00';");
    pausa(1500);
    const vitimaAntes = valor(source, 'SELECT count(*) || \':\' || md5(string_agg(dado, \'|\' ORDER BY id)) FROM dr_ensaio.pitr_vitima;');
    psql(source, `INSERT INTO dr_ensaio.pitr_probe (id, fase) VALUES ('depois-1', 'depois');
DELETE FROM dr_ensaio.pitr_vitima WHERE id % 2 = 0;
DROP TABLE dr_ensaio.restore_probe;
SELECT pg_switch_wal();`);
    // espera o arquivamento do último segmento
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ok = valor(source, "SELECT (last_archived_wal IS NOT NULL AND last_archived_time > now() - interval '5 minutes')::text FROM pg_stat_archiver;");
      const pendente = valor(source, 'SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE \'%.ready\';');
      if (ok === 'true' && pendente === '0') break;
      pausa(1000);
    }
    run('docker', ['exec', '-i', source, 'tee', '/dr/pitr-target.txt'], { capture: true, input: instanteT });
    run('docker', ['exec', '-i', source, 'tee', '/dr/pitr.sh'], { capture: true, input: PITR_SH });

    t = Date.now();
    run('docker', ['run', '-d', '--name', pitr, '-v', `${volume}:/dr`, '--entrypoint', 'sh', image, '/dr/pitr.sh'], { capture: true });
    waitForPostgres(pitr, { writable: true });
    evidence.phases.pitrRecoveryMs = Date.now() - t;

    const fases = valor(pitr, 'SELECT string_agg(id, \',\' ORDER BY id) FROM dr_ensaio.pitr_probe;');
    const vitimaDepois = valor(pitr, 'SELECT count(*) || \':\' || md5(string_agg(dado, \'|\' ORDER BY id)) FROM dr_ensaio.pitr_vitima;');
    const canarioVoltou = valor(pitr, 'SELECT count(*) FROM dr_ensaio.restore_probe;');
    const ultimoCommit = valor(pitr, "SELECT max(at) AT TIME ZONE 'UTC' FROM dr_ensaio.pitr_probe;");
    const pitrOk = fases === 'antes-1,antes-2' && vitimaDepois === vitimaAntes && canarioVoltou === '1';
    evidence.pitr = {
      instanteAlvoUtc: instanteT,
      ultimoRegistroRecuperadoUtc: ultimoCommit,
      registrosRecuperados: fases,
      exclusaoIndevidaDesfeita: vitimaDepois === vitimaAntes,
      tabelaApagadaDepoisDeTVoltou: canarioVoltou === '1',
      rtoPitrMs: evidence.phases.pitrRecoveryMs,
      ok: pitrOk,
    };
    if (!pitrOk)
      throw new Error(`PITR não voltou ao instante T: fases=${fases} vitima=${vitimaDepois} (esperado ${vitimaAntes}) canario=${canarioVoltou}`);

    evidence.canaryRestored = true;
    evidence.success = true;
    evidence.finishedAt = new Date().toISOString();
    evidence.totalMeasuredMs = Object.values(evidence.phases).reduce((sum, v) => sum + v, 0);
    evidence.interpretation =
      'Evidência local de recuperabilidade mecânica e de PITR. Não mede RPO/RTO de AWS/RDS, rede, secrets, DNS, KMS nem volume real de produção.';

    const output = join(outDir, `local-restore-drill-${runId}.json`);
    writeJson(output, evidence);
    const dia = evidence.generatedAt.slice(0, 10);
    writeJson(join(evidenceDir, `restore-drill-${dia}.json`), evidence);
    console.log(`Restore drill local concluído: ${relative(root, output)}`);
    console.log(`Integridade: ${evidence.integrity.tabelasComparadas} tabelas, ${evidence.integrity.linhasComparadas} linhas, ${evidence.integrity.tabelasComConteudoConferido} com conteúdo conferido — fiel.`);
    console.log(`PITR: ${fases} recuperados até ${instanteT}; RTO lógico ${evidence.rtoLogicoMs} ms; RTO PITR ${evidence.phases.pitrRecoveryMs} ms.`);
  } catch (error) {
    evidence.success = false;
    evidence.finishedAt = new Date().toISOString();
    evidence.error = error instanceof Error ? error.message : String(error);
    writeJson(join(outDir, `local-restore-drill-${runId}.json`), evidence);
    throw error;
  } finally {
    cleanup();
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
