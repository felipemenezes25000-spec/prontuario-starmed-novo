#!/usr/bin/env node
/**
 * Materializa o trust store ICP-Brasil SOMENTE com as AC Raiz adequadas a
 * certificados de assinatura clínica (allowlist fixa, revisão humana para
 * adicionar raízes novas — confiança não é auto-update).
 *
 * Fonte oficial: https://acraiz.icpbrasil.gov.br/credenciadas/RAIZ/
 * Allowlist: v4, v5, v6, v7 (v8/v9 revogadas, v10 SSL, v11 código), v12, v13.
 *
 * Para cada arquivo: valida X.509 legível, autoassinado, CA:TRUE, vigente;
 * converte para PEM canônico e grava manifest.sha256 + manifest.tsv.
 * O transporte usa verificação TLS completa (lib/icp-net.mjs: cadeia completada
 * pelo AIA e fechada contra as raízes do sistema — nunca TLS inseguro).
 *
 * Uso: node scripts/icp-brasil/fetch-roots.mjs [--listar]
 */
import { X509Certificate, createHash } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeLeaf, collectAiaChain, httpGet } from './lib/icp-net.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEST = process.env.ICP_BRASIL_TRUST_STORE || join(REPO_ROOT, 'certs', 'icp-brasil', 'roots');
const HOST = 'acraiz.icpbrasil.gov.br';
const BASE_URL = `https://${HOST}/credenciadas/RAIZ`;
const ROOT_FILES = ['ICP-Brasilv4.crt','ICP-Brasilv5.crt','ICP-Brasilv6.crt','ICP-Brasilv7.crt','ICP-Brasilv12.crt','ICP-Brasilv13.crt'];

const msg = (m) => process.stderr.write(m + '\n');
const fail = (m) => { process.stderr.write('\nERRO: ' + m + '\n'); process.exit(1); };

function validateCert(file, bytes) {
  let cert;
  try { cert = new X509Certificate(bytes); }
  catch { throw new Error(`${file} não é um certificado X.509 legível`); }
  if (cert.subject !== cert.issuer) throw new Error(`${file} não é autoassinado; recusando como AC Raiz`);
  if (!cert.ca) throw new Error(`${file} não declara CA:TRUE`);
  const now = Date.now();
  if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo))
    throw new Error(`${file} está expirado ou ainda não vigente; atualize a allowlist antes de prosseguir`);
  return cert;
}

async function main() {
  const listOnly = process.argv.includes('--listar');
  msg('Trust store ICP-Brasil aprovado para assinatura clínica:');
  for (const file of ROOT_FILES) msg(`  · ${BASE_URL}/${file}`);
  if (listOnly) { msg('--listar: nenhum arquivo foi alterado.'); return; }

  msg('\nConferindo o emissor TLS de ' + HOST + '…');
  const leaf = await probeLeaf(HOST).catch((e) => fail(e.message));
  msg('  assunto: ' + leaf.subject.split('\n')[0]);

  msg('Completando a cadeia TLS pelo AIA (CA Issuers)…');
  const extraCas = await collectAiaChain(leaf).catch((e) => fail(e.message));
  msg(`  intermediárias do AIA: ${extraCas.length} (a cadeia precisa fechar contra as raízes do sistema)`);

  await mkdir(DEST, { recursive: true });
  const manifestSha = ['# SHA-256 dos PEM oficiais após validação'];
  const manifestTsv = ['file\tsource\tsubject\tnot_before\tnot_after\tsha256_der'];
  for (const file of ROOT_FILES) {
    msg(`Baixando ${file}…`);
    const bytes = await httpGet(`${BASE_URL}/${file}`, { ca: [...rootCertificates, ...extraCas] }).catch((e) => fail(e.message));
    const cert = validateCert(file, bytes);
    const pem = cert.toString();
    const name = file.replace(/\.crt$/, '.pem');
    await writeFile(join(DEST, name), pem, 'utf8');
    manifestSha.push(`${createHash('sha256').update(pem).digest('hex')}  ${name}`);
    manifestTsv.push([name, `${BASE_URL}/${file}`, cert.subject.replace(/\n/g, ', '), cert.validFrom, cert.validTo,
      createHash('sha256').update(bytes).digest('hex').toUpperCase()].join('\t'));
  }
  await writeFile(join(DEST, 'manifest.sha256'), manifestSha.join('\n') + '\n', 'utf8');
  await writeFile(join(DEST, 'manifest.tsv'), manifestTsv.join('\n') + '\n', 'utf8');
  msg(`\nTrust store gravado em ${DEST} (${ROOT_FILES.length} raízes).`);
  msg('Revise manifest.tsv (subjects/datas) antes de confiar: trust não é auto-update.');
}
main().catch((e) => fail(e.message));
