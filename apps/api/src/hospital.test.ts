import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admit, discharge, occupancyRate, orderTransition, transfer } from './hospital';

test('admissão: só admite paciente sem admissão ativa', () => {
  assert.doesNotThrow(() => admit(null));
  assert.throws(() => admit('admitted'), /já tem admissão ativa/);
  assert.throws(() => admit('transferred'), /já tem admissão ativa/);
});

test('transferência e alta exigem admissão ativa', () => {
  assert.doesNotThrow(() => transfer('admitted'));
  assert.throws(() => transfer('discharged'), /exige admissão ativa/);
  assert.doesNotThrow(() => discharge('admitted'));
  assert.throws(() => discharge('transferred'), /exige admissão ativa/);
});

test('pedidos: matriz de transições completa', () => {
  assert.doesNotThrow(() => orderTransition('ordered', 'in_progress'));
  assert.doesNotThrow(() => orderTransition('ordered', 'cancelled'));
  assert.doesNotThrow(() => orderTransition('in_progress', 'completed'));
  assert.doesNotThrow(() => orderTransition('in_progress', 'cancelled'));
  assert.throws(() => orderTransition('ordered', 'completed'), /Transição inválida/);
  assert.throws(() => orderTransition('completed', 'cancelled'), /Transição inválida/);
  assert.throws(() => orderTransition('cancelled', 'in_progress'), /Transição inválida/);
  assert.throws(() => orderTransition('completed', 'completed'), /Transição inválida/);
});

test('taxa de ocupação: arredondamento e divisão por zero', () => {
  assert.equal(occupancyRate(10, 3), 0.3);
  assert.equal(occupancyRate(3, 1), 0.333);
  assert.equal(occupancyRate(0, 0), 0);
});
