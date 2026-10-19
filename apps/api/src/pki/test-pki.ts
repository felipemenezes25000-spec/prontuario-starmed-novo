/**
 * Construtor de PKI de TESTE em runtime (e fake-TSA em memória).
 * Utilitário de teste: NÃO é código de produção e NÃO contém chaves fixas —
 * tudo é gerado por teste, o que evita fixtures com chave privada no repositório.
 */
import { X509Certificate, randomBytes } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

export type TestCa = { cert: pkijs.Certificate; der: Buffer; x509: X509Certificate; key: CryptoKey; privateKey: CryptoKey };

function name(cn: string): pkijs.RelativeDistinguishedNames {
  return new pkijs.RelativeDistinguishedNames({
    typesAndValues: [new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) })]
  });
}

function serialWithPositiveHead(): ArrayBuffer {
  const bytes = new Uint8Array(randomBytes(8));
  bytes[0] &= 0x7f;
  return bytes.buffer as ArrayBuffer;
}

async function rsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  ) as Promise<CryptoKeyPair>;
}

function keyUsageExtension(ca: boolean): pkijs.Extension {
  // BitString manual (pkijs não exporta classe KeyUsage): bit 0 = digitalSignature,
  // bit 5 = keyCertSign, bit 6 = cRLSign (MSB-first dentro do byte).
  const bitArray = new ArrayBuffer(1);
  const bitView = new Uint8Array(bitArray);
  if (ca) { bitView[0] |= 0x04; bitView[0] |= 0x02; }
  else { bitView[0] |= 0x80; }
  const keyUsage = new asn1js.BitString({ valueHex: bitArray });
  return new pkijs.Extension({
    extnID: '2.5.29.15',
    critical: false,
    extnValue: keyUsage.toBER(false),
    parsedValue: keyUsage as never
  });
}

function basicConstraintsExtension(ca: boolean): pkijs.Extension {
  const basicConstr = new pkijs.BasicConstraints({ cA: ca, ...(ca ? { pathLenConstraint: 1 } : {}) });
  return new pkijs.Extension({
    extnID: '2.5.29.19',
    critical: true,
    extnValue: basicConstr.toSchema().toBER(false),
    parsedValue: basicConstr as never
  });
}

export async function makeCertificate(opts: {
  subjectCn: string;
  issuer?: TestCa;
  ca?: boolean;
  notBeforeDays?: number;   // dias a partir de hoje (negativo = já vencido)
  notAfterDays?: number;
}): Promise<TestCa & { privateKey: CryptoKey }> {
  const keys = await rsaKeyPair();
  const cert = new pkijs.Certificate();
  cert.version = 2;
  const serial = new Uint8Array(randomBytes(8));
  serial[0] &= 0x7f; // RFC 5280: serial deve ser positivo
  cert.serialNumber = new asn1js.Integer({ valueHex: serial.buffer as ArrayBuffer });
  const issuerCa = opts.issuer;
  cert.issuer = issuerCa ? issuerCa.cert.subject : name(opts.subjectCn);
  cert.subject = name(opts.subjectCn);
  const notBefore = new Date(Date.now() + (opts.notBeforeDays ?? -1) * 86400_000);
  const notAfter = new Date(Date.now() + (opts.notAfterDays ?? 825) * 86400_000);
  cert.notBefore = new pkijs.Time({ type: 0, value: notBefore });
  cert.notAfter = new pkijs.Time({ type: notAfter.getUTCFullYear() >= 2050 ? 1 : 0, value: notAfter });
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);

  cert.extensions = [
    basicConstraintsExtension(opts.ca ?? false),
    keyUsageExtension(opts.ca ?? false)
  ];

  const signingKey = issuerCa ? issuerCa.key : keys.privateKey;
  await cert.sign(signingKey, 'SHA-256');
  const der = Buffer.from(cert.toSchema().toBER());
  return { cert, der, x509: new X509Certificate(der), key: keys.privateKey, privateKey: keys.privateKey };
}

export type TestPki = {
  root: TestCa; intermediate: TestCa; leaf: TestCa;
  rogueRoot: TestCa; rogueLeaf: TestCa;
  expiredLeaf: TestCa;
};

export async function buildTestPki(): Promise<TestPki> {
  const root = await makeCertificate({ subjectCn: 'StarMed Test Root CA', ca: true, notBeforeDays: -2, notAfterDays: 3650 });
  const intermediate = await makeCertificate({ subjectCn: 'StarMed Test Intermediate CA', issuer: root, ca: true, notBeforeDays: -1, notAfterDays: 1825 });
  const leaf = await makeCertificate({ subjectCn: 'Dr Teste da Silva CRM 12345/SP', issuer: intermediate, ca: false });
  const rogueRoot = await makeCertificate({ subjectCn: 'INVALID TEST CA Rogue', ca: true, notBeforeDays: -2, notAfterDays: 3650 });
  const rogueLeaf = await makeCertificate({ subjectCn: 'Assinante Não Confiável', issuer: rogueRoot, ca: false });
  const expiredLeaf = await makeCertificate({ subjectCn: 'Dr Expirado', issuer: intermediate, ca: false, notBeforeDays: -30, notAfterDays: -10 });
  return { root, intermediate, leaf, rogueRoot, rogueLeaf, expiredLeaf };
}

export function pem(cert: { der: Buffer }): string {
  const body = cert.der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export function pkcs8Pem(key: CryptoKey): Promise<string> {
  return crypto.subtle.exportKey('pkcs8', key).then((der) => {
    const body = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
  });
}

/**
 * Fake-TSA em memória: lê o TSQ, devolve um TSR real assinado por uma CA de
 * teste, com imprint/nonce conferidos. `policy` é configurável para testar a
 * recusa de política fora do arco ICP-Brasil.
 */
export async function fakeTsa(tsq: Buffer, opts?: {
  policy?: string;
  status?: pkijs.PKIStatus;
  sign?: boolean;
  dropToken?: boolean;
  nonceOverride?: Uint8Array;
}): Promise<Buffer> {
  const req = pkijs.TimeStampReq.fromBER(new Uint8Array(tsq));
  const policy = opts?.policy ?? '2.16.76.1.6.2';
  const tsa = await makeCertificate({ subjectCn: 'Fake TSA Test', ca: true, notBeforeDays: -1, notAfterDays: 365 });
  const tstInfo = new pkijs.TSTInfo({
    version: 1,
    policy,
    messageImprint: req.messageImprint,
    serialNumber: new asn1js.Integer({ valueHex: serialWithPositiveHead() }),
    genTime: new Date(),
    nonce: opts?.nonceOverride ? new asn1js.Integer({ valueHex: new Uint8Array(opts.nonceOverride).buffer as ArrayBuffer }) : req.nonce
  });
  const token = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: '1.2.840.113549.1.9.16.1.4',
      eContent: new asn1js.OctetString({ valueHex: tstInfo.toSchema().toBER() })
    }),
    signerInfos: [new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({ issuer: tsa.cert.issuer, serialNumber: tsa.cert.serialNumber })
    })],
    certificates: [tsa.cert]
  });
  if (opts?.sign !== false) await token.sign(tsa.key, 0, 'SHA-256');
  const tokenContent = new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.SIGNED_DATA, content: token.toSchema(true) });
  const resp = new pkijs.TimeStampResp({
    status: new pkijs.PKIStatusInfo({ status: opts?.status ?? pkijs.PKIStatus.granted }),
    ...(opts?.dropToken ? {} : { timeStampToken: new pkijs.ContentInfo({ schema: tokenContent.toSchema() }) })
  });
  return Buffer.from(resp.toSchema().toBER());
}

export function httpStub(status: number, body?: Buffer) {
  const payload = body ?? Buffer.alloc(0);
  const exact = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => exact
  });
}
