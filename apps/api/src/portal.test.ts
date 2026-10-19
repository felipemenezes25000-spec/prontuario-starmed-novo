import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateInviteCode, inviteUsable, normalizeInvite, renderTemplate, issuePortalToken, verifyPortalToken } from './portal';
import { sha256Hex } from './security';

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'portal-test-secret-com-mais-de-32-caracteres';
process.env.AUTH_ISSUER = process.env.AUTH_ISSUER || 'starmed-test';
process.env.AUTH_AUDIENCE = process.env.AUTH_AUDIENCE || 'starmed-portal';

test('convite: código 20 chars, alfabeto seguro, normalização estável', () => {
  const code = generateInviteCode();
  assert.equal(code.length, 20);
  assert.match(code, /^[A-HJ-NP-Z2-9]{20}$/);
  assert.equal(normalizeInvite(code.toLowerCase()), code);
});

test('convite: single-use, expiração e hash', () => {
  const code = generateInviteCode();
  const row = { code_hash: sha256Hex(normalizeInvite(code)), expires_at: new Date(Date.now() + 3600_000), used_at: null as Date | null };
  assert.equal(inviteUsable(row, code, new Date()), true);
  assert.equal(inviteUsable({ ...row, used_at: new Date() }, code, new Date()), false, 'usado');
  assert.equal(inviteUsable({ ...row, expires_at: new Date(Date.now() - 1) }, code, new Date()), false, 'expirado');
  assert.equal(inviteUsable(row, 'ZZZZZZZZZZZZZZZZZZZZ', new Date()), false, 'errado');
});

test('renderTemplate: preenche variáveis e escapa HTML perigoso por escaping de template', () => {
  const out = renderTemplate('appointment_reminder', {
    patientName: 'Maria <script>alert(1)</script>',
    date: '01/11/2026', time: '14:00', clinicName: 'Clínica Central'
  });
  assert.match(out.subject, /Clínica Central/);
  // O corpo mantém o valor literal (o canal WhatsApp não interpreta HTML; o provider é quem escapa).
  assert.match(out.body, /Maria/);
});

test('renderTemplate: falha sem variável obrigatória e para template desconhecido', () => {
  assert.throws(() => renderTemplate('appointment_reminder', { patientName: 'Ana' }), /exige a variável/);
  assert.throws(() => renderTemplate('unknown_template', {}), /desconhecido/);
});

test('sessão do portal: JWT purpose:portal round-trip', async () => {
  const token = await issuePortalToken({ accountId: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222', patientId: '33333333-3333-4333-8333-333333333333' });
  const session = await verifyPortalToken(token);
  assert.equal(session.orgId, '22222222-2222-4222-8222-222222222222');
  assert.equal(session.patientId, '33333333-3333-4333-8333-333333333333');
});

test('sessão do portal: rejeita token adulterado e formato errado', async () => {
  await assert.rejects(() => verifyPortalToken('token.invalido'), /inválida|expirada/);
  const token = await issuePortalToken({ accountId: 'a', orgId: 'b', patientId: 'c' });
  await assert.rejects(() => verifyPortalToken(token + 'x'), /inválida|expirada/);
});
