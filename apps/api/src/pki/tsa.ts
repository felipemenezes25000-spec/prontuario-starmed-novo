import { randomBytes } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { isIcpBrasilPolicy, OID_SHA256 } from './iti-oids';

/**
 * Cliente RFC 3161 (carimbo de tempo / ACT) para PAdES AD-RT.
 * Taxonomia de falhas em quatro categorias (espelha a do legado — consertos
 * diferentes, mensagem para o operador):
 *   CredencialInvalida      — segredo errado (401/403/400 no token; 403 no carimbo)
 *   AutoridadeIndisponivel  — rede/timeout/5xx/429/408 (é do lado deles)
 *   RequisicaoRecusada      — 4xx (não-401/403/408/429) ou PKIStatus != granted
 *   RespostaInvalida        — 200 mas sem carimbo utilizável (DER corrompido,
 *                             nonce divergente, política fora do arco 2.16.76.1)
 * A capacidade NASCE DESLIGADA: sem configuração não há bytes na rede e o
 * documento sai AD-RB. `requireTimestamp` decide se a falha aborta a emissão.
 */

export type TsaFailureCategory =
  | 'CredencialInvalida'
  | 'AutoridadeIndisponivel'
  | 'RequisicaoRecusada'
  | 'RespostaInvalida';

export class TsaError extends Error {
  constructor(readonly category: TsaFailureCategory, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TsaError';
  }
}

export type TsaConfig = {
  url: string;                            // endpoint de carimbo (POST TSQ)
  tokenUrl?: string;                      // SERPRO: endpoint OAuth2 de token
  consumerKey?: string;
  consumerSecret?: string;
};

export function tsaConfigFromEnv(): TsaConfig | null {
  const url = process.env.TSA_URL;
  if (!url) return null;
  return {
    url,
    tokenUrl: process.env.TSA_TOKEN_URL || undefined,
    consumerKey: process.env.TSA_CONSUMER_KEY || undefined,
    consumerSecret: process.env.TSA_CONSUMER_SECRET || undefined
  };
}

export type TsaRequestInput = { imprint: Buffer };  // SHA-256 do conteúdo (32 bytes)
export type TsaResult = { tokenDer: Buffer; policyOid: string | null; genTime: Date };

type FetchLike = (url: string, init: { method: string; headers: Record<string,string>; body?: Uint8Array<ArrayBuffer> }) =>
  Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

function classificationForHttp(status: number): TsaFailureCategory {
  if (status === 401 || status === 403 || status === 400) return 'CredencialInvalida';
  if (status >= 500 || status === 429 || status === 408) return 'AutoridadeIndisponivel';
  if (status >= 400) return 'RequisicaoRecusada';
  return 'RespostaInvalida';
}

/** Monta o TSQ: SHA-256, certReq=true, nonce aleatório POSITIVO, SEM reqPolicy (decisão do legado). */
export function buildTimeStampReq(imprint: Buffer, nonce?: Uint8Array): { der: Buffer; nonce: Uint8Array } {
  if (imprint.length !== 32) throw new Error('imprint deve ser SHA-256 (32 bytes)');
  const effectiveNonce = new Uint8Array(nonce ?? randomBytes(16));
  effectiveNonce[0] &= 0x7f; // INTEGER de contagem deve ser não-negativo em DER
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256, algorithmParams: new asn1js.Null() }),
      hashedMessage: new asn1js.OctetString({ valueHex: new Uint8Array(imprint) })
    }),
    certReq: true
  });
  req.nonce = new asn1js.Integer({ valueHex: effectiveNonce.buffer as ArrayBuffer });
  return { der: Buffer.from(req.toSchema().toBER()), nonce: effectiveNonce };
}

async function getBearerToken(config: TsaConfig, fetchLike: FetchLike): Promise<string> {
  if (!config.tokenUrl || !config.consumerKey || !config.consumerSecret)
    throw new TsaError('CredencialInvalida', 'ACT sem credencial configurada (TSA_TOKEN_URL/TSA_CONSUMER_KEY/TSA_CONSUMER_SECRET)');
  const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
  let response;
  try {
    response = await fetchLike(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + auth },
      body: new TextEncoder().encode(new URLSearchParams({ grant_type: 'client_credentials' }).toString())
    });
  } catch (e) { throw new TsaError('AutoridadeIndisponivel', 'rede/timeout no endpoint de token da ACT', e); }
  if (!response.ok) throw new TsaError(classificationForHttp(response.status), `endpoint de token da ACT recusou com HTTP ${response.status}`);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(await response.arrayBuffer())); }
  catch { throw new TsaError('RespostaInvalida', 'endpoint de token da ACT não retornou JSON'); }
  const token = (payload as { access_token?: unknown })?.access_token;
  if (typeof token !== 'string' || !token) throw new TsaError('RespostaInvalida', 'endpoint de token da ACT sem access_token');
  return token;
}

export async function requestTimestamp(
  input: TsaRequestInput,
  config: TsaConfig,
  fetchLike: FetchLike = ((url, init) => fetch(url, init) as never)
): Promise<TsaResult> {
  const { der, nonce } = buildTimeStampReq(input.imprint);
  const headers: Record<string,string> = { 'content-type': 'application/timestamp-query', accept: 'application/timestamp-reply' };
  if (config.tokenUrl) {
    // SERPRO: carimbo autentica por Bearer; token Basic só no endpoint de token.
    headers.authorization = 'Bearer ' + await getBearerToken(config, fetchLike);
  } else if (config.consumerKey && config.consumerSecret) {
    headers.authorization = 'Basic ' + Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
  }

  let response;
  try {
    response = await fetchLike(config.url, { method: 'POST', headers, body: new Uint8Array(der) });
  } catch (e) { throw new TsaError('AutoridadeIndisponivel', 'rede/timeout no endpoint de carimbo da ACT', e); }
  if (!response.ok) {
    const category = classificationForHttp(response.status);
    throw new TsaError(category, `carimbo da ACT recusou com HTTP ${response.status} (${category})`);
  }

  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length === 0) throw new TsaError('RespostaInvalida', 'ACT respondeu 200 com corpo vazio');

  let resp: pkijs.TimeStampResp;
  try { resp = pkijs.TimeStampResp.fromBER(new Uint8Array(raw)); }
  catch (e) { throw new TsaError('RespostaInvalida', 'TSR que não parseia (DER corrompido)', e); }

  const status = resp.status.status;
  if (status !== pkijs.PKIStatus.granted && status !== pkijs.PKIStatus.grantedWithMods) {
    const detail = resp.status.statusStrings?.map((s) => s.valueBlock.valueHexView).join(' ') ?? '';
    throw new TsaError('RequisicaoRecusada', `PKIStatus=${status} ${detail}`.trim());
  }
  if (!resp.timeStampToken) throw new TsaError('RespostaInvalida', 'concessão sem carimbo anexado');

  // TSTInfo: confere imprint, nonce e política (arco 2.16.76.1).
  let tstInfo: pkijs.TSTInfo;
  try {
    const signedData = new pkijs.SignedData({ schema: resp.timeStampToken.content });
    const eContent = signedData.encapContentInfo.eContent as asn1js.OctetString | undefined;
    if (!eContent) throw new Error('sem eContent');
    // eContent parseado guarda os bytes fora de valueHexView (gotcha pkijs): getValue() cobre os dois casos.
    tstInfo = pkijs.TSTInfo.fromBER(eContent.getValue());
  } catch (e) { throw new TsaError('RespostaInvalida', 'TSR cujo TSTInfo não parseia', e); }

  const returnedNonce = Buffer.from(tstInfo.nonce?.valueBlock.valueHexView ?? []);
  if (!returnedNonce.equals(Buffer.from(nonce)))
    throw new TsaError('RespostaInvalida', 'nonce do carimbo diverge do pedido (replay?)');
  const imprintHex = Buffer.from(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView).toString('hex');
  if (imprintHex !== input.imprint.toString('hex'))
    throw new TsaError('RespostaInvalida', 'imprint do carimbo não corresponde ao hash enviado');
  if (!isIcpBrasilPolicy(tstInfo.policy))
    throw new TsaError('RespostaInvalida', `política da ACT fora do arco ICP-Brasil: ${tstInfo.policy ?? '(ausente)'}`);

  return {
    tokenDer: Buffer.from(resp.timeStampToken.toSchema().toBER()),
    policyOid: tstInfo.policy ?? null,
    genTime: tstInfo.genTime
  };
}
