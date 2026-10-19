import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  base32Decode, base32Encode, buildOtpauthUri, generateRecoveryCodes, generateTotpSecret,
  hotp, normalizeRecoveryCode, recoveryCodeHash, totpAt, verifyTotp
} from './totp';
import { openSecret, sealSecret } from './security';
import { buildAuthorizationUrl, pkcePair } from './sso';
import { mfaActivateSchema, mfaRecoverySchema, mfaVerifySchema } from './domain';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

test('base32 encodes per RFC 4648 vectors', () => {
  assert.equal(base32Encode(Buffer.from('')), '');
  assert.equal(base32Encode(Buffer.from('f')), 'MY');
  assert.equal(base32Encode(Buffer.from('fo')), 'MZXQ');
  assert.equal(base32Encode(Buffer.from('foo')), 'MZXW6');
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar');
  assert.throws(() => base32Decode('MZXW6YTBO1'), /base32/);
});

test('HOTP matches RFC 4226 test vectors', () => {
  const expected = ['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489'];
  expected.forEach((code, counter) => assert.equal(hotp(RFC_SECRET, BigInt(counter)), code));
});

test('TOTP matches RFC 6238 SHA-1 test vectors', () => {
  const vectors: Array<[number, string, string]> = [
    [59, '94287082', '287082'],
    [1111111109, '07081804', '081804'],
    [1111111111, '14050471', '050471'],
    [1234567890, '89005924', '005924'],
    [2000000000, '69279037', '279037'],
    [20000000000, '65353130', '353130']
  ];
  for (const [seconds, eightDigits, sixDigits] of vectors) {
    assert.equal(totpAt(RFC_SECRET, seconds * 1000, 8), eightDigits);
    assert.equal(totpAt(RFC_SECRET, seconds * 1000, 6), sixDigits);
  }
});

test('verifyTotp accepts the adjacent window and rejects drift outside it', () => {
  const t = 1111111109 * 1000;
  const code = totpAt(RFC_SECRET, t);
  assert.equal(verifyTotp(RFC_SECRET, code, t), true);
  assert.equal(verifyTotp(RFC_SECRET, code, t + 30_000), true); // +1 period
  assert.equal(verifyTotp(RFC_SECRET, code, t + 60_000), false); // +2 periods is outside window=1
  assert.equal(verifyTotp(RFC_SECRET, code, t + 60_000, 2), true); // accepted with a wider window
  assert.equal(verifyTotp(RFC_SECRET, code, t + 90_000), false);
  assert.equal(verifyTotp(RFC_SECRET, code, t - 90_000), false);
});

test('verifyTotp rejects malformed codes without leaking', () => {
  const t = 1111111109 * 1000;
  assert.equal(verifyTotp(RFC_SECRET, '28708', t), false);   // 5 digits
  assert.equal(verifyTotp(RFC_SECRET, '2870823', t), false); // 7 digits
  assert.equal(verifyTotp(RFC_SECRET, 'abcdef', t), false);
  assert.equal(verifyTotp(RFC_SECRET, '', t), false);
});

test('generated TOTP secret round-trips through verification', () => {
  const { secretBase32, key } = generateTotpSecret();
  assert.equal(secretBase32.length, 32); // 20 bytes in base32
  assert.deepEqual(base32Decode(secretBase32), key);
  const code = totpAt(key, Date.now());
  assert.equal(verifyTotp(key, code, Date.now()), true);
});

test('otpauth URI carries the interoperability parameters', () => {
  const uri = buildOtpauthUri({ account: 'ana@ehr.local', issuer: 'starmed-local', secretBase32: 'MZXW6YTBOI' });
  assert.ok(uri.startsWith('otpauth://totp/starmed-local%3Aana%40ehr.local?'));
  const params = new URL(uri.replace('otpauth://totp/', 'https://x/')).searchParams;
  assert.equal(params.get('secret'), 'MZXW6YTBOI');
  assert.equal(params.get('algorithm'), 'SHA1');
  assert.equal(params.get('digits'), '6');
  assert.equal(params.get('period'), '30');
  assert.equal(params.get('issuer'), 'starmed-local');
});

test('recovery codes are unique, formatted and normalization-stable', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const sample = codes[0];
  const stripped = sample.replace('-', '').toLowerCase();
  assert.equal(normalizeRecoveryCode(stripped), sample.replace('-', ''));
  assert.equal(recoveryCodeHash(sample), recoveryCodeHash(stripped));
  assert.notEqual(recoveryCodeHash(sample), recoveryCodeHash(codes[1]));
});

test('sealed secrets round-trip and tampering is detected', () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-only-secret-with-at-least-32-characters';
  const sealed = sealSecret('JBSWY3DPEHPK3PXP');
  assert.ok(sealed.startsWith('v1.'));
  assert.ok(!sealed.includes('JBSWY3DPEHPK3PXP'));
  assert.equal(openSecret(sealed), 'JBSWY3DPEHPK3PXP');
  const [v, iv, tag, ct] = sealed.split('.');
  assert.throws(() => openSecret([v, iv, tag, ct.slice(0, -2) + (ct.endsWith('AA') ? 'BB' : 'AA')].join('.')));
});

test('PKCE pair is S256-compliant', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
});

test('authorization URL includes PKCE and anti-replay parameters', () => {
  const url = new URL(buildAuthorizationUrl({ authorization_endpoint: 'https://idp.example/authorize' }, {
    clientId: 'starmed', redirectUri: 'https://api.example/auth/sso/callback',
    state: 'st', nonce: 'n1', codeChallenge: 'ch', scopes: 'openid email'
  }));
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'starmed');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://api.example/auth/sso/callback');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('nonce'), 'n1');
  assert.equal(url.searchParams.get('code_challenge'), 'ch');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid email');
});

test('MFA schemas reject malformed verification payloads', () => {
  assert.equal(mfaVerifySchema.safeParse({ mfaToken: 'x'.repeat(30), code: '123456' }).success, true);
  assert.equal(mfaVerifySchema.safeParse({ mfaToken: 'x'.repeat(30), code: '12345' }).success, false);
  assert.equal(mfaVerifySchema.safeParse({ mfaToken: 'x'.repeat(30), code: '123456', extra: 1 }).success, false);
  assert.equal(mfaActivateSchema.safeParse({ code: '000000' }).success, true);
  assert.equal(mfaRecoverySchema.safeParse({ mfaToken: 'x'.repeat(30), recoveryCode: 'abc' }).success, false);
});
