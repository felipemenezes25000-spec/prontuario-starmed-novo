import { X509Certificate, createHash } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { CTYPE_ID_DATA, CMS_ATTR, DocumentType, documentTypeOid } from './iti-oids';
import { LoadedPolicy } from './policy';
import { toArrayBuffer } from './buffer';
import { normalizeCertificatePem } from './pem';

/**
 * Assinatura CMS/PAdES detached (PKCS#7/CMS, SHA-256) sobre documentos clínicos,
 * com os atributos assinados exigidos pelo Guia do ITI (Cap. V) exatamente na
 * codificação do container de referência:
 *   - atributo do documento: UTF8String VAZIO (marcador de tipo);
 *   - CRM e UF: UTF8String com o valor;
 *   - ESS signing-certificate-v2 (RFC 5035) com SHA-256 do certificado do assinante;
 *   - signature-policy-identifier com a LPA vigente (AD-RB; AD-RT quando carimbado);
 *   - SEM signingTime (o legado o remove de propósito: o tempo qualificado vem do ACT);
 *   - carimbo de tempo entra como unsigned attribute signatureTimeStampToken.
 * A assinatura é detached: o atributo assinado é sobre o conteúdo, o CMS sai ao
 * lado do documento (embutimento em PDF é etapa seguinte — ver CONTINUE-STARMED).
 */

export type PadesSignParams = {
  content: Buffer;                       // bytes completos do documento
  signerCertPem: string;                 // certificado do assinante (e-CPF)
  chainPems: string[];                   // intermediárias (e opcionalmente a raiz)
  privateKeyPkcs8Pem: string;            // chave privada PKCS#8 (PEM)
  documentType: DocumentType;
  councilNumber: string;                 // CRM (somente dígitos/letras)
  councilState: string;                  // UF (2 letras)
  policy: LoadedPolicy;                  // LPA vigente (ad-rb ou ad-rt)
  timestampTokenDer?: Buffer | null;     // TimeStampToken (ContentInfo DER) da ACT
};

export type PadesSignResult = {
  cms: Buffer;                           // ContentInfo DER (detached)
  digestSha256: Buffer;                  // hash do documento (imprint)
  signerCert: X509Certificate;
  timestampApplied: boolean;
  policyOid: string;
};

async function importPrivateKey(pkcs8Pem: string): Promise<CryptoKey> {
  const body = pkcs8Pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Buffer.from(body, 'base64');
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
    .catch(() => null);
  if (key) return key;
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

function attr(type: string, values: asn1js.AsnType[]): pkijs.Attribute {
  return new pkijs.Attribute({ type, values });
}

function buildSignedAttributes(params: {
  contentDigest: Buffer;
  certDer: Buffer;
  documentOid: string;
  councilNumber: string;
  councilState: string;
  policy: LoadedPolicy;
}): pkijs.SignedAndUnsignedAttributes {
  // ESSSigningCertificateV2 ::= SEQUENCE { certs SEQUENCE SIZE (1..MAX) OF ESSCertIDv2 }
  // ESSCertIDv2 ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier DEFAULT sha256, certHash OCTET STRING }
  const essCertIdV2 = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: '2.16.840.1.101.3.4.2.1' }), new asn1js.Null()] }),
      new asn1js.OctetString({ valueHex: new Uint8Array(createHash('sha256').update(params.certDer).digest()) })
    ]
  });
  const signingCertificateV2 = new asn1js.Sequence({
    value: [new asn1js.Sequence({ value: [essCertIdV2] })]
  });

  // SignaturePolicyId ::= SEQUENCE { sigPolicyId OID, sigPolicyHash OtherHashAlgAndValue }
  // OtherHashAlgAndValue: AlgorithmIdentifier SEM parâmetros DerNull (convergido com a LPA).
  const signaturePolicyId = new asn1js.Sequence({
    value: [
      new asn1js.ObjectIdentifier({ value: params.policy.oid }),
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: '2.16.840.1.101.3.4.2.1' })] }),
          new asn1js.OctetString({ valueHex: new Uint8Array(params.policy.hash) })
        ]
      })
    ]
  });

  return new pkijs.SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      attr(CMS_ATTR.CONTENT_TYPE, [new asn1js.ObjectIdentifier({ value: CTYPE_ID_DATA })]),
      attr(CMS_ATTR.MESSAGE_DIGEST, [new asn1js.OctetString({ valueHex: new Uint8Array(params.contentDigest) })]),
      attr(params.documentOid, [new asn1js.Utf8String({ value: '' })]),
      attr(CMS_ATTR.POLICY_IDENTIFIER, [signaturePolicyId]),
      attr(CMS_ATTR.SIGNING_CERTIFICATE_V2, [signingCertificateV2]),
      attr('2.16.76.1.4.2.2.1', [new asn1js.Utf8String({ value: params.councilNumber })]),
      attr('2.16.76.1.4.2.2.2', [new asn1js.Utf8String({ value: params.councilState })])
    ]
  });
}

export async function signPades(params: PadesSignParams): Promise<PadesSignResult> {
  const leaf = new X509Certificate(normalizeCertificatePem(params.signerCertPem));
  const certDer = leaf.raw;
  const contentDigest = createHash('sha256').update(params.content).digest();

  const privateKey = await importPrivateKey(params.privateKeyPkcs8Pem);
  const certificates: pkijs.Certificate[] = [pkijs.Certificate.fromBER(toArrayBuffer(certDer))];
  for (const pem of params.chainPems) certificates.push(pkijs.Certificate.fromBER(toArrayBuffer(new X509Certificate(normalizeCertificatePem(pem)).raw)));

  const signedData = new pkijs.SignedData({
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: CTYPE_ID_DATA }),
    signerInfos: [
      new pkijs.SignerInfo({
        sid: new pkijs.IssuerAndSerialNumber({ issuer: certificates[0].issuer, serialNumber: certificates[0].serialNumber }),
        signedAttrs: buildSignedAttributes({
          contentDigest, certDer,
          documentOid: documentTypeOid(params.documentType),
          councilNumber: params.councilNumber, councilState: params.councilState,
          policy: params.policy
        })
      })
    ],
    certificates,
    digestAlgorithms: []
  });

  await signedData.sign(privateKey, 0, 'SHA-256', new Uint8Array(params.content));

  let timestampApplied = false;
  if (params.timestampTokenDer && params.timestampTokenDer.length > 0) {
    // O valor do atributo é o TimeStampToken (ContentInfo) SEM o envelope TimeStampResp.
    // values[] exige elementos asn1js (com toBER) — vai o schema, não a instância pkijs.
    const token = pkijs.ContentInfo.fromBER(toArrayBuffer(params.timestampTokenDer));
    signedData.signerInfos[0].unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: [new pkijs.Attribute({ type: CMS_ATTR.SIGNATURE_TIMESTAMP_TOKEN, values: [token.toSchema()] })]
    });
    timestampApplied = true;
  }

  const contentInfo = new pkijs.ContentInfo({
    contentType: pkijs.ContentInfo.SIGNED_DATA,
    content: signedData.toSchema(true)
  });
  return {
    cms: Buffer.from(contentInfo.toSchema().toBER()),
    digestSha256: contentDigest,
    signerCert: leaf,
    timestampApplied,
    policyOid: params.policy.oid
  };
}

export type PadesVerifyResult = {
  signatureValid: boolean;
  signerCert: X509Certificate | null;
  timestampPresent: boolean;
  policyOid: string | null;
  documentOids: string[];
  councilNumber: string | null;
  councilState: string | null;
  error?: string;
};

/** Verifica a assinatura detached contra o conteúdo e extrai os atributos ITI. */
export async function verifyPades(cms: Buffer, content: Buffer): Promise<PadesVerifyResult> {
  const base: PadesVerifyResult = {
    signatureValid: false, signerCert: null, timestampPresent: false,
    policyOid: null, documentOids: [], councilNumber: null, councilState: null
  };
  try {
    const contentInfo = pkijs.ContentInfo.fromBER(new Uint8Array(cms));
    if (contentInfo.contentType !== pkijs.ContentInfo.SIGNED_DATA)
      return { ...base, error: 'CMS não é SignedData' };
    const signedData = new pkijs.SignedData({ schema: contentInfo.content });
    const signerInfo = signedData.signerInfos[0];
    if (!signerInfo) return { ...base, error: 'CMS sem SignerInfo' };

    const valid = await signedData.verify({ signer: 0, data: toArrayBuffer(content), checkChain: false });
    if (!valid) return { ...base, error: 'assinatura inválida para o conteúdo apresentado' };

    let signerCert: X509Certificate | null = null;
    for (const item of signedData.certificates ?? []) {
      if (item instanceof pkijs.Certificate) {
        const der = Buffer.from(item.toSchema().toBER());
        const cert = new X509Certificate(der);
        signerCert = cert;
        break;
      }
    }

    const attrs = signerInfo.signedAttrs?.attributes ?? [];
    const valueOf = (type: string): string | null => {
      const found = attrs.find((a) => a.type === type);
      const first = found?.values?.[0] as { value?: unknown; valueBlock?: { valueHexView?: Uint8Array } } | undefined;
      if (!first) return null;
      // Utf8String parseado não expõe `.value`: decodifica o valueHexView.
      if (typeof first.value === 'string') return first.value;
      if (first.valueBlock?.valueHexView) return Buffer.from(first.valueBlock.valueHexView).toString('utf8');
      return null;
    };
    const policyAttr = attrs.find((a) => a.type === CMS_ATTR.POLICY_IDENTIFIER);
    let policyOid: string | null = null;
    if (policyAttr) {
      try {
        const seq = policyAttr.values[0] as asn1js.Sequence;
        policyOid = (seq.valueBlock.value[0] as asn1js.ObjectIdentifier).valueBlock.toString();
      } catch { policyOid = null; }
    }
    const documentOids = attrs
      .map((a) => a.type)
      .filter((t) => t.startsWith('2.16.76.1.12.'));

    return {
      ...base,
      signatureValid: true,
      signerCert,
      timestampPresent: Boolean(signerInfo.unsignedAttrs?.attributes?.length),
      policyOid,
      documentOids,
      councilNumber: valueOf('2.16.76.1.4.2.2.1'),
      councilState: valueOf('2.16.76.1.4.2.2.2')
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : 'falha ao verificar CMS' };
  }
}
