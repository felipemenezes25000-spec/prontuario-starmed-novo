import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCrm, fhirPatientIdentifiers, formatCns, formatCpf, identifyDocument,
  isValidCnpj, isValidCns, isValidCpf, maskCpf, FHIR_SYSTEM_CNS, FHIR_SYSTEM_CPF,
} from './br-identifiers';

// Todos os números abaixo são exemplos públicos de documentação/sintéticos
// (mesmos do repositório de referência), sem titular real conhecido.
const CPF = '52998224725';
const CNS = '709002863635814';
const CNPJ = '11222333000181';

test('CPF: dígitos verificadores, máscara de entrada e sequências uniformes', () => {
  assert.equal(isValidCpf(CPF), true);
  assert.equal(isValidCpf('529.982.247-25'), true);
  assert.equal(isValidCpf('529.982.247-26'), false, 'DV trocado');
  assert.equal(isValidCpf('11111111111'), false, 'sequência uniforme passa no cálculo e não é CPF');
  assert.equal(isValidCpf('5299822472'), false, '10 dígitos');
  assert.equal(isValidCpf(null), false);
});

test('CNS: soma ponderada múltipla de 11 e primeiro dígito 1/2/7/8/9', () => {
  assert.equal(isValidCns(CNS), true);
  assert.equal(isValidCns('709 0028 6363 5814'), true);
  assert.equal(isValidCns('709002863635815'), false);
  assert.equal(isValidCns('300000000000000'), false, 'prefixo 3 não existe');
  assert.equal(isValidCns('70900286363581'), false, '14 dígitos');
});

test('CNPJ: dígitos verificadores e sequência uniforme', () => {
  assert.equal(isValidCnpj(CNPJ), true);
  assert.equal(isValidCnpj('11.222.333/0001-81'), true);
  assert.equal(isValidCnpj('11.222.333/0001-82'), false);
  assert.equal(isValidCnpj('00000000000000'), false);
});

test('CRM: formato + UF (não há DV nacional); normaliza "CRM/SP 123.456"', () => {
  assert.deepEqual(checkCrm('CRM/SP 123.456', 'sp'), { ok: true, number: '123456', state: 'SP' });
  assert.equal(checkCrm('12', 'SP').ok, false, 'curto demais');
  assert.equal(checkCrm('12345678', 'SP').ok, false, 'longo demais');
  assert.equal(checkCrm('111111', 'SP').ok, false, 'sequência uniforme');
  assert.equal(checkCrm('123456', 'XX').ok, false, 'UF inexistente');
});

test('exibição: máscara conservadora (2 últimos dígitos) e formatos de leitura', () => {
  assert.equal(maskCpf(CPF), '***.***.***-25');
  assert.equal(maskCpf('123'), null);
  assert.equal(formatCpf(CPF), '529.982.247-25');
  assert.equal(formatCns(CNS), '709 0028 6363 5814');
});

test('identifyDocument: só dispara com número completo e válido', () => {
  assert.deepEqual(identifyDocument('529.982.247-25'), { kind: 'cpf', value: CPF });
  assert.deepEqual(identifyDocument('709 0028 6363 5814'), { kind: 'cns', value: CNS });
  assert.equal(identifyDocument('529.982.247-26'), null);
  assert.equal(identifyDocument('Maria'), null);
  assert.equal(identifyDocument(''), null);
});

test('FHIR: identificadores com NamingSystems da RNDS, só quando presentes', () => {
  assert.deepEqual(fhirPatientIdentifiers({ cpf: CPF, cns: CNS, external_id: 'EXT-1' }), [
    { system: FHIR_SYSTEM_CPF, value: CPF },
    { system: FHIR_SYSTEM_CNS, value: CNS },
    { system: 'urn:starmed:external-id', value: 'EXT-1' },
  ]);
  assert.deepEqual(fhirPatientIdentifiers({ external_id: null }), []);
});
