import { X509Certificate } from 'node:crypto';
import { TrustStore } from './trust-store';

export type ChainErrorCode =
  | 'untrusted-root'    // cadeia não fecha contra o trust store
  | 'expired'           // algum certificado da cadeia fora da validade (em `at`)
  | 'bad-signature'     // assinatura do filho não confere com a chave pública do emissor
  | 'no-issuer'         // emissor ausente na cadeia apresentada
  | 'not-ca'            // emissor intermediário sem basicConstraints CA:TRUE
  | 'depth-exceeded';   // cadeia mais longa que o limite

export type ChainValidation =
  | { ok: true; path: X509Certificate[]; anchor: X509Certificate; checkedAt: Date }
  | { ok: false; code: ChainErrorCode; reason: string; checkedAt: Date; path: X509Certificate[] };

const MAX_DEPTH = 8;

/**
 * Valida a cadeia do certificado raiz (`leaf`) contra o trust store.
 * Intermediários são oferecidos pela cadeia apresentada; a âncora DEVE estar
 * no trust store (comparação por fingerprint SHA-256, nunca por nome — lição do
 * legado: "INVALID TEST CA" passava por substring de nome).
 * `at` é injetável para teste de validade sem depender do relógio real.
 */
export function validateChain(
  leaf: X509Certificate,
  presented: X509Certificate[],
  trust: TrustStore,
  at: Date = new Date()
): ChainValidation {
  const path: X509Certificate[] = [leaf];
  const seen = new Set<string>([leaf.fingerprint256]);
  let current = leaf;

  const validityFailure = (cert: X509Certificate): ChainValidation | null => {
    const now = at.getTime();
    if (now < Date.parse(cert.validFrom)) return { ok: false, code: 'expired', reason: `certificado ainda não válido: ${cert.subject.split('\n')[0]} (válido desde ${cert.validFrom})`, checkedAt: at, path: [...path] };
    if (now > Date.parse(cert.validTo)) return { ok: false, code: 'expired', reason: `certificado expirado: ${cert.subject.split('\n')[0]} (venceu em ${cert.validTo})`, checkedAt: at, path: [...path] };
    return null;
  };

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const expired = validityFailure(current);
    if (expired) return expired;

    if (trust.has(current)) return { ok: true, path, anchor: current, checkedAt: at };

    const candidates = [...presented, ...trust.issuersOf(current.issuer)]
      .filter((c) => !seen.has(c.fingerprint256) && c.subject === current.issuer);
    if (candidates.length === 0) {
      const selfSigned = current.subject === current.issuer;
      return {
        ok: false,
        code: selfSigned ? 'untrusted-root' : 'no-issuer',
        reason: selfSigned
          ? `raiz não confiável: ${current.subject.split('\n')[0]}`
          : `emissor ausente na cadeia apresentada: ${current.issuer.split('\n')[0]}`,
        checkedAt: at, path: [...path]
      };
    }

    let progressed = false;
    for (const issuer of candidates) {
      let signatureOk = false;
      try { signatureOk = current.verify(issuer.publicKey); } catch { signatureOk = false; }
      if (!signatureOk) continue;
      if (!issuer.ca && depth > 0) {
        return { ok: false, code: 'not-ca', reason: `emissor intermediário sem CA:TRUE: ${issuer.subject.split('\n')[0]}`, checkedAt: at, path: [...path] };
      }
      seen.add(issuer.fingerprint256);
      path.push(issuer);
      current = issuer;
      progressed = true;
      break;
    }
    if (!progressed) {
      return { ok: false, code: 'bad-signature', reason: 'nenhum emissor da cadeia valida a assinatura do certificado filho', checkedAt: at, path: [...path] };
    }
  }
  return { ok: false, code: 'depth-exceeded', reason: `cadeia excede ${MAX_DEPTH} certificados`, checkedAt: at, path };
}
