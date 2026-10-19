import { X509Certificate } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Trust store ICP-Brasil para assinatura clínica.
 * Allowlist fixa de raízes (v4, v5, v6, v7, v12, v13) materializada por
 * `scripts/icp-brasil/fetch-roots.mjs`. Falha FECHADA: sem raízes válidas,
 * nenhuma cadeia é aceita (o legado não herdava raízes — erro conhecido).
 */
export class TrustStoreError extends Error {}

export class TrustStore {
  private readonly byFingerprint = new Map<string, X509Certificate>();
  private readonly bySubject = new Map<string, X509Certificate[]>();

  constructor(pems: string[], source = 'memória') {
    for (const pem of pems) {
      const cert = new X509Certificate(pem);
      const fp = cert.fingerprint256;
      if (!this.byFingerprint.has(fp)) this.byFingerprint.set(fp, cert);
      const list = this.bySubject.get(cert.subject) ?? [];
      list.push(cert);
      this.bySubject.set(cert.subject, list);
    }
    if (this.byFingerprint.size === 0)
      throw new TrustStoreError(`Trust store ICP-Brasil vazio (${source}). Falha fechada: sem raízes não há validação de cadeia. Rode scripts/icp-brasil/fetch-roots.mjs.`);
  }

  get size(): number { return this.byFingerprint.size; }
  get certs(): X509Certificate[] { return [...this.byFingerprint.values()]; }
  has(cert: X509Certificate): boolean { return this.byFingerprint.has(cert.fingerprint256); }
  issuersOf(subjectName: string): X509Certificate[] { return this.bySubject.get(subjectName) ?? []; }

  static fromDirectory(dir: string): TrustStore {
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.pem')); }
    catch { throw new TrustStoreError(`Diretório de trust store inacessível: ${dir}`); }
    const pems = files.map((f) => readFileSync(join(dir, f), 'utf8'));
    return new TrustStore(pems, dir);
  }

  private static cached: TrustStore | null = null;
  /** Trust store padrão: ICP_BRASIL_TRUST_STORE ou certs/icp-brasil/roots do repositório. */
  static default(): TrustStore {
    if (TrustStore.cached) return TrustStore.cached;
    const explicit = process.env.ICP_BRASIL_TRUST_STORE;
    const dir = explicit
      ? resolve(explicit)
      : resolve(__dirname, '..', '..', '..', '..', 'certs', 'icp-brasil', 'roots');
    TrustStore.cached = TrustStore.fromDirectory(dir);
    return TrustStore.cached;
  }
}
