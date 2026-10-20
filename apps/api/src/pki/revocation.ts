import { X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { PKIX_OIDS } from './iti-oids';
import { toArrayBuffer } from './buffer';

/**
 * Revogação de certificados via OCSP (RFC 6960) — capacidade NASCE DESLIGADA:
 * REVOCATION_MODE = off | soft | hard, default 'off' (CI/ambiente fechado nunca
 * chama rede; o padrão erra para "não verificado", NUNCA para "não revogado").
 *
 *   off  — nenhuma requisição; checked:false com motivo honesto;
 *   soft — consulta OCSP e REPORTA good|revoked|unknown|unavailable (não bloqueia);
 *   hard — além de reportar, 'revoked' e 'unknown' BLOQUEIAM a assinatura PAdES.
 *
 * O endpoint OCSP é extraído do AIA da leaf (PKIX_OIDS de iti-oids.ts, parse via
 * pkijs/asn1js já em dependencies); o pedido usa CertID SHA-256 com o emissor da
 * cadeia apresentada. A resposta é classificada por CertID (isForCertificate):
 * responder contestando outro certificado NUNCA conta como "good".
 *
 * LIMITAÇÕES HONESTAS (repetidas na resposta via `note`):
 *  - a assinatura da resposta OCSP NÃO é verificada (certificado do responder
 *    id-kp-OCSPSigning não é validado aqui) — pendência declarada;
 *  - nonce OCSP não é utilizado;
 *  - em modo hard, apenas 'revoked'/'unknown' bloqueiam; 'unavailable' é
 *    reportado sem bloquear (contrato do fluxo de prescrição).
 */

export type RevocationMode = 'off' | 'soft' | 'hard';
export type RevocationStatus = 'good' | 'revoked' | 'unknown' | 'unavailable';

export type RevocationCheck = {
  /** true SÓ quando uma resposta OCSP foi recebida e classificada para ESTE certificado. */
  checked: boolean;
  status: RevocationStatus | null;
  /** endpoint OCSP efetivamente consultado (AIA da leaf). */
  source: string | null;
  checkedAt: string | null;
  mode: RevocationMode;
  /** presente quando não houve consulta (checked:false) ou a resposta foi 'unavailable'. */
  reason?: string;
  /** presente quando revogado: generalizedTime do SingleResponse (quando parseável). */
  revokedAt?: string | null;
  /** limitação declarada (assinatura do responder OCSP não verificada). */
  note?: string;
};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

const OCSP_RESPONSE_STATUS_NAMES: Record<number, string> = {
  0: 'successful', 1: 'malformedRequest', 2: 'internalError', 3: 'tryLater', 5: 'sigRequired', 6: 'unauthorized'
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** REVOCATION_MODE do ambiente; valor desconhecido → desligado (fail-safe para CI). */
export function revocationModeFromEnv(raw: string | undefined = process.env.REVOCATION_MODE): RevocationMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'soft') return 'soft';
  if (value === 'hard') return 'hard';
  return 'off';
}

/** Extrai o endpoint OCSP (id-ad-ocsp no AIA) da leaf; null se ausente/ilegível. */
export function ocspEndpointFromCertificate(leaf: X509Certificate): string | null {
  try {
    const certificate = pkijs.Certificate.fromBER(toArrayBuffer(leaf.raw));
    const aia = (certificate.extensions?.extensions ?? [])
      .find((extension) => extension.extnID === PKIX_OIDS.AUTHORITY_INFO_ACCESS);
    if (!aia) return null;
    const info = aia.parsedValue as {
      accessDescriptions?: { accessMethod: string; accessLocation?: { type?: number; value?: unknown } }[];
    } | null | undefined;
    for (const description of info?.accessDescriptions ?? []) {
      if (description.accessMethod !== PKIX_OIDS.AD_OCSP) continue;
      // GeneralName [6] IA5String = URI do responder.
      if (description.accessLocation?.type === 6 && typeof description.accessLocation.value === 'string')
        return description.accessLocation.value;
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort: generalizedTime do primeiro SingleResponse com status revoked [1]. */
function revokedAtFrom(ocspResponse: pkijs.OCSPResponse): string | null {
  try {
    if (!ocspResponse.responseBytes) return null;
    const parsed = asn1js.fromBER(ocspResponse.responseBytes.response.valueBlock.valueHexView);
    const basic = new pkijs.BasicOCSPResponse({ schema: parsed.result });
    for (const single of basic.tbsResponseData.responses) {
      const certStatus = single.certStatus as {
        idBlock?: { isConstructed?: boolean; tagNumber?: number };
        valueBlock?: { value?: { value?: unknown }[] };
      } | null;
      if (certStatus?.idBlock?.isConstructed && certStatus.idBlock.tagNumber === 1) {
        const time = certStatus.valueBlock?.value?.[0];
        return typeof time?.value === 'string' ? time.value : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Consulta OCSP da leaf (endpoint do AIA, CertID SHA-256, timeout de 5 s por
 * padrão) e classifica good|revoked|unknown|unavailable. Nunca lança: falha de
 * rede/parse vira 'unavailable' com reason honesto. Com `mode='off'` (padrão)
 * NENHUM byte sai para a rede.
 */
export async function checkRevocation(params: {
  leaf: X509Certificate | null;
  issuer: X509Certificate | null;
  mode?: RevocationMode;
  timeoutMs?: number;
  fetchLike?: FetchLike;
}): Promise<RevocationCheck> {
  const mode = params.mode ?? revocationModeFromEnv();
  const now = () => new Date().toISOString();

  if (!params.leaf)
    return { checked: false, status: null, source: null, checkedAt: null, mode,
             reason: 'Certificado do assinante ausente: revogação não verificável.' };
  if (mode === 'off')
    return { checked: false, status: null, source: null, checkedAt: null, mode,
             reason: 'REVOCATION_MODE=off (padrão): consulta OCSP não executada — o certificado NÃO foi verificado contra revogação.' };

  const source = ocspEndpointFromCertificate(params.leaf);
  if (!source)
    return { checked: false, status: 'unavailable', source: null, checkedAt: now(), mode,
             reason: 'Certificado sem endpoint OCSP no AIA (Authority Information Access / id-ad-ocsp).' };
  if (!params.issuer)
    return { checked: false, status: 'unavailable', source, checkedAt: now(), mode,
             reason: 'Emissor indisponível na cadeia: impossível montar o CertID (issuerNameHash/issuerKeyHash) do pedido OCSP.' };

  let request: Uint8Array;
  try {
    const ocspRequest = new pkijs.OCSPRequest();
    await ocspRequest.createForCertificate(
      pkijs.Certificate.fromBER(toArrayBuffer(params.leaf.raw)),
      { issuerCertificate: pkijs.Certificate.fromBER(toArrayBuffer(params.issuer.raw)), hashAlgorithm: 'SHA-256' });
    request = new Uint8Array(ocspRequest.toSchema(true).toBER());
  } catch (e) {
    return { checked: false, status: 'unavailable', source, checkedAt: now(), mode,
             reason: 'Falha ao montar o pedido OCSP (CertID): ' + errorMessage(e) };
  }

  const fetchLike: FetchLike = params.fetchLike ?? ((url, init) => fetch(url, init) as never);
  const timeoutMs = params.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchLike(source, {
      method: 'POST',
      headers: { 'content-type': 'application/ocsp-request', accept: 'application/ocsp-response' },
      body: request,
      signal: controller.signal
    });
    if (!response.ok)
      return { checked: false, status: 'unavailable', source, checkedAt: now(), mode,
               reason: `Responder OCSP recusou com HTTP ${response.status}.` };
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length === 0)
      return { checked: false, status: 'unavailable', source, checkedAt: now(), mode,
               reason: 'Responder OCSP devolveu corpo vazio.' };

    const ocspResponse = pkijs.OCSPResponse.fromBER(new Uint8Array(raw));
    const responseStatus = Number((ocspResponse.responseStatus.valueBlock as { valueDec?: number }).valueDec ?? -1);
    if (responseStatus !== 0)
      return { checked: false, status: 'unavailable', source, checkedAt: now(), mode,
               reason: `OCSPResponseStatus=${responseStatus} (${OCSP_RESPONSE_STATUS_NAMES[responseStatus] ?? 'desconhecido'}).` };

    // isForCertificate compara o CertID devolvido com o recalculado: resposta
    // para OUTRO certificado não é aceita como prova de status algum.
    const probe = await ocspResponse.getCertificateStatus(
      pkijs.Certificate.fromBER(toArrayBuffer(params.leaf.raw)),
      pkijs.Certificate.fromBER(toArrayBuffer(params.issuer.raw)));
    if (!probe.isForCertificate)
      return { checked: false, status: 'unavailable', source, checkedAt: now(), mode,
               reason: 'Resposta OCSP não corresponde ao CertID do certificado apresentado.' };

    const status: RevocationStatus = probe.status === 0 ? 'good' : probe.status === 1 ? 'revoked' : 'unknown';
    return {
      checked: true,
      status,
      source,
      checkedAt: now(),
      mode,
      ...(status === 'revoked' ? { revokedAt: revokedAtFrom(ocspResponse) } : {}),
      note: 'Resposta OCSP aceita sem verificação da assinatura do responder (id-kp-OCSPSigning não validado) — pendência declarada; nonce não utilizado.'
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { checked: false, status: 'unavailable', source, checkedAt: now(), mode,
             reason: aborted ? `Timeout do responder OCSP (${timeoutMs} ms).`
                             : 'Falha de rede/parse na consulta OCSP: ' + errorMessage(e) };
  } finally {
    clearTimeout(timer);
  }
}
