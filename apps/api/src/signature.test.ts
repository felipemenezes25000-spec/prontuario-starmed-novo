import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalContentBytes,
  hashVerifyCode,
  itiQueryTypeToDocumentType,
  normalizeVerifyCode,
  qualifySignature,
  signPadesRequestSchema,
  tsaCategoryToHttpStatus,
  verifyBaseUrl
} from './signature';

// --- Schema zod do sign-pades ---

const validBody = {
  expectedVersion: 2,
  documentType: 'prescription',
  councilNumber: '123456',
  councilState: 'SP',
  signerCertPem: 'x'.repeat(80),
  chainPems: ['y'.repeat(80)],
  privateKeyPkcs8Pem: 'z'.repeat(80)
};

test('signPadesRequestSchema aceita corpo válido e aplica default de requireTimestamp', () => {
  const parsed = signPadesRequestSchema.parse(validBody);
  assert.equal(parsed.requireTimestamp, false);
  assert.equal(signPadesRequestSchema.parse({ ...validBody, requireTimestamp: true }).requireTimestamp, true);
});

test('councilState rejeita nome de estado por extenso e UF fora do padrão', () => {
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, councilState: 'São Paulo' }).success, false);
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, councilState: 'sp' }).success, false);
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, councilState: 'S' }).success, false);
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, councilState: 'RJ' }).success, true);
});

test('councilNumber rejeita valores alfanuméricos ou fora de 4-6 dígitos', () => {
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, councilNumber: '12A45' }).success, false);
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, councilNumber: 'CRM123' }).success, false);
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, councilNumber: '123' }).success, false);
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, councilNumber: '1234567' }).success, false);
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, councilNumber: '1234' }).success, true);
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, councilNumber: '123456' }).success, true);
});

test('documentType só aceita prescription/exam-request e campos desconhecidos são rejeitados', () => {
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, documentType: 'report' }).success, false);
  assert.equal(signPadesRequestSchema.safeParse({ ...validBody, extra: 'nope' }).success, false);
});

// --- Lógica de qualificação (true só com carimbo + OIDs ITI; NULL quando desconhecido) ---

test('qualifySignature: true somente com carimbo aplicado E OIDs ITI', () => {
  assert.equal(qualifySignature(true, true), true);
  assert.equal(qualifySignature(false, true), false);
  assert.equal(qualifySignature(true, false), false);
  assert.equal(qualifySignature(false, false), false);
});

test('qualifySignature: NULL (nunca false silencioso) quando fator é desconhecido', () => {
  assert.equal(qualifySignature(null, true), null);
  assert.equal(qualifySignature(true, null), null);
  assert.equal(qualifySignature(null, null), null);
});

// --- secretCode: normalização (sem hífen/caixa) + sha256 estável ---

test('normalizeVerifyCode remove hífen e normaliza caixa', () => {
  assert.equal(normalizeVerifyCode('AB12-CD34'), 'ab12cd34');
  assert.equal(normalizeVerifyCode('ab12cd34'), 'ab12cd34');
  assert.equal(normalizeVerifyCode('  Ab-12  '), 'ab12');
});

test('hashVerifyCode é estável e insensível a hífen/caixa, sensível ao conteúdo', () => {
  const a = hashVerifyCode('A1B2-C3D4');
  assert.equal(a, hashVerifyCode('a1b2c3d4'));
  assert.equal(a, hashVerifyCode('A1B2-C3D4'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, hashVerifyCode('A1B2-C3D5'));
});

// --- Bytes canônicos do documento assinado ---

const note = {
  noteId: '3f0d6a4c-8f5e-4b2a-9c3d-1a2b3c4d5e6f',
  version: 3,
  content: { sections: { assessment: 'Hipertensão leve', plan: 'IECA + retorno em 30 dias' } }
};

test('canonicalContentBytes: mesmo input produz os mesmos bytes', () => {
  const first = canonicalContentBytes(note);
  const second = canonicalContentBytes({ ...note, content: JSON.parse(JSON.stringify(note.content)) });
  assert.ok(first.equals(second));
  assert.equal(first.toString('hex'), second.toString('hex'));
});

test('canonicalContentBytes: alteração de seção ou versão muda os bytes', () => {
  const base = canonicalContentBytes(note);
  const altered = canonicalContentBytes({
    ...note,
    content: { sections: { assessment: 'Hipertensão leve', plan: 'IECA + retorno em 60 dias' } }
  });
  const bumpedVersion = canonicalContentBytes({ ...note, version: 4 });
  assert.equal(base.equals(altered), false);
  assert.equal(base.equals(bumpedVersion), false);
});

// --- Mapeamento TsaError → status HTTP ---

test('categorias da ACT mapeiam para 502/503/500', () => {
  assert.equal(tsaCategoryToHttpStatus('RequisicaoRecusada'), 502);
  assert.equal(tsaCategoryToHttpStatus('AutoridadeIndisponivel'), 503);
  assert.equal(tsaCategoryToHttpStatus('CredencialInvalida'), 500);
  assert.equal(tsaCategoryToHttpStatus('RespostaInvalida'), 500);
});

// --- Contrato público do validador ITI ---

test('type do Guia ITI mapeia para o tipo interno de documento', () => {
  assert.equal(itiQueryTypeToDocumentType('prescricao'), 'prescription');
  assert.equal(itiQueryTypeToDocumentType('exame'), 'exam-request');
  assert.equal(itiQueryTypeToDocumentType('receita'), null);
  assert.equal(itiQueryTypeToDocumentType(''), null);
});

test('verifyBaseUrl usa VERIFY_BASE_URL sem barra final e cai para o fallback local', () => {
  const previous = process.env.VERIFY_BASE_URL;
  try {
    process.env.VERIFY_BASE_URL = 'https://api.example.br/api/verify/';
    assert.equal(verifyBaseUrl(), 'https://api.example.br/api/verify');
    delete process.env.VERIFY_BASE_URL;
    assert.equal(verifyBaseUrl(), 'http://localhost:3001/api/verify');
  } finally {
    if (previous === undefined) delete process.env.VERIFY_BASE_URL;
    else process.env.VERIFY_BASE_URL = previous;
  }
});
