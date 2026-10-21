import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { examinationScore, goldenToPrediction, normalizeText, scoreCase, setScores, summarizeScores, tokenScores } from './ai-eval';

// Fase 8 (ST-P1-013) — avaliador da extração de IA: scorer PURO sobre o
// dataset sintético (scripts/ai/dataset/cases.json). Sem PHI: tudo fictício.

test('setScores: acerto total, parcial e ausência', () => {
  assert.deepEqual(setScores(['I10'], ['I10']), { precision: 1, recall: 1, f1: 1 });
  assert.deepEqual(setScores([], []), { precision: 1, recall: 1, f1: 1 });
  const parcial = setScores(['I10', 'J069'], ['I10']);
  assert.equal(parcial.precision, 0.5);
  assert.equal(parcial.recall, 1);
  assert.equal(parcial.f1, 0.6667);
  assert.deepEqual(setScores([], ['I10']), { precision: 0, recall: 0, f1: 0 });
  assert.deepEqual(setScores(['I10'], []), { precision: 0, recall: 0, f1: 0 });
});

test('setScores: medicamento casa por normalização e substring', () => {
  assert.equal(setScores(['Losartana 50 mg'], ['losartana']).f1, 1);
  assert.equal(setScores(['Metformina'], ['metformina 850']).f1, 1);
});

test('tokenScores: cobertura da queixa e punição de texto vazio', () => {
  const perfeito = tokenScores('Dor de cabeça e tontura', ['dor', 'cabeca', 'tontura']);
  assert.equal(perfeito.recall, 1);
  const vazio = tokenScores(undefined, ['dor', 'cabeca']);
  assert.equal(vazio.f1, 0);
  assert.equal(tokenScores('', []).f1, 1);
});

test('examinationScore: binário por presença de conteúdo', () => {
  assert.equal(examinationScore('Pressão elevada sem déficit.', true), 1);
  assert.equal(examinationScore('Pressão elevada sem déficit.', false), 0);
  assert.equal(examinationScore('', true), 0);
  assert.equal(examinationScore(null, false), 1);
});

test('summarizeScores: média macro dos casos', () => {
  const a = scoreCase('a', { cid10: ['I10'], medications: ['losartana'], complaint: 'dor de cabeça', examination: 'Pressão fictícia elevada.' },
    { cid10: ['I10'], medications: ['losartana'], complaintTokens: ['dor', 'cabeca'], examinationPresent: true });
  const b = scoreCase('b', { cid10: ['J069'], medications: [], complaint: '', examination: null },
    { cid10: ['I10'], medications: [], complaintTokens: ['tosse'], examinationPresent: false });
  const s = summarizeScores([a, b]);
  assert.equal(s.cases, 2);
  assert.equal(s.cid10.f1, 0.5);
  assert.equal(s.examination, 1);
  assert.ok(s.macroF1 > 0 && s.macroF1 <= 1);
});

test('dataset sintético:8 casos fictícios, CID no formato brasileiro e self-score1.0', () => {
  const dataset = JSON.parse(readFileSync(resolve(__dirname, '../../../scripts/ai/dataset/cases.json'), 'utf8'));
  assert.equal(dataset.length, 8);
  const CID10 = /^[A-Z][0-9]{2}(\.[0-9]{1,4})?$/;
  for (const c of dataset) {
    assert.ok(c.transcript.startsWith('DADO FICTÍCIO'), `${c.id} sem marcação de dado fictício`);
    for (const code of c.golden.cid10) assert.match(code, CID10, `${c.id} com CID inválido: ${code}`);
    // Sanidade: o scorer devolve perfeição quando a predição É o golden.
    const s = scoreCase(c.id, goldenToPrediction(c.golden), c.golden);
    assert.equal(summarizeScores([s]).macroF1, 1, `${c.id} não pontuou1.0 no self-check`);
  }
  // Normalização compartilhada com o produto (sem acento).
  assert.equal(normalizeText('Náusea  e  dor'), 'nausea e dor');
});
