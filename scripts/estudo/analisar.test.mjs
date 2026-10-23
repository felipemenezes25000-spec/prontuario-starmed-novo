import test from 'node:test';
import assert from 'node:assert/strict';
import { analisar, escoreSus, holm, mcnemarExato, mediana, parseCsv, quartis, relatorio, wilcoxonPareado } from './analisar.mjs';

test('mediana e quartis', () => {
  assert.equal(mediana([3, 1, 2]), 2);
  assert.equal(mediana([4, 1, 2, 3]), 2.5);
  assert.deepEqual(quartis([1, 2, 3, 4, 5]), { q1: 2, q3: 4 });
});

test('Wilcoxon exato: valores conferidos à mão', () => {
  assert.equal(wilcoxonPareado([1, 2, 3, 4, 5]).p, 2 / 32, 'todos positivos, n=5');
  assert.equal(wilcoxonPareado([1, 2, 3, 4, 5, 6, 7, 8]).p, 2 / 256);
  assert.equal(wilcoxonPareado([-1, 2, 3]).p, 0.5, 'W=1 com postos 1,2,3');
  assert.equal(wilcoxonPareado([0, 0]).p, 1, 'zeros descartados');
  const grande = wilcoxonPareado(Array.from({ length: 25 }, (_, i) => i + 1));
  assert.equal(grande.metodo, 'normal');
  assert.ok(grande.p < 0.0001);
});

test('McNemar exato, Holm e SUS', () => {
  assert.equal(mcnemarExato(0, 6), 2 / 64);
  assert.equal(mcnemarExato(3, 3), 1);
  assert.equal(mcnemarExato(0, 0), 1);
  assert.deepEqual(holm([0.01, 0.04, 0.03]).map(p => Math.round(p * 1000) / 1000), [0.03, 0.06, 0.06]);
  assert.equal(escoreSus([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]), 50);
  assert.equal(escoreSus([5, 1, 5, 1, 5, 1, 5, 1, 5, 1]), 100);
  assert.throws(() => escoreSus([1, 2]));
});

test('ponta a ponta com CSV sintético: pares, Holm e relatório sem PHI', () => {
  const linhas = ['participante,sistema,tarefa,tempo_s,sucesso,erro_seguranca_evitado'];
  for (let p = 1; p <= 6; p++) {
    linhas.push(`P0${p},StarMed,T5,${30 + p},sim,sim`, `P0${p},SistemaZ,T5,${50 + p},sim,nao`);
  }
  const sus = ['participante,sistema,q1,q2,q3,q4,q5,q6,q7,q8,q9,q10'];
  for (let p = 1; p <= 6; p++) sus.push(`P0${p},StarMed,5,1,5,1,5,1,5,1,5,1`, `P0${p},SistemaZ,3,3,3,3,3,3,3,3,3,3`);
  const res = analisar(parseCsv(linhas.join('\n')), parseCsv(sus.join('\n')));
  const t5 = res.linhas[0].resultados[0];
  assert.equal(t5.n, 6);
  assert.equal(t5.wil.p, 2 / 64);
  assert.equal(t5.seguranca.b, 6);
  const md = relatorio(res);
  assert.match(md, /StarMed × SistemaZ/);
  assert.match(md, /SUS \(n=6\): StarMed mediana 100\.0 × SistemaZ 50\.0/);
});

test('sorteio: reprodutível pela semente e balanceado por bloco de 4', async () => {
  const { sortear } = await import('./sortear.mjs');
  const a = sortear(16, 20261023), b = sortear(16, 20261023);
  assert.deepEqual(a, b, 'mesma semente, mesmo sorteio');
  assert.notDeepEqual(a, sortear(16, 1));
  assert.equal(a.filter(r => r.primeiro === 'StarMed').length, 8, 'metade começa pela referência');
  assert.equal(a.filter(r => r.conjuntoNoPrimeiro === 'A').length, 8);
});
