/**
 * Rede para os servidores da ICP-Brasil: eles não enviam a intermediária TLS no
 * handshake. Este módulo completa a cadeia pelo AIA (CA Issuers) — mecanismo
 * padrão — e só aceita a conexão se ela fechar contra as raízes do sistema.
 * NUNCA usa TLS inseguro.
 */
import { X509Certificate } from 'node:crypto';
import { connect as tlsConnect, rootCertificates } from 'node:tls';
import { get as httpsGet } from 'node:https';
import { get as plainHttpGet } from 'node:http';

const INTERCEPTION_RE = /avast|kaspersky|bitdefender|eset|norton|mcafee|zscaler|netskope|fortinet|fortigate|palo alto|bluecoat|proxy|mitm|scanning|web\/mail shield/i;

/** Inspeciona o emissor TLS do host (teste de interceptação) e devolve a leaf. */
export function probeLeaf(host) {
  return new Promise((ok, bad) => {
    const socket = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const raw = socket.getPeerCertificate().raw;
      const issuer = JSON.stringify(socket.getPeerCertificate().issuer || {});
      socket.end();
      if (INTERCEPTION_RE.test(issuer)) return bad(new Error(`conexão HTTPS interceptada (emissor: ${issuer}); não é seguro materializar âncoras nesta rede`));
      ok(new X509Certificate(raw));
    });
    socket.on('error', bad);
    socket.setTimeout(15_000, () => { socket.destroy(); bad(new Error('timeout TLS')); });
  });
}

export function httpGet(url, options = {}) {
  return new Promise((ok, bad) => {
    const client = String(url).startsWith('https:') ? httpsGet : plainHttpGet;
    const request = client(url, { ...options, timeout: 60_000 }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        return ok(httpGet(new URL(response.headers.location, url).toString(), options));
      }
      if (status !== 200) { response.resume(); return bad(new Error(`falha ao baixar ${url}: HTTP ${status}`)); }
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => ok(Buffer.concat(chunks)));
    });
    request.on('error', bad);
    request.on('timeout', () => { request.destroy(new Error('timeout ao baixar ' + url)); });
  });
}

/** Sobe o AIA (CA Issuers) até fechar contra as raízes do sistema. Máx. 5 níveis. */
export async function collectAiaChain(leaf) {
  const extras = [];
  let current = leaf;
  for (let level = 0; level < 5; level++) {
    const aia = (current.infoAccess || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('CA Issuers'))
      .map((line) => (line.match(/URI:(\S+)/) || [])[1])
      .find(Boolean);
    if (!aia) break;
    const bytes = await httpGet(aia).catch(() => null);
    if (!bytes) break;
    let next;
    try { next = new X509Certificate(bytes); } catch { break; }
    extras.push(next.toString());
    if (next.subject === next.issuer) break;
    current = next;
  }
  return extras;
}

/** Download HTTPS com verificação completa: raízes do sistema + AIA. */
export async function secureGet(url) {
  const host = new URL(url).hostname;
  const leaf = await probeLeaf(host);
  const extraCas = await collectAiaChain(leaf);
  return httpGet(url, { ca: [...rootCertificates, ...extraCas] });
}
