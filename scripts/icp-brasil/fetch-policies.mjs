#!/usr/bin/env node
/**
 * Materializa as Políticas de Assinatura (LPA) PAdES do ICP-Brasil:
 *   PA_PAdES_AD_RB_v1_3.der  (Referência Básica — assinatura sem carimbo de ACT)
 *   PA_PAdES_AD_RT_v1_3.der  (Referência de Tempo — exige carimbo de ACT)
 *
 * Fonte oficial: https://politicas.icpbrasil.gov.br/ — versões PAdES 1.3
 * vigentes desde 23/07/2025. O SHA-256 de cada política é conferido contra o
 * arquivo de hash publicado pelo próprio ITI; qualquer divergência aborta.
 *
 * Uso: node scripts/icp-brasil/fetch-policies.mjs [--listar]
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeLeaf, collectAiaChain, httpGet } from './lib/icp-net.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEST = process.env.ICP_BRASIL_POLICIES_DIR || join(REPO_ROOT, 'certs', 'icp-brasil', 'policies');
const BASE = 'https://politicas.icpbrasil.gov.br';
const HOST = 'politicas.icpbrasil.gov.br';
const POLICIES = [
  { der: 'PA_PAdES_AD_RB_v1_3.der', hashFile: 'PA_PAdES_AD_RB_v1_3der-sha256.txt', profile: 'AD-RB v1.3' },
  { der: 'PA_PAdES_AD_RT_v1_3.der', hashFile: 'PA_PAdES_AD_RT_v1_3der-sha256.txt', profile: 'AD-RT v1.3' }
];

const msg = (m) => process.stderr.write(m + '\n');
const fail = (m) => { process.stderr.write('\nERRO: ' + m + '\n'); process.exit(1); };

async function main() {
  const listOnly = process.argv.includes('--listar');
  msg('Políticas de Assinatura PAdES (LPA) do ICP-Brasil:');
  for (const p of POLICIES) msg(`  · ${BASE}/${p.der} (${p.profile})`);
  if (listOnly) { msg('--listar: nenhum arquivo foi alterado.'); return; }

  msg('\nCompletando a cadeia TLS pelo AIA…');
  const leaf = await probeLeaf(HOST).catch((e) => fail(e.message));
  const extraCas = await collectAiaChain(leaf).catch((e) => fail(e.message));
  const tlsOptions = { ca: [...(await import('node:tls')).rootCertificates, ...extraCas] };

  await mkdir(DEST, { recursive: true });
  for (const p of POLICIES) {
    msg(`Baixando ${p.der}…`);
    const der = await httpGet(`${BASE}/${p.der}`, tlsOptions).catch((e) => fail(e.message));
    const hashText = await httpGet(`${BASE}/${p.hashFile}`, tlsOptions).catch((e) => fail(e.message));
    const expected = (hashText.toString('utf8').match(/[0-9A-Fa-f]{64}/) || [])[0];
    if (!expected) fail(`o arquivo oficial de hash de ${p.profile} não contém SHA-256 válido`);
    const actual = createHash('sha256').update(der).digest('hex').toUpperCase();
    if (actual !== expected.toUpperCase())
      fail(`SHA-256 da política ${p.profile} diverge do valor publicado pelo ITI: esperado=${expected} calculado=${actual}`);
    await writeFile(join(DEST, p.der), der);
    await writeFile(join(DEST, p.der + '.sha256'), `${actual}  ${p.der}\n`, 'utf8');
    msg(`  OK: ${p.der}  SHA-256: ${actual}`);
  }
  msg(`\nPolíticas instaladas e verificadas em: ${DEST}`);
}
main().catch((e) => fail(e.message));
