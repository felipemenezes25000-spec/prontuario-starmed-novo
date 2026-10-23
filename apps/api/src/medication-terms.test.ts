import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDrug, kindSubstanceConflict, regulatedSubstance, sameActiveIngredient } from './medication-terms';
import { evaluatePrescriptionSafety } from './prescriptions';

test('nome comercial → princípio ativo, com dose/forma no texto e sem acento', () => {
  assert.equal(canonicalDrug('Rivotril 2 mg comprimido'), 'clonazepam');
  assert.equal(canonicalDrug('NOVALGINA 500mg'), 'dipirona');
  assert.equal(canonicalDrug('Ácido valpróico 250 mg'), 'acido valproico');
  assert.equal(canonicalDrug('Medicamento Fictício 10 mg'), null, 'desconhecido é null, não "seguro"');
});

test('mesmo princípio ativo: marca × genérico casam; desconhecidos nunca', () => {
  assert.equal(sameActiveIngredient('Tylenol 750 mg', 'Paracetamol 500 mg'), true);
  assert.equal(sameActiveIngredient('Losartana 50 mg', 'Enalapril 10 mg'), false);
  assert.equal(sameActiveIngredient('Fictício A', 'Fictício B'), false);
});

test('substâncias reguladas: controle especial e antimicrobiano', () => {
  assert.deepEqual(regulatedSubstance('Rivotril 2 mg'), { substance: 'clonazepam', regulatedAs: 'controlled_special' });
  assert.deepEqual(regulatedSubstance('Amoxil 500 mg'), { substance: 'amoxicilina', regulatedAs: 'antimicrobial' });
  assert.equal(regulatedSubstance('Losartana 50 mg'), null);
});

test('tipo × substância: guarda conservadora (só bloqueia)', () => {
  assert.match(String(kindSubstanceConflict('simple', 'Clonazepam 2 mg')), /Portaria SVS\/MS 344/);
  assert.match(String(kindSubstanceConflict('antimicrobial', 'Fluoxetina 20 mg')), /controle especial/);
  assert.match(String(kindSubstanceConflict('simple', 'Azitromicina 500 mg')), /RDC Anvisa 471/);
  assert.equal(kindSubstanceConflict('antimicrobial', 'Azitromicina 500 mg'), null);
  assert.equal(kindSubstanceConflict('simple', 'Losartana 50 mg'), null);
  assert.equal(kindSubstanceConflict('simple', 'Medicamento Fictício 10 mg'), null);
});

test('segurança: alergia e duplicidade casam pelo princípio ativo', () => {
  const alerts = evaluatePrescriptionSafety({
    medicationName: 'Novalgina 500 mg',
    allergies: [{ substance: 'Dipirona', criticality: 'high', clinical_status: 'active' }],
    activePrescriptions: [{ id: 'rx-1', medication_name: 'Metamizol 1 g' }],
  });
  assert.deepEqual(alerts.map(a => a.code).sort(), ['allergy_high', 'duplicate_therapy']);
});
