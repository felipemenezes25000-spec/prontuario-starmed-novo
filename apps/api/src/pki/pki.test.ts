import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { TrustStore, TrustStoreError } from './trust-store';
import { validateChain } from './chain';
import { loadPolicy } from './policy';
import { verifyPades, signPades } from './pades';
import { reserveSignatureSpace, embedSignature, readEmbeddedSignature, verifyEmbeddedSignature } from './pades-embed';
import { TsaError, buildTimeStampReq, requestTimestamp, tsaConfigFromEnv } from './tsa';
import { isIcpBrasilPolicy, OIDS } from './iti-oids';
import { buildTestPki, fakeTsa, httpStub, pem, pkcs8Pem, type TestPki } from './test-pki';
import { toArrayBuffer } from './buffer';

const ROOTS_DIR = resolve(__dirname, '..', '..', '..', '..', 'certs', 'icp-brasil', 'roots');
const POLICIES_DIR = resolve(__dirname, '..', '..', '..', '..', 'certs', 'icp-brasil', 'policies');

describe('trust store ICP-Brasil', () => {
  test('carrega a allowlist oficial de raízes (falta = falha fechada)', () => {
    const store = TrustStore.fromDirectory(ROOTS_DIR);
    assert.equal(store.size, 6);
    for (const cert of store.certs) {
      assert.ok(cert.ca, `${cert.subject} deve ser CA:TRUE`);
      assert.match(cert.subject, /Autoridade Certificadora Raiz Brasileira v(4|5|6|7|12|13)/);
      assert.ok(Date.now() >= Date.parse(cert.validFrom) && Date.now() <= Date.parse(cert.validTo), 'raiz vigente');
    }
  });

  test('vazio lança TrustStoreError (nunca confia sem raízes)', () => {
    assert.throws(() => new TrustStore([], 'vazio'), TrustStoreError);
  });

  test('raiz confiável é reconhecida por fingerprint, não por nome', () => {
    const store = TrustStore.fromDirectory(ROOTS_DIR);
    const real = store.certs[0];
    assert.ok(store.has(real));
    const forged = new X509Certificate(Buffer.from(real.toString())); // cópia idêntica → mesmo fingerprint
    assert.ok(store.has(forged));
  });
});

describe('validação de cadeia', () => {
  let pki: TestPki;
  let trust: TrustStore;
  before(async () => {
    pki = await buildTestPki();
    trust = new TrustStore([pem(pki.root)], 'teste');
  });

  test('cadeia leaf→intermediária→raiz confiável valida', () => {
    const result = validateChain(pki.leaf.x509, [pki.intermediate.x509], trust);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.path.length, 3);
      assert.equal(result.anchor.fingerprint256, pki.root.x509.fingerprint256);
    }
  });

  test('raiz fora do trust store é rejeitada (inclui "TEST CA" enganoso)', () => {
    // A cadeia apresentada inclui a rogueRoot (assinada, consistente) — mas ela
    // não está no trust store. Comparar por NOME deixaria passar (lição do legado).
    const result = validateChain(pki.rogueLeaf.x509, [pki.rogueRoot.x509, pki.intermediate.x509], trust);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'untrusted-root');
  });

  test('certificado expirado é rejeitado com data de checagem injetável', () => {
    const result = validateChain(pki.expiredLeaf.x509, [pki.intermediate.x509], trust);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'expired');
    const atExpiryBoundary = validateChain(pki.leaf.x509, [pki.intermediate.x509], trust, new Date(Date.now() + 4000 * 86400_000));
    assert.equal(atExpiryBoundary.ok, false);
    if (!atExpiryBoundary.ok) assert.equal(atExpiryBoundary.code, 'expired');
  });

  test('emissor ausente retorna no-issuer', () => {
    const result = validateChain(pki.leaf.x509, [], trust);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'no-issuer');
  });
});

describe('assinatura PAdES/CMS', () => {
  let pki: TestPki;
  let policyAdRb: ReturnType<typeof loadPolicy>;
  let policyAdRt: ReturnType<typeof loadPolicy>;
  before(async () => {
    pki = await buildTestPki();
    policyAdRb = loadPolicy('ad-rb', POLICIES_DIR);
    policyAdRt = loadPolicy('ad-rt', POLICIES_DIR);
  });

  test('LPA carregada com OID e hash SHA-256 de 32 bytes', () => {
    assert.equal(policyAdRb.oid, OIDS.PADES_AD_RB);
    assert.equal(policyAdRt.oid, OIDS.PADES_AD_RT);
    assert.equal(policyAdRb.hash.length, 32);
    assert.equal(policyAdRt.hash.length, 32);
  });

  test('round-trip: assina, verifica e extrai atributos ITI', async () => {
    const content = Buffer.from('Receita fictícia: LOSARTANA 50mg — 1x/dia por 30 dias.\nDocumento de teste.');
    const signed = await signPades({
      content,
      signerCertPem: pem(pki.leaf),
      chainPems: [pem(pki.intermediate), pem(pki.root)],
      privateKeyPkcs8Pem: await pkcs8Pem(pki.leaf.privateKey),
      documentType: 'prescription',
      councilNumber: '12345',
      councilState: 'SP',
      policy: policyAdRb
    });
    assert.ok(signed.cms.length > 500);
    assert.equal(signed.timestampApplied, false);
    assert.equal(signed.digestSha256.length, 32);

    const verified = await verifyPades(signed.cms, content);
    assert.equal(verified.signatureValid, true, verified.error);
    assert.equal(verified.signerCert?.fingerprint256, pki.leaf.x509.fingerprint256);
    assert.equal(verified.timestampPresent, false);
    assert.equal(verified.policyOid, OIDS.PADES_AD_RB);
    assert.deepEqual(verified.documentOids, [OIDS.PRESCRIPTION]);
    assert.equal(verified.councilNumber, '12345');
    assert.equal(verified.councilState, 'SP');
  });

  test('conteúdo adulterado invalida a assinatura', async () => {
    const content = Buffer.from('Conteúdo original');
    const signed = await signPades({
      content, signerCertPem: pem(pki.leaf), chainPems: [pem(pki.intermediate)],
      privateKeyPkcs8Pem: await pkcs8Pem(pki.leaf.privateKey),
      documentType: 'exam-request', councilNumber: '9999', councilState: 'RJ',
      policy: policyAdRb
    });
    const tampered = Buffer.from(content);
    tampered[tampered.length - 1] ^= 0x01;
    const verified = await verifyPades(signed.cms, tampered);
    assert.equal(verified.signatureValid, false);
  });

  test('carimbo de ACT vira atributo unsigned (AD-RT)', async () => {
    const content = Buffer.from('Documento carimbado');
    const imprint = signedImprint(content);
    // O endpoint da ACT devolve o TimeStampResp (envelope); o atributo usa o TOKEN (ContentInfo).
    const tsr = pkijs.TimeStampResp.fromBER(toArrayBuffer(await fakeTsa(buildTimeStampReq(imprint).der)));
    const tokenDer = Buffer.from(tsr.timeStampToken!.toSchema().toBER());
    const signed = await signPades({
      content, signerCertPem: pem(pki.leaf), chainPems: [pem(pki.intermediate)],
      privateKeyPkcs8Pem: await pkcs8Pem(pki.leaf.privateKey),
      documentType: 'prescription', councilNumber: '12345', councilState: 'SP',
      policy: policyAdRt, timestampTokenDer: tokenDer
    });
    assert.equal(signed.timestampApplied, true);
    const verified = await verifyPades(signed.cms, content);
    assert.equal(verified.signatureValid, true, verified.error);
    assert.equal(verified.timestampPresent, true);
    assert.equal(verified.policyOid, OIDS.PADES_AD_RT);
  });
});

function signedImprint(content: Buffer): Buffer {
  return createHash('sha256').update(content).digest();
}

describe('carimbo de tempo RFC 3161', () => {
  test('TSQ: SHA-256, certReq=true, nonce e sem reqPolicy', () => {
    const imprint = Buffer.alloc(32, 7);
    const { der, nonce } = buildTimeStampReq(imprint);
    const req = pkijs.TimeStampReq.fromBER(toArrayBuffer(der));
    assert.equal(req.version, 1);
    assert.equal(req.certReq, true);
    assert.equal(req.reqPolicy, undefined, 'reqPolicy não vai no pedido (decisão do legado)');
    assert.equal(Buffer.from(req.messageImprint.hashedMessage.valueBlock.valueHexView).toString('hex'), imprint.toString('hex'));
    assert.equal((req.messageImprint.hashAlgorithm as { algorithmId: string }).algorithmId, '2.16.840.1.101.3.4.2.1');
    assert.equal(Buffer.from(req.nonce!.valueBlock.valueHexView).toString('hex'), Buffer.from(nonce).toString('hex'));
  });

  test('TSQ recusa imprint que não seja SHA-256', () => {
    assert.throws(() => buildTimeStampReq(Buffer.alloc(20)), /SHA-256/);
  });

  test('carimbo válido com política sob o arco ICP-Brasil', async () => {
    const result = await requestTimestamp(
      { imprint: Buffer.alloc(32, 9) },
      { url: 'https://tsa.test/stamp' },
      async (_url, init) => {
        const tsq = init.body as Uint8Array;
        return { ok: true, status: 200, arrayBuffer: async () => bufferOf(await fakeTsa(Buffer.from(tsq))) };
      }
    );
    assert.equal(result.policyOid, '2.16.76.1.6.2');
    assert.ok(result.tokenDer.length > 100);
    assert.ok(isIcpBrasilPolicy(result.policyOid));
  });

  test('política fora do arco é RespostaInvalida (mesmo com HTTP 200)', async () => {
    await assert.rejects(
      requestTimestamp({ imprint: Buffer.alloc(32, 9) }, { url: 'https://tsa.test/stamp' },
        async (_u, init) => ({ ok: true, status: 200, arrayBuffer: async () => bufferOf(await fakeTsa(Buffer.from(init.body as Uint8Array), { policy: '2.16.840.1.114412.7.1' })) })),
      (e: unknown) => e instanceof TsaError && e.category === 'RespostaInvalida'
    );
  });

  test('PKIStatus de recusa vira RequisicaoRecusada', async () => {
    await assert.rejects(
      requestTimestamp({ imprint: Buffer.alloc(32, 9) }, { url: 'https://tsa.test/stamp' },
        async (_u, init) => ({ ok: true, status: 200, arrayBuffer: async () => bufferOf(await fakeTsa(Buffer.from(init.body as Uint8Array), { status: pkijs.PKIStatus.rejection })) })),
      (e: unknown) => e instanceof TsaError && e.category === 'RequisicaoRecusada'
    );
  });

  test('concessão sem token é RespostaInvalida', async () => {
    await assert.rejects(
      requestTimestamp({ imprint: Buffer.alloc(32, 9) }, { url: 'https://tsa.test/stamp' },
        async (_u, init) => ({ ok: true, status: 200, arrayBuffer: async () => bufferOf(await fakeTsa(Buffer.from(init.body as Uint8Array), { dropToken: true })) })),
      (e: unknown) => e instanceof TsaError && e.category === 'RespostaInvalida'
    );
  });

  test('HTTP 200 com corpo vazio é RespostaInvalida', async () => {
    await assert.rejects(
      requestTimestamp({ imprint: Buffer.alloc(32, 9) }, { url: 'https://tsa.test/stamp' }, httpStub(200, Buffer.alloc(0))),
      (e: unknown) => e instanceof TsaError && e.category === 'RespostaInvalida'
    );
  });

  test('classificação HTTP: 5xx/429/408 indisponível; 401/403/400 credencial; demais 4xx recusa', async () => {
    for (const [status, category] of [
      [503, 'AutoridadeIndisponivel'], [429, 'AutoridadeIndisponivel'], [408, 'AutoridadeIndisponivel'],
      [401, 'CredencialInvalida'], [403, 'CredencialInvalida'], [400, 'CredencialInvalida'],
      [404, 'RequisicaoRecusada'], [422, 'RequisicaoRecusada']
    ] as const) {
      await assert.rejects(
        requestTimestamp({ imprint: Buffer.alloc(32, 9) }, { url: 'https://tsa.test/stamp' }, httpStub(status)),
        (e: unknown) => e instanceof TsaError && e.category === category,
        `HTTP ${status} deve classificar como ${category}`
      );
    }
  });

  test('falha de rede é AutoridadeIndisponivel', async () => {
    await assert.rejects(
      requestTimestamp({ imprint: Buffer.alloc(32, 9) }, { url: 'https://tsa.test/stamp' },
        async () => { throw new Error('ECONNREFUSED'); }),
      (e: unknown) => e instanceof TsaError && e.category === 'AutoridadeIndisponivel'
    );
  });

  test('ACT sem credencial nasce desligada: CredencialInvalida antes da rede', async () => {
    let networkTouched = false;
    await assert.rejects(
      requestTimestamp({ imprint: Buffer.alloc(32, 9) }, { url: 'https://tsa.test/stamp', tokenUrl: 'https://tsa.test/token' },
        async () => { networkTouched = true; return httpStub(200)(); }),
      (e: unknown) => e instanceof TsaError && e.category === 'CredencialInvalida'
    );
    assert.equal(networkTouched, false, 'sem credencial não há bytes na rede');
  });

  test('token endpoint sem credencial é CredencialInvalida', () => {
    process.env.TSA_URL = '';
    delete process.env.TSA_URL;
    assert.equal(tsaConfigFromEnv(), null, 'sem TSA_URL a capacidade fica desligada');
  });
});

function bufferOf(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('políticas do arco ICP-Brasil', () => {
  test('aceita o arco e subarcos; rejeita políticas de terceiros', () => {
    assert.ok(isIcpBrasilPolicy('2.16.76.1'));
    assert.ok(isIcpBrasilPolicy('2.16.76.1.6.2'));
    assert.ok(isIcpBrasilPolicy('2.16.76.1.7.1.11.1.3'));
    assert.ok(!isIcpBrasilPolicy('2.16.840.1.114412.7.1'));
    assert.ok(!isIcpBrasilPolicy('2.16.761.6.2'));
    assert.ok(!isIcpBrasilPolicy(null));
    assert.ok(!isIcpBrasilPolicy(''));
  });

  test('manifesto do trust store registra as seis raízes', () => {
    const manifest = readFileSync(join(ROOTS_DIR, 'manifest.tsv'), 'utf8');
    const rows = manifest.trim().split('\n').slice(1);
    assert.equal(rows.length, 6);
    for (const row of rows) assert.match(row, /acraiz\.icpbrasil\.gov\.br/);
  });
});

// ---------------------------------------------------------------------------
// Embarque PAdES (ByteRange) — pades-embed.ts (J1 #10)
// ---------------------------------------------------------------------------

/** Mini-PDF sintético no MESMO formato do builder de prescrições (xref clássico). */
function miniPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

describe('embarque PAdES em PDF (ByteRange)', () => {
  test('round-trip reserve → embed → read com geometria cobrindo o arquivo', () => {
    const reserved = reserveSignatureSpace(miniPdf(), 4096);
    const geometry = readEmbeddedSignature(reserved);
    assert.ok(geometry, 'reserva legível');
    assert.equal(geometry.byteRange[0], 0);
    assert.equal(geometry.byteRange[3], reserved.length, 'B termina no fim do arquivo');
    assert.equal(reserved[geometry.byteRange[1]], 0x3c, 'início do buraco é <');
    assert.equal(reserved[geometry.byteRange[2] - 1], 0x3e, 'fim do buraco é >');
    // /AcroForm e widget presentes (campo de assinatura invisível).
    assert.ok(reserved.toString('latin1').includes('/AcroForm'));
    assert.ok(reserved.toString('latin1').includes('/FT /Sig'));

    const cms = Buffer.from([0x30, 0x00]); // DER: SEQUENCE vazia
    const embedded = embedSignature(reserved, cms);
    assert.equal(embedded.length, reserved.length, 'embed não muda o tamanho');
    const read = readEmbeddedSignature(embedded);
    assert.ok(read, 'embebido legível');
    assert.deepEqual(read.byteRange, geometry.byteRange, 'ByteRange preservado');
    assert.deepEqual(read.cms, cms, 'CMS round-trip íntegro (padding removido)');
  });

  test('CMS grande demais para a reserva é recusado', () => {
    const reserved = reserveSignatureSpace(miniPdf(), 2048);
    // 1025 bytes = 2050 hex chars > reserva de 2048 → recusado.
    assert.throws(() => embedSignature(reserved, Buffer.alloc(1025)), /excede a reserva/);
  });

  test('1 byte fora do buraco invalida a verificação (J1 #10)', async () => {
    const reserved = reserveSignatureSpace(miniPdf(), 4096);
    const embedded = embedSignature(reserved, Buffer.from([0x30, 0x00]));
    const intact = await verifyEmbeddedSignature(embedded, async (_cms, signed) =>
      ({ signatureValid: signed.subarray(0, 5).toString('latin1') === '%PDF-' }));
    assert.equal(intact.ok, true);
    assert.equal((intact as { ok: true; result: { signatureValid: boolean } }).result.signatureValid, true);

    const tampered = Buffer.from(embedded);
    tampered[2] ^= 0x01; // byte ANTES do buraco (dentro do cabeçalho %PDF)
    const outcome = await verifyEmbeddedSignature(tampered, async (_cms, signed) =>
      ({ signatureValid: signed.subarray(0, 5).toString('latin1') === '%PDF-' }));
    assert.equal(outcome.ok, true, 'geometria continua válida');
    assert.equal((outcome as { ok: true; result: { signatureValid: boolean } }).result.signatureValid, false,
      'o CMS/deveria não confere com o arquivo adulterado');
  });

  test('ByteRange adulterado (geometria) → verificação recusada', async () => {
    const reserved = reserveSignatureSpace(miniPdf(), 4096);
    const embedded = embedSignature(reserved, Buffer.from([0x30, 0x00]));
    const broken = Buffer.from(embedded.toString('latin1').replace('/ByteRange [0000000000', '/ByteRange [0000000001'), 'latin1');
    const outcome = await verifyEmbeddedSignature(broken, async () => ({ signatureValid: true }));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reason, /geometria inválida/);
  });
});
