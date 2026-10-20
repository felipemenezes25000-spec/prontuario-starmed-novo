/**
 * Normalização de PEM de entrada EXTERNA (certificado colado pelo usuário,
 * arquivo de trust store). O OpenSSL embarcado no Node rejeita um PEM que tenha
 * linha vazia antes de -----END CERTIFICATE----- ("asn1 encoding routines::wrong
 * tag") — e exports de tokens/carteiras frequentemente trazem linhas vazias e
 * \r\n. Normalizar ANTES de parsear evita falha intermitente/engano em teste.
 */
export function normalizeCertificatePem(input: string): string {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const kept = lines.filter((l) => l.trim().length > 0);
  return kept.join('\n') + '\n';
}
