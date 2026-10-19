#!/usr/bin/env node
/**
 * DAST autenticado das rotas do StarMed (OWASP ZAP `zap-api-scan.py`), um papel por varredura:
 * profissional, gestora e cidadão — as sessões da semente de carga (tests/load/starmed-seed.mjs).
 *
 *   node tests/load/starmed-seed.mjs            # banco local de teste, grava as sessões
 *   (API local em http://127.0.0.1:5005)
 *   node scripts/security/zap-starmed-auth.mjs  # prepara artifacts/zap-auth e imprime os comandos
 *
 * O que ele faz: baixa o OpenAPI da API local, recorta só /api/starmed, e escreve um arquivo de
 * configuração do ZAP por papel com (1) o cabeçalho Authorization da sessão, (2) um
 * X-Forwarded-For próprio — cada papel na sua partição do limitador por IP, que só confia nesse
 * cabeçalho vindo do loopback — e (3) valores reais para os ids de caminho mais comuns
 * (município, unidade, cidadão), para que as regras ativas passem da validação de rota e cheguem
 * ao código. Tudo em artifacts/ (fora do Git): os arquivos carregam token de sessão.
 *
 * Recusa alvo que não seja local: a sessão é de teste e o X-Forwarded-For forjado só é aceito do
 * loopback — apontar isso para outro ambiente seria varredura não autorizada.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const ROLES = [
  { role: 'clinician', ip: '198.18.100.1' },
  { role: 'manager', ip: '198.18.100.2' },
  { role: 'citizen', ip: '198.18.100.3' },
];

export function assertLocalTarget(url) {
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host))
    throw new Error(`RECUSADO: ${host}. O DAST autenticado usa sessão de teste e só roda contra API local.`);
}

/** Só as rotas do StarMed; o resto da API tem a sua varredura anônima. */
export function starmedOnly(openapi) {
  const paths = Object.fromEntries(Object.entries(openapi.paths ?? {}).filter(([p]) => p.startsWith('/api/starmed/')));
  return { ...openapi, paths };
}

/** Configuração do ZAP (formato -configfile) de um papel. */
export function zapConfig({ token, ip, ids }) {
  if (!token) throw new Error('sessão sem token');
  const lines = [];
  const replacer = (i, description, header, value) =>
    lines.push(
      `replacer.full_list(${i}).description=${description}`,
      `replacer.full_list(${i}).enabled=true`,
      `replacer.full_list(${i}).matchtype=REQ_HEADER`,
      `replacer.full_list(${i}).matchstr=${header}`,
      `replacer.full_list(${i}).regex=false`,
      `replacer.full_list(${i}).replacement=${value}`,
      `replacer.full_list(${i}).initiators=`,
    );
  replacer(0, 'auth', 'Authorization', `Bearer ${token}`);
  replacer(1, 'ip', 'X-Forwarded-For', ip);
  Object.entries(ids).forEach(([field, value], i) =>
    lines.push(
      `formhandler.fields.field(${i}).fieldId=${field}`,
      `formhandler.fields.field(${i}).value=${value}`,
      `formhandler.fields.field(${i}).enabled=true`,
      `formhandler.fields.field(${i}).regex=false`,
    ),
  );
  // Ritmo de uma pessoa usando a API, não de um ataque de volume: o limitador por IP é outro teste.
  lines.push('scanner.delayInMs=330', 'scanner.threadPerHost=1', 'scanner.maxScanDurationInMins=28', 'scanner.maxRuleDurationInMins=6');
  return `${lines.join('\n')}\n`;
}

export function pathIds(session) {
  return {
    institutionId: session.institutionId,
    healthUnitId: session.healthUnitId,
    patientUserId: session.patientUserIds[0],
    patientId: session.patientUserIds[0],
    userId: session.patientUserIds[1],
    competence: new Date().toISOString().slice(0, 7).replace('-', ''),
  };
}

async function main() {
  const base = process.env.BASE_URL ?? 'http://127.0.0.1:5005';
  assertLocalTarget(base);
  const session = JSON.parse(readFileSync(join(root, 'artifacts/load/starmed-session.json'), 'utf8'));
  const res = await fetch(`${base}/swagger/v1/swagger.json`);
  if (!res.ok) throw new Error(`OpenAPI indisponível em ${base} (${res.status})`);
  const out = join(root, 'artifacts/zap-auth');
  mkdirSync(out, { recursive: true });
  const spec = starmedOnly(await res.json());
  writeFileSync(join(out, 'starmed-openapi.json'), JSON.stringify(spec));
  const ids = pathIds(session);
  for (const { role, ip } of ROLES)
    writeFileSync(join(out, `zap-${role}.conf`), zapConfig({ token: session.tokens[role], ip, ids }));
  const port = new URL(base).port || '80';
  console.log(`${Object.keys(spec.paths).length} rotas do StarMed. Rode (Git Bash, MSYS_NO_PATHCONV=1):`);
  for (const { role } of ROLES)
    console.log(
      `docker run --rm --add-host=host.docker.internal:host-gateway -v "${out}:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable ` +
        `zap-api-scan.py -t /zap/wrk/starmed-openapi.json -f openapi -O http://host.docker.internal:${port} ` +
        `-r report-${role}.html -J report-${role}.json -w report-${role}.md -T 45 -z "-configfile /zap/wrk/zap-${role}.conf"`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
