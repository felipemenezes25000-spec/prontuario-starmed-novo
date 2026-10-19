import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateInviteCode, isValidInvite, nextSeq, normalizeInvite, transitionRoom } from './teleconsult';
import { sha256Hex } from './security';

test('máquina de estados: waiting + join → open; open + bye → closed', () => {
  assert.equal(transitionRoom('waiting', 'join'), 'open');
  assert.equal(transitionRoom('open', 'bye'), 'closed');
});

test('máquina de estados: transições inválidas são rejeitadas', () => {
  assert.throws(() => transitionRoom('waiting', 'bye'), /Transição inválida/);
  assert.throws(() => transitionRoom('closed', 'join'), /Transição inválida/);
  assert.throws(() => transitionRoom('open', 'join'), /Transição inválida/);
});

test('seq da fila de sinais é monotônico', () => {
  assert.equal(nextSeq(0), 1);
  assert.equal(nextSeq(41), 42);
});

test('código de convite: 20 caracteres, alfabeto sem ambíguos', () => {
  const code = generateInviteCode();
  assert.equal(code.length, 20);
  assert.match(code, /^[A-HJ-NP-Z2-9]{20}$/);
  assert.notEqual(code, generateInviteCode(), 'códigos consecutivos devem diferir');
});

test('normalização do convite ignora caixa e separadores', () => {
  assert.equal(normalizeInvite('abcd-efgh jkmn'), 'ABCDEFGHJKMN');
  const code = generateInviteCode();
  assert.equal(normalizeInvite(code.toLowerCase()), code);
  assert.equal(normalizeInvite(code.replace(/(.{5})/g, '$1-')), code);
});

test('convite válido: hash confere, não usado e não expirado', () => {
  const code = generateInviteCode();
  const row = { code_hash: sha256Hex(normalizeInvite(code)), expires_at: new Date(Date.now() + 3600_000), used_at: null };
  assert.equal(isValidInvite(row, code, new Date()), true);
  assert.equal(isValidInvite(row, code.toLowerCase(), new Date()), true, 'caixa não importa');
});

test('convite: single-use e expiração bloqueiam', () => {
  const code = generateInviteCode();
  const base = { code_hash: sha256Hex(normalizeInvite(code)) };
  const used = { ...base, expires_at: new Date(Date.now() + 3600_000), used_at: new Date() };
  assert.equal(isValidInvite(used, code, new Date()), false, 'já usado');
  const expired = { ...base, expires_at: new Date(Date.now() - 1000), used_at: null };
  assert.equal(isValidInvite(expired, code, new Date()), false, 'expirado');
  const wrong = { ...base, expires_at: new Date(Date.now() + 3600_000), used_at: null };
  assert.equal(isValidInvite(wrong, 'ZZZZZZZZZZZZZZZZZZZZ', new Date()), false, 'código errado');
});
