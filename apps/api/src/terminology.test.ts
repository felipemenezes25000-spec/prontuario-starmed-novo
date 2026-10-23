import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupCid10, normalizeCid10, searchCid10 } from './terminology';

test('normalização do CID-10: caixa, espaços e ponto opcional', () => {
  assert.equal(normalizeCid10(' e119 '), 'E11.9');
  assert.equal(normalizeCid10('I10'), 'I10');
  assert.equal(normalizeCid10('I1'), null);
  assert.equal(normalizeCid10('10I'), null);
});

test('busca por código (prefixo) e por palavras sem acento', () => {
  assert.ok(searchCid10('I10').some(c => c.code === 'I10'));
  assert.ok(searchCid10('hipertensao').some(c => c.code === 'I10'), 'sem acento encontra "Hipertensão"');
  assert.deepEqual(searchCid10('a'), [], 'mínimo de 2 caracteres');
  assert.ok(searchCid10('infeccao', 3).length <= 3);
});

test('lookup: no catálogo local devolve a descrição; fora dele é null (não "inválido")', () => {
  assert.equal(lookupCid10('i10')?.code, 'I10');
  assert.equal(lookupCid10('Z99.9'), null);
});
