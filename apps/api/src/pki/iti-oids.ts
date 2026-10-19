/** OIDs ICP-Brasil / ITI usados na assinatura de documentos clínicos (Guia do ITI, Cap. V). */

export const OIDS = {
  /** Prescrição de medicamento (Cap. V) */
  PRESCRIPTION: '2.16.76.1.12.1.1',
  /** Solicitação de exame (Cap. V) */
  EXAM_REQUEST: '2.16.76.1.12.1.3',
  /** Número de registro no conselho (CRM) */
  COUNCIL_NUMBER: '2.16.76.1.4.2.2.1',
  /** UF do registro no conselho */
  COUNCIL_STATE: '2.16.76.1.4.2.2.2',
  /** Arco da política ICP-Brasil — TSA deve emitir sob este arco ou subarco */
  POLICY_ARC: '2.16.76.1',
  /** PAdES Referência Básica v1.3 (sem ACT) */
  PADES_AD_RB: '2.16.76.1.7.1.11.1.3',
  /** PAdES Referência de Tempo v1.3 (com ACT) */
  PADES_AD_RT: '2.16.76.1.7.1.12.1.3'
} as const;

export const CMS_ATTR = {
  CONTENT_TYPE: '1.2.840.113549.1.9.3',
  MESSAGE_DIGEST: '1.2.840.113549.1.9.4',
  /** RFC 5035 — ESS signing-certificate-v2 (SHA-256) */
  SIGNING_CERTIFICATE_V2: '1.2.840.113549.1.9.16.2.47',
  /** RFC 5698/3161 — signatureTimeStampToken (unsigned attribute) */
  SIGNATURE_TIMESTAMP_TOKEN: '1.2.840.113549.1.9.16.2.14',
  /** PAdES — signature-policy-identifier */
  POLICY_IDENTIFIER: '1.2.840.113549.1.9.16.2.15'
} as const;

export const CTYPE_ID_DATA = '1.2.840.113549.1.7.1';
export const CTYPE_TST_INFO = '1.2.840.113549.1.9.16.1.4';
export const OID_SHA256 = '2.16.840.1.101.3.4.2.1';

export type DocumentType = 'prescription' | 'exam-request';

/** Doc type → OID do documento (Cap. V). */
export function documentTypeOid(type: DocumentType): string {
  return type === 'prescription' ? OIDS.PRESCRIPTION : OIDS.EXAM_REQUEST;
}

/** Uma política de carimbo só é de ICP-Brasil se igual ao arco ou sob o arco 2.16.76.1. */
export function isIcpBrasilPolicy(policy: string | null | undefined): boolean {
  if (!policy) return false;
  return policy === OIDS.POLICY_ARC || policy.startsWith(OIDS.POLICY_ARC + '.');
}
