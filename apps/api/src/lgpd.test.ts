import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymizationPatch, buildExportPackage, deletionVerdict } from './lgpd';

test('pacote de exportação: campos obrigatórios e aviso legal presente', () => {
  const pack = buildExportPackage({
    patient: { id: 'p1', full_name: 'Maria' },
    allergies: [{ substance: 'Dipirona' }],
    conditions: [{ display: 'Hipertensão' }],
    consents: [{ purpose: 'treatment', granted: true }],
    auditTrail: [{ action: 'patient.search' }]
  });
  assert.equal(pack.patient.full_name, 'Maria');
  assert.equal(pack.allergies.length, 1);
  assert.match(pack.notice, /LGPD art\. 18/);
  assert.ok(Number.isFinite(Date.parse(pack.generatedAt)));
});

test('anonimização: remove identificadores diretos, preserva estrutura', () => {
  const patch = anonymizationPatch();
  assert.equal(patch.full_name, '[ANONIMIZADO]');
  assert.equal(patch.phone, null);
  assert.equal(patch.insurance_id, null);
  assert.equal(patch.social_determinants, '{}');
});

test('exclusão: recusa quando há prontuário assinado (art. 16/I)', () => {
  const blocked = deletionVerdict(true);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /obrigação legal/);
  assert.match(blocked.reason!, /art\. 16/);
});

test('exclusão: permite anonimização quando não há documento assinado', () => {
  const allowed = deletionVerdict(false);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, undefined);
});
