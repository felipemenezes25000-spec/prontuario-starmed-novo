import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ageInYears, antimicrobialRxEnabled, brazilDate, complianceMissing, formatPhone, kindAvailability,
  kindBlockReason, validUntil,
} from './prescription-compliance';

const REG = { councilNumber: '123456', councilState: 'SP', professionalAddress: 'Rua Fictícia, 100 - São Paulo/SP' };
const PATIENT = { administrativeGender: 'female', birthDate: '1990-05-20' };

test('tipos: simples liberado; antimicrobiano só com flag explícita; controle especial sempre bloqueado', () => {
  assert.equal(kindBlockReason('simple', {}), null);
  assert.match(String(kindBlockReason('antimicrobial', {})), /FEATURE_ANTIMICROBIAL_RX/);
  assert.equal(kindBlockReason('antimicrobial', { FEATURE_ANTIMICROBIAL_RX: 'on' }), null);
  assert.equal(antimicrobialRxEnabled({ FEATURE_ANTIMICROBIAL_RX: 'talvez' }), false);
  assert.match(String(kindBlockReason('controlled_special', { FEATURE_ANTIMICROBIAL_RX: 'on' })), /SNCR/);
  const avail = kindAvailability({});
  assert.deepEqual(avail.map(a => [a.kind, a.enabled]), [['simple', true], ['antimicrobial', false], ['controlled_special', false]]);
});

test('todo tipo exige CRM/UF válido do prescritor', () => {
  assert.deepEqual(complianceMissing({ kind: 'simple', patient: PATIENT, registration: REG }), []);
  assert.deepEqual(complianceMissing({ kind: 'simple', patient: PATIENT, registration: null }).map(m => m.field), ['prescritor.crm']);
  assert.deepEqual(complianceMissing({ kind: 'simple', patient: PATIENT, registration: { councilNumber: '111111', councilState: 'SP' } })
    .map(m => m.field), ['prescritor.crm']);
});

test('antimicrobiano exige sexo informado e endereço profissional; CPF não é exigido', () => {
  assert.deepEqual(complianceMissing({ kind: 'antimicrobial', patient: PATIENT, registration: REG }), []);
  const fields = complianceMissing({
    kind: 'antimicrobial', patient: { administrativeGender: 'unknown', birthDate: '1990-05-20' },
    registration: { councilNumber: '123456', councilState: 'SP' },
  }).map(m => m.field);
  assert.deepEqual(fields, ['paciente.sexo', 'prescritor.endereco']);
});

test('validade do antimicrobiano: 10 dias contando a emissão, no fuso de Brasília', () => {
  // 2026-10-23T02:30Z ainda é 22/10 em Brasília (UTC-3): a contagem começa em 22/10.
  assert.equal(brazilDate(new Date('2026-10-23T02:30:00Z')), '2026-10-22');
  assert.equal(validUntil('antimicrobial', new Date('2026-10-23T02:30:00Z')), '2026-10-31');
  assert.equal(validUntil('antimicrobial', new Date('2026-12-28T15:00:00Z')), '2027-01-06', 'vira o ano');
  assert.equal(validUntil('simple', new Date()), null);
});

test('idade em anos completos e formatação de telefone', () => {
  assert.equal(ageInYears('1990-10-23', new Date('2026-10-23T15:00:00Z')), 36);
  assert.equal(ageInYears('1990-10-24', new Date('2026-10-23T15:00:00Z')), 35);
  assert.equal(formatPhone('11987654321'), '(11) 98765-4321');
  assert.equal(formatPhone('1133334444'), '(11) 3333-4444');
});
