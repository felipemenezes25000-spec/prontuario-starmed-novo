import { test } from 'node:test';
import assert from 'node:assert/strict';
import { administrationDuplicateKey, administrationSchema, antimicrobial344Enabled } from './hospital';

// ------------------------------------------------------------------ Flag 344
test('flag 344: ausente ou com valor não-explícito mantém o programa DESLIGADO', () => {
  assert.equal(antimicrobial344Enabled({}), false);
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: undefined }), false);
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: '' }), false);
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: 'false' }), false);
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: 'off' }), false);
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: '0' }), false);
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: 'lixo' }), false);
});

test('flag 344: só liga com 1/true/on/yes (case-insensitive)', () => {
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: '1' }), true);
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: 'true' }), true);
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: 'TRUE' }), true);
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: 'on' }), true);
  assert.equal(antimicrobial344Enabled({ FEATURE_ANTIMICROBIAL_344: 'yes' }), true);
});

// ------------------------------------------------- Schema da administração
test('schema da administração: estrito, limits e obrigatórios', () => {
  assert.equal(administrationSchema.safeParse({ medicationName: 'Dipirona 500mg' }).success, true);
  // .strict(): campos desconhecidos são rejeitados (sem surpresa de payload)
  assert.equal(administrationSchema.safeParse({ medicationName: 'Dipirona', extra: 1 }).success, false);
  // medicationName: obrigatório, 1..200
  assert.equal(administrationSchema.safeParse({}).success, false);
  assert.equal(administrationSchema.safeParse({ medicationName: '' }).success, false);
  assert.equal(administrationSchema.safeParse({ medicationName: ' '.repeat(3) }).success, false);
  assert.equal(administrationSchema.safeParse({ medicationName: 'x'.repeat(201) }).success, false);
  // opcionais com limits 1..N (string vazia não vale "presente")
  assert.equal(administrationSchema.safeParse({ medicationName: 'A', dose: '' }).success, false);
  assert.equal(administrationSchema.safeParse({ medicationName: 'A', route: 'x'.repeat(81) }).success, false);
  assert.equal(administrationSchema.safeParse({ medicationName: 'A', barcode: 'x'.repeat(121) }).success, false);
  assert.equal(administrationSchema.safeParse({ medicationName: 'A', note: 'x'.repeat(501) }).success, false);
  // prescriptionId: só uuid
  assert.equal(administrationSchema.safeParse({ medicationName: 'A', prescriptionId: 'não-uuid' }).success, false);
  assert.equal(administrationSchema.safeParse({ medicationName: 'A', prescriptionId: '4c6f2f3c-0000-4000-8000-000000000001' }).success, true);
});

test('schema da administração: administeredAt é ISO e aceita no máximo +5min', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(administrationSchema.safeParse({ medicationName: 'A', administeredAt: past }).success, true);
  const soon = new Date(Date.now() + 2 * 60_000).toISOString();
  assert.equal(administrationSchema.safeParse({ medicationName: 'A', administeredAt: soon }).success, true);
  const far = new Date(Date.now() + 30 * 60_000).toISOString();
  assert.equal(administrationSchema.safeParse({ medicationName: 'A', administeredAt: far }).success, false);
  assert.equal(administrationSchema.safeParse({ medicationName: 'A', administeredAt: 'ontem' }).success, false);
});

// --------------------------------------------- Checagem de duplicidade (409)
test('chave de duplicidade: mesma admissão+medicamento+minuto colide (normaliza texto e segundos)', () => {
  const base = { admissionId: 'ad-1', medicationName: '  Dipirona 500mg ', administeredAt: '2025-01-01T10:15:07.000Z' };
  const sameMinute = { ...base, administeredAt: '2025-01-01T10:15:59.123Z' };
  const upperCase = { ...base, medicationName: 'DIPIRONA   500MG' };
  const otherMedication = { ...base, medicationName: 'Dipirona 250mg' };
  const otherMinute = { ...base, administeredAt: '2025-01-01T10:16:00.000Z' };
  const otherAdmission = { ...base, admissionId: 'ad-2' };
  assert.equal(administrationDuplicateKey(base), administrationDuplicateKey(sameMinute));
  assert.equal(administrationDuplicateKey(base), administrationDuplicateKey(upperCase));
  assert.notEqual(administrationDuplicateKey(base), administrationDuplicateKey(otherMedication));
  assert.notEqual(administrationDuplicateKey(base), administrationDuplicateKey(otherMinute));
  assert.notEqual(administrationDuplicateKey(base), administrationDuplicateKey(otherAdmission));
});

test('chave de duplicidade: Date e ISO equivalem; data inválida nunca casa com válida', () => {
  const fromIso = administrationDuplicateKey({ admissionId: 'a', medicationName: 'X', administeredAt: '2025-01-01T10:15:07.000Z' });
  const fromDate = administrationDuplicateKey({ admissionId: 'a', medicationName: 'X', administeredAt: new Date('2025-01-01T10:15:07.000Z') });
  assert.equal(fromIso, fromDate);
  const invalid1 = administrationDuplicateKey({ admissionId: 'a', medicationName: 'X', administeredAt: 'data-invalida' });
  const invalid2 = administrationDuplicateKey({ admissionId: 'a', medicationName: 'X', administeredAt: 'outra-invalida' });
  assert.notEqual(invalid1, fromIso);
  // Inválidas caem no sentinel canônico 'invalid-date' — no banco isso é
  // impossível (coluna NOT NULL DEFAULT now), então o sentinel não afeta o409 real.
  assert.equal(invalid1, invalid2);
});
