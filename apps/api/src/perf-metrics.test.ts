import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRouteKey, percentile, perfSnapshot, recordSample, summarize } from './perf-metrics';

// Fase 7 (ST-P1-012) — métricas de desempenho SEM PHI: só funções puras
// (normalização de rota, percentis, agregação) + gravação em amostra limitada.

test('normalizeRouteKey remove ids, códigos longos e query — sem PHI por construção', () => {
  assert.equal(normalizeRouteKey('GET', '/patients/6f1d2c3b-1111-2222-3333-444455556666/allergies'),
    'GET /patients/:id/allergies');
  assert.equal(normalizeRouteKey('POST', '/hospital/orders/123/status?x=1'), 'POST /hospital/orders/:id/status');
  assert.equal(normalizeRouteKey('GET', '/teleconsult/rooms/ABCDEFGHJKMNPQRSTUVWXYZ2345/signals'),
    'GET /teleconsult/rooms/:id/signals');
  assert.equal(normalizeRouteKey('GET', '/health'), 'GET /health');
  // Nunca guarda fragmento de query (podem conter termos de busca).
  assert.equal(normalizeRouteKey('GET', '/patients?q=Maria-Rara'), 'GET /patients');
});

test('percentile: p50/p95 sobre amostra ordenada com arredondamento', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  const seq = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(percentile(seq, 50), 50);
  assert.equal(percentile(seq, 95), 95);
});

test('recordSample + summarize: contagem, taxa de erro e janela', () => {
  const local = new Map<string, { durations: number[]; ok: number; err: number; since: number }>();
  const put = (key: string, ms: number, ok: boolean) => {
    let b = local.get(key);
    if (!b) { b = { durations: [], ok: 0, err: 0, since: 1 }; local.set(key, b); }
    if (ok) b.ok += 1; else b.err += 1;
    b.durations.push(ms);
  };
  put('GET /health', 10, true);
  put('GET /health', 30, true);
  put('GET /health', 50, false);
  put('ui:sign_note', 100, true);
  const out = summarize(local);
  const health = out.find(x => x.key === 'GET /health');
  assert.ok(health);
  assert.equal(health.count, 3);
  assert.equal(health.errorRate, 0.3333);
  assert.equal(health.p50, 30);
  assert.equal(out.find(x => x.key === 'ui:sign_note')?.p95, 100);
  // Amostragem nunca cresce além do teto (testado via recordSample real).
  for (let i = 0; i < 2500; i++) recordSample('GET /quota', i, i % 2 === 0);
  const snap = perfSnapshot();
  const quota = snap.find(x => x.key === 'GET /quota');
  assert.ok(quota);
  assert.equal(quota.count, 2500, 'contador total preservado');
});
