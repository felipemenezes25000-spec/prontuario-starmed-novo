import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  generateInviteCode, iceConfigFromEnv, isValidInvite, nextSeq, normalizeInvite,
  signPatientRoomToken, transitionRoom, verifyPatientRoomToken
} from './teleconsult';

// Fase 4 (ST-P1-007) — só funções PURAS + round-trip do token de sala.
// AUTH_SECRET de teste definido ANTES das chamadas (roomKey() é lazy).

before(() => {
  process.env.AUTH_SECRET = 'teleconsult-room-test-secret-0123456789abcdef';
});

test('transitionRoom: waiting+join→open, open+bye→closed, inválidas recusadas', () => {
  assert.equal(transitionRoom('waiting', 'join'), 'open');
  assert.equal(transitionRoom('open', 'bye'), 'closed');
  assert.throws(() => transitionRoom('closed', 'join'), /Transição inválida/);
  assert.throws(() => transitionRoom('waiting', 'bye'), /Transição inválida/);
});

test('nextSeq é monotônico', () => {
  assert.equal(nextSeq(0), 1);
  assert.equal(nextSeq(41), 42);
});

test('convite: normalização, formato e single-use/expiração/hash', () => {
  assert.equal(normalizeInvite('ab-cd ef/gh'), 'ABCDEFGH');
  const code = generateInviteCode();
  assert.equal(code.length, 20);
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
  // isValidInvite usa sha256 do código normalizado — montamos o row com o hash real.
  const hash = createHash('sha256').update(normalizeInvite(code)).digest('hex');
  const fresh = { code_hash: hash, expires_at: new Date(Date.now() + 60_000), used_at: null as Date | null };
  assert.equal(isValidInvite(fresh, code, new Date()), true);
  assert.equal(isValidInvite({ ...fresh, used_at: new Date() }, code, new Date()), false, 'single-use');
  assert.equal(isValidInvite(fresh, code, new Date(Date.now() + 120_000)), false, 'expirado');
  assert.equal(isValidInvite({ ...fresh, code_hash: 'outro' }, code, new Date()), false, 'hash divergente');
});

test('token de sala do paciente: round-trip e roomId casado', async () => {
  const token = await signPatientRoomToken('11111111-2222-3333-4444-555555555555', 'org-1');
  const claims = await verifyPatientRoomToken(token, '11111111-2222-3333-4444-555555555555');
  assert.equal(claims.purpose, 'teleconsult-room');
  assert.equal(claims.kind, 'patient');
  assert.equal(claims.org, 'org-1');
  // roomId de OUTRA sala → 401 (token não é passe livre).
  await assert.rejects(
    verifyPatientRoomToken(token, '99999999-2222-3333-4444-555555555555'),
    /inválida ou expirada/);
  // Token adulterado → 401.
  await assert.rejects(verifyPatientRoomToken(token + 'x', claims.roomId), /inválida ou expirada/);
  // SECRET diferente → 401 (assinatura não confere).
  process.env.AUTH_SECRET = 'outro-secret-totalmente-diferente-0123456789';
  await assert.rejects(verifyPatientRoomToken(token, claims.roomId), /inválida ou expirada/);
  process.env.AUTH_SECRET = 'teleconsult-room-test-secret-0123456789abcdef';
});

test('iceConfigFromEnv: ausente→P2P sem servidores; JSON válido→parseia; inválido→aviso honesto', () => {
  assert.deepEqual(iceConfigFromEnv(undefined), { iceServers: [] });
  assert.deepEqual(iceConfigFromEnv('   '), { iceServers: [] });
  const valid = iceConfigFromEnv('[{"urls":"stun:stun.example:3478"}]');
  assert.equal(valid.iceServers.length, 1);
  assert.equal(valid.iceServers[0].urls, 'stun:stun.example:3478');
  const broken = iceConfigFromEnv('{not-json');
  assert.deepEqual(broken.iceServers, []);
  assert.match(broken.warning ?? '', /inválido/);
  const notArray = iceConfigFromEnv('{"urls":"x"}');
  assert.deepEqual(notArray.iceServers, []);
  assert.match(notArray.warning ?? '', /inválido/);
});
