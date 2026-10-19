import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMedicationInteractions, isValidCid10 } from './ai-clinical';

test('interação grave: warfarina + AINA', () => {
  const out = checkMedicationInteractions([{ name: 'Warfarina' }, { name: 'Ibuprofeno 600mg' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'high');
  assert.match(out[0].message, /sangramento/i);
});

test('interação grave: estatina + claritromicina (ordem invertida também pega)', () => {
  const a = checkMedicationInteractions([{ name: 'Sinvastatina' }, { name: 'Claritromicina' }]);
  const b = checkMedicationInteractions([{ name: 'claritromicina' }, { name: 'atorvastatina' }]);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'high');
  assert.equal(b.length, 1);
});

test('interação moderada: IECA + espironolactona; metfomina + contraste é alta', () => {
  const ieca = checkMedicationInteractions([{ name: 'Enalapril' }, { name: 'Espironolactona' }]);
  assert.equal(ieca[0]?.severity, 'moderate');
  const met = checkMedicationInteractions([{ name: 'Metformina 850mg' }, { name: 'Contraste iodado' }]);
  assert.equal(met[0]?.severity, 'high');
});

test('sem interação: lista vazia; par inexistente não gera falso positivo', () => {
  assert.deepEqual(checkMedicationInteractions([{ name: 'Losartana' }, { name: 'Omeprazol' }]), []);
  assert.deepEqual(checkMedicationInteractions([{ name: 'Dipirona' }]), []);
});

test('normalização ignora caixa e acentos', () => {
  const out = checkMedicationInteractions([{ name: 'dipirona sódica' }, { name: 'Warfarina' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'moderate');
});

test('CID-10: valida I10/E11.9 e rejeita lixo', () => {
  assert.equal(isValidCid10('I10'), true);
  assert.equal(isValidCid10('E11.9'), true);
  assert.equal(isValidCid10('J06.9AC'), false);
  assert.equal(isValidCid10('10'), false);
  assert.equal(isValidCid10(''), false);
  assert.equal(isValidCid10('hipertensão'), false);
});
