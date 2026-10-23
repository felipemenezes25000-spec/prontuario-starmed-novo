import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codeHmac, codeMatches, newAccessCode, newVerification, normalizeAccessCode, patientInitials, publicStatus, rxVerifyUrl,
} from './rx-verify';
import { buildPrescriptionPdf } from './prescriptions';

test('código: 8 símbolos Crockford em 2 grupos; normalização tolera O/0, I/L/1 e separadores', () => {
  const code = newAccessCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizeAccessCode(' 7k2m-9qxa '), '7K2M9QXA');
  assert.equal(normalizeAccessCode('O1IL'), '0111');
});

test('HMAC com sal por documento: o mesmo código gera hashes diferentes em documentos diferentes', () => {
  const a = newVerification(), b = newVerification();
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= 32, 'token de 192 bits em base64url');
  assert.notDeepEqual(codeHmac(a.salt, 'ABCD-EFGH'), codeHmac(b.salt, 'ABCD-EFGH'));
  assert.equal(codeMatches(a.salt, a.hmac, a.code.toLowerCase()), true);
  assert.equal(codeMatches(a.salt, a.hmac, 'ZZZZ-ZZZZ'), false);
});

test('situação pública: cancelada, vencida (por data civil), válida e não emitida', () => {
  assert.equal(publicStatus({ status: 'cancelled', valid_until: null }, '2026-10-23'), 'cancelled');
  assert.equal(publicStatus({ status: 'signed', valid_until: '2026-10-22' }, '2026-10-23'), 'expired');
  assert.equal(publicStatus({ status: 'signed', valid_until: '2026-10-23' }, '2026-10-23'), 'valid', 'último dia ainda vale');
  assert.equal(publicStatus({ status: 'signed', valid_until: null }, '2026-10-23'), 'valid');
  assert.equal(publicStatus({ status: 'draft', valid_until: null }, '2026-10-23'), 'not_issued');
});

test('iniciais do paciente sem conectivos e URL configurável', () => {
  assert.equal(patientInitials('Maria da Silva Souza'), 'M. S. S.');
  assert.equal(rxVerifyUrl('tok', { RX_VERIFY_BASE_URL: 'https://exemplo.invalid/verificar/' }), 'https://exemplo.invalid/verificar/tok');
  assert.equal(rxVerifyUrl('tok', { WEB_ORIGIN: 'https://app.invalid' }), 'https://app.invalid/verificar/tok');
});

test('PDF imprime URL + código e desenha o QR (retângulos no content stream)', () => {
  const base = {
    prescriptionId: 'p', encounterId: 'e', orgName: 'Org', patientName: 'Paciente Fictício', patientBirthDate: '1990-01-01',
    prescriberName: 'Dra Fictícia', medicationName: 'Medicamento Fictício', medicationForm: 'tablet', medicationConcentration: '10 mg',
    doseText: '10 mg', route: 'oral', frequency: '8/8h', duration: '5 dias', times: ['08:00'], quantity: 10,
    indication: 'Teste', instructions: 'Teste', signedAt: '2026-10-23T12:00:00Z', payloadSha256: 'x',
  };
  const withV = buildPrescriptionPdf({ ...base, verification: { url: 'https://app.invalid/verificar/abc', code: 'ABCD-EFGH' } }).toString('latin1');
  assert.ok(withV.includes('ABCD-EFGH') && withV.includes('https://app.invalid/verificar/abc'));
  assert.ok((withV.match(/ re\n/g) ?? []).length > 100, 'módulos do QR desenhados');
  const without = buildPrescriptionPdf(base).toString('latin1');
  assert.equal((without.match(/ re\n/g) ?? []).length, 0);
});
