import test from 'node:test';
import assert from 'node:assert/strict';
import { compareIdentity, identityQuality, jaroWinkler, normalizeMpiName, type MpiPerson } from './mpi-matcher';

const P = (over: Partial<MpiPerson>): MpiPerson =>
  ({ id: 'x', name: 'Maria da Silva', birthDate: '1980-05-10', sex: 'female', phone: null, cpf: null, cns: null, ...over });

test('Jaro-Winkler: valores de referência clássicos', () => {
  assert.equal(Math.round(jaroWinkler('martha', 'marhta') * 1000) / 1000, 0.961);
  assert.equal(Math.round(jaroWinkler('dwayne', 'duane') * 1000) / 1000, 0.84);
  assert.equal(jaroWinkler('', ''), 1);
  assert.equal(jaroWinkler('abc', ''), 0);
});

test('nome normalizado: sem acento, partículas e pontuação', () => {
  assert.equal(normalizeMpiName('José  da SILVA-Júnior'), 'jose silva junior');
});

test('determinístico: CPF igual é a mesma pessoa; CPFs diferentes são pessoas diferentes (gêmeos)', () => {
  assert.equal(compareIdentity(P({ cpf: '52998224725' }), P({ name: 'Outro Nome', cpf: '529.982.247-25' })).classification, 'definite');
  const twins = compareIdentity(P({ cpf: '52998224725' }), P({ cpf: '11144477735' }));
  assert.equal(twins.classification, 'non_match');
  assert.equal(twins.hardConflict, true);
});

test('probabilístico: sem nome da mãe (peso 20 no ref) o teto é 73 — nunca "provável"; vai à revisão como "possível"', () => {
  const a = P({});
  const typo = compareIdentity(a, P({ name: 'Maria Silva' }));
  assert.equal(typo.score, 65);
  assert.equal(typo.classification, 'possible');
  const swapped = compareIdentity(a, P({ name: 'Maria Silva', birthDate: '1980-10-05' }));
  assert.equal(swapped.features.nascimento, 10);
  assert.equal(swapped.classification, 'non_match', '35+10+5 = 50 fica abaixo da revisão (60)');
  const withPhone = compareIdentity(P({ phone: '11987654321' }), P({ name: 'Maria Silva', phone: '(11) 98765-4321' }));
  assert.equal(withPhone.score, 73, 'teto: 35 nome + 25 nascimento + 5 sexo + 8 telefone');
  assert.equal(withPhone.classification, 'possible');
  assert.equal(compareIdentity(a, P({ name: 'João Pereira', birthDate: '1955-01-01', sex: 'male' })).classification, 'non_match');
});

test('features só com pesos (sem valor comparado) e qualidade de identidade', () => {
  const s = compareIdentity(P({}), P({ name: 'Maria Silva' }));
  assert.ok(!JSON.stringify(s).toLowerCase().includes('maria'));
  assert.deepEqual(identityQuality(P({})), { score: 25, missing: ['CPF', 'CNS', 'telefone'] });
});
