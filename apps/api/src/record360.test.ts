import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimelineTypes, toTimelineItem } from './timeline';
import { buildSafetyAlerts, deriveAllergyState, readWeightKg, toAllergyItem, toMedicationItem, weightBasedDoseAlert } from './medications';
import { buildMovedCounts, normalizePatientName, pairDuplicateCandidates } from './mpi';

// Prontuário 360° — só funções PURAS exportadas pelos módulos novos (nenhum
// teste toca banco): mapeamento da timeline, derivação de estado de alergias,
// motor de alerts sobre terapias ativas, normalização/pareamento MPI e
// montagem do moved_counts do merge.

test('normalizePatientName collapses case, trim and inner whitespace', () => {
  assert.equal(normalizePatientName('  Maria   Silva '), 'maria silva');
  assert.equal(normalizePatientName('JOÃO  de\tAlmeida'), 'joão de almeida');
  assert.equal(normalizePatientName('ANA\n Bittencourt'), 'ana bittencourt');
});

test('parseTimelineTypes accepts csv, dedupes canonically and rejects unknown kinds', () => {
  assert.equal(parseTimelineTypes(undefined), undefined);
  assert.equal(parseTimelineTypes('   '), undefined);
  assert.deepEqual(parseTimelineTypes('encounter,note'), ['encounter', 'note']);
  // Dedupe + ordem canônica independente da ordem digitada.
  assert.deepEqual(parseTimelineTypes('note, encounter,NOTE'), ['encounter', 'note']);
  assert.throws(() => parseTimelineTypes('encounter,foo'), /foo/);
});

test('toTimelineItem normalizes UNION rows into the contract shape', () => {
  const item = toTimelineItem({
    kind: 'prescription', id: 'p1', at: '2026-10-20T12:00:00.000Z', status: 'signed',
    author: 'Dra. Ana', title: 'Dipirona', summary: '500mg · oral', meta: { signatureStatus: 'attested' }
  });
  assert.deepEqual(item, {
    kind: 'prescription', id: 'p1', at: '2026-10-20T12:00:00.000Z', status: 'signed',
    author: 'Dra. Ana', title: 'Dipirona', summary: '500mg · oral', meta: { signatureStatus: 'attested' }
  });
  // Documento sem status/summary no schema: honestidade = null; meta default {}.
  const doc = toTimelineItem({
    kind: 'document', id: 'd1', at: new Date('2026-10-19T08:30:00.000Z'), status: null,
    author: null, title: null, summary: null, meta: null
  });
  assert.equal(doc.at, '2026-10-19T08:30:00.000Z');
  assert.equal(doc.status, null);
  assert.equal(doc.author, null);
  assert.equal(doc.title, '');
  assert.equal(doc.summary, null);
  assert.deepEqual(doc.meta, {});
  // Drift de schema (kind fora do contrato) falha fechado, nunca item errado.
  assert.throws(() => toTimelineItem({ kind: 'billing', id: 'x', at: '2026-10-19T08:30:00.000Z', status: null, author: null, title: null, summary: null, meta: null }));
});

test('allergyState distinguishes "nothing recorded" from "no allergies"', () => {
  assert.equal(deriveAllergyState([]), 'none_recorded');
  assert.equal(deriveAllergyState([{ substance: 'Dipirona' }]), 'recorded');
});

test('allergy/medication rows map to camelCase response items', () => {
  assert.deepEqual(toAllergyItem({
    substance: 'Dipirona', criticality: 'high', clinical_status: 'active', verification_status: 'confirmed'
  }), { substance: 'Dipirona', criticality: 'high', clinicalStatus: 'active', verificationStatus: 'confirmed' });
  assert.deepEqual(toMedicationItem({
    id: 'rx1', medication_name: 'Dipirona', dose: '500mg', frequency: '8/8h', route: 'VO',
    status: 'signed', signature_status: 'attested', created_at: new Date('2026-10-20T12:00:00.000Z')
  }), {
    id: 'rx1', medicationName: 'Dipirona', dose: '500mg', frequency: '8/8h', route: 'VO',
    status: 'signed', signatureStatus: 'attested', prescribedAt: '2026-10-20T12:00:00.000Z'
  });
});

test('buildSafetyAlerts: no_allergy_record is patient-level and emitted once', () => {
  const alerts = buildSafetyAlerts(
    [{ id: 'rx1', medication_name: 'Dipirona' }, { id: 'rx2', medication_name: 'Losartana' }], []);
  const info = alerts.filter(a => a.code === 'no_allergy_record');
  assert.equal(info.length, 1);
  assert.equal(info[0].level, 'info');
  assert.equal(info[0].medicationId, null);
});

test('buildSafetyAlerts: critical active allergy blocks the matching medication only', () => {
  const alerts = buildSafetyAlerts(
    [{ id: 'rx1', medication_name: 'Dipirona 500mg' }, { id: 'rx2', medication_name: 'Losartana' }],
    [{ substance: 'dipirona', criticality: 'high', clinical_status: 'active' }]);
  const blocks = alerts.filter(a => a.level === 'block');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].code, 'allergy_high');
  assert.equal(blocks[0].medicationId, 'rx1');
  // Losartana não casa com a alergia: nenhum alerta de alergia para ela.
  assert.equal(alerts.filter(a => a.medicationId === 'rx2').length, 0);
});

test('buildSafetyAlerts: inactive allergies are ignored, noncritical active ones require review', () => {
  const inactive = buildSafetyAlerts(
    [{ id: 'rx1', medication_name: 'Dipirona' }],
    [{ substance: 'dipirona', criticality: 'high', clinical_status: 'resolved' }]);
  assert.equal(inactive.filter(a => a.level !== 'info').length, 0);
  const active = buildSafetyAlerts(
    [{ id: 'rx1', medication_name: 'Dipirona' }],
    [{ substance: 'dipirona', criticality: 'low', clinical_status: 'active' }]);
  assert.equal(active.filter(a => a.code === 'allergy_active' && a.level === 'review_required').length, 1);
});

test('buildSafetyAlerts: duplicate therapy compares a medication only against its peers', () => {
  const two = buildSafetyAlerts(
    [{ id: 'rx1', medication_name: 'Losartana 50mg' }, { id: 'rx2', medication_name: 'Losartana' }],
    [{ substance: 'Dipirona', criticality: 'low', clinical_status: 'active' }]);
  const dup = two.filter(a => a.code === 'duplicate_therapy');
  assert.equal(dup.length, 2);
  assert.equal(dup.find(a => a.medicationId === 'rx1')?.existingPrescriptionId, 'rx2');
  assert.equal(dup.find(a => a.medicationId === 'rx2')?.existingPrescriptionId, 'rx1');
  // Uma única terapia nunca duplica consigo mesma.
  const solo = buildSafetyAlerts(
    [{ id: 'rx1', medication_name: 'Losartana' }],
    [{ substance: 'Dipirona', criticality: 'low', clinical_status: 'active' }]);
  assert.equal(solo.filter(a => a.code === 'duplicate_therapy').length, 0);
});

test('pairDuplicateCandidates matches same normalized name + same birthdate only', () => {
  const index = { id: 'p-1', fullName: 'Maria da Silva', birthDate: '1990-05-01' };
  const pairs = pairDuplicateCandidates(index, [
    { id: 'p-2', fullName: 'MARIA   da   Silva', birthDate: '1990-05-01', externalId: 'ext-2' }, // casa
    { id: 'p-3', fullName: 'Maria da Silva', birthDate: '1991-07-02', externalId: null },        // nascimento diferente
    { id: 'p-4', fullName: 'Ana Oliveira', birthDate: '1990-05-01', externalId: null },          // nome diferente
    { id: 'p-1', fullName: 'Maria da Silva', birthDate: '1990-05-01', externalId: null }         // o próprio índice
  ]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], {
    patient: { id: 'p-2', fullName: 'MARIA   da   Silva', birthDate: '1990-05-01', externalId: 'ext-2' },
    reason: 'same-name-birthdate'
  });
});

test('pairDuplicateCandidates caps the candidate list at 50', () => {
  const index = { id: 'p-0', fullName: 'José Comum', birthDate: '1980-01-01' };
  const pool = Array.from({ length: 60 }, (_, i) =>
    ({ id: `p-${i + 1}`, fullName: 'José  Comum', birthDate: '1980-01-01', externalId: null }));
  assert.equal(pairDuplicateCandidates(index, pool).length, 50);
});

test('buildMovedCounts records only tables with rows actually moved', () => {
  assert.deepEqual(
    buildMovedCounts([
      { table: 'appointments', count: 3 },
      { table: 'encounters', count: 0 },
      { table: 'patient_allergies', count: 1 },
      { table: 'lgpd_requests', count: 0 }
    ]),
    { appointments: 3, patient_allergies: 1 });
  assert.deepEqual(buildMovedCounts([]), {});
});

// ---- Cenário pediatria: dose por peso (informativo, aritmético puro) ----

test('readWeightKg aceita número/string numérica e rejeita lixo clínico', () => {
  assert.equal(readWeightKg({ weightKg: 14.5 }), 14.5);
  assert.equal(readWeightKg({ weightKg: '14.5' }), 14.5);
  assert.equal(readWeightKg({ peso: 14.5 }), null);        // chave errada
  assert.equal(readWeightKg({ weightKg: -3 }), null);       // negativo
  assert.equal(readWeightKg({ weightKg: 'abc' }), null);    // não numérico
  assert.equal(readWeightKg(null), null);
  assert.equal(readWeightKg([14.5]), null);
});

test('weightBasedDoseAlert: mg/kg informativo sem faixa; fora de escopo silencioso', () => {
  const info = weightBasedDoseAlert({
    medicationId: 'rx1', medicationName: 'Dipirona Gotas', doseValue: 200, doseUnit: 'mg', weightKg: 14.5
  });
  assert.ok(info);
  assert.equal(info.level, 'info');
  assert.equal(info.code, 'dose_per_kg');
  assert.match(info.message, /13\.79 mg\/kg/);
  // Honestidade: o alerta DECLARA a ausência de faixa licenciada.
  assert.match(info.message, /sem faixa de referência/);
  assert.match(info.message, /licenciada/);
  // Sem peso => nenhum alerta (nunca inventar).
  assert.equal(weightBasedDoseAlert({ medicationId: 'rx1', medicationName: 'X', doseValue: 200, doseUnit: 'mg', weightKg: null }), null);
  // Unidade fora do escopo (só mg) => nenhum alerta adivinhado.
  assert.equal(weightBasedDoseAlert({ medicationId: 'rx1', medicationName: 'X', doseValue: 5, doseUnit: 'mL', weightKg: 14.5 }), null);
  assert.equal(weightBasedDoseAlert({ medicationId: 'rx1', medicationName: 'X', doseValue: 0, doseUnit: 'mg', weightKg: 14.5 }), null);
});
