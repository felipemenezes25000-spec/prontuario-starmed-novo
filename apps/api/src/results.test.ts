import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_STATUSES, ORDER_TRANSITIONS, CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_OPEN_WINDOW_MS, MAX_DISPATCH_ATTEMPTS,
  assertTransition, buildResultPdf, canTransition, channelEnabled, circuitAllows, lisConfigFromEnv,
  nextBackoff, resultDocumentAllowed, retryDecision, validateTransition, type OrderStatus
} from './orders';

// EXAMES E RESULTADOS (ST-P1-005) — só funções PURAS exportadas por orders.ts
// (nenhum teste toca banco nem rede): máquina de transições completa (ciclo novo
// + legados + inválidas), validação de payload por etapa, backoff/DLQ, circuit
// breaker, configuração da integração NASCE DESLIGADA e o builder de PDF.

// ------------------------------------------------------- máquina de estados --

test('ciclo completo: ordered → accepted → collected → preliminary → final → reviewed → communicated', () => {
  assert.deepEqual(ORDER_TRANSITIONS.ordered, ['accepted', 'in_progress', 'cancelled']);
  assert.deepEqual(ORDER_TRANSITIONS.accepted, ['collected', 'cancelled']);
  assert.deepEqual(ORDER_TRANSITIONS.collected, ['preliminary', 'cancelled']);
  assert.deepEqual(ORDER_TRANSITIONS.preliminary, ['final', 'cancelled']);
  assert.deepEqual(ORDER_TRANSITIONS.final, ['reviewed']);
  assert.deepEqual(ORDER_TRANSITIONS.reviewed, ['communicated']);
  assert.deepEqual(ORDER_TRANSITIONS.communicated, []);
});

test('legados preservados (smoke/dados existentes): in_progress → completed|collected|cancelled', () => {
  assert.deepEqual(ORDER_TRANSITIONS.in_progress, ['completed', 'collected', 'cancelled']);
  assert.ok(canTransition('in_progress', 'completed'));
  assert.ok(canTransition('in_progress', 'collected'));
  assert.ok(canTransition('ordered', 'in_progress'), 'o smoke do hospital faz ordered→in_progress');
});

test('terminais: completed, cancelled e communicated não transitam para lugar algum', () => {
  for (const terminal of ['completed', 'cancelled', 'communicated'] as const) {
    assert.deepEqual(ORDER_TRANSITIONS[terminal], [], `${terminal} deve ser terminal`);
    for (const to of ORDER_STATUSES) assert.equal(canTransition(terminal, to), false, `${terminal} → ${to}`);
  }
});

test('inválidas rejeitadas: saltos do ciclo, voltar no fluxo e self-transição', () => {
  const invalid: [OrderStatus, OrderStatus][] = [
    ['ordered', 'collected'], ['ordered', 'preliminary'], ['ordered', 'final'],
    ['ordered', 'reviewed'], ['ordered', 'communicated'], ['ordered', 'completed'],
    ['accepted', 'preliminary'], ['accepted', 'final'], ['accepted', 'communicated'],
    ['collected', 'final'], ['collected', 'reviewed'], ['collected', 'communicated'],
    ['preliminary', 'reviewed'], ['preliminary', 'communicated'],
    ['final', 'communicated'], ['reviewed', 'final'],
    ['cancelled', 'in_progress'], ['completed', 'cancelled'],
    ['ordered', 'ordered'], ['preliminary', 'preliminary'], ['communicated', 'communicated']
  ];
  for (const [from, to] of invalid) assert.equal(canTransition(from, to), false, `${from} → ${to}`);
});

test('assertTransition lança 409 com mensagem clara SEM PHI (só nomes de status)', () => {
  assert.doesNotThrow(() => assertTransition('ordered', 'accepted'));
  assert.doesNotThrow(() => assertTransition('reviewed', 'communicated'));
  assert.throws(() => assertTransition('collected', 'final'), (e: Error & { status?: number }) => {
    assert.match(e.message, /Transição inválida: collected → final/);
    return true;
  });
  // Status fora do vocabulário também é recusado (nunca lança TypeError).
  assert.equal(canTransition('banana', 'final'), false);
  assert.equal(canTransition('ordered', 'banana'), false);
});

test('cobertura total: todo status do vocabulário tem entrada na matriz', () => {
  for (const status of ORDER_STATUSES) {
    assert.ok(Array.isArray(ORDER_TRANSITIONS[status]), `matriz sem entrada para ${status}`);
    for (const to of ORDER_TRANSITIONS[status]) assert.ok(ORDER_STATUSES.includes(to), `destino fora do vocabulário: ${to}`);
  }
});

// -------------------------------------------------- validação de payload ----

const baseFacts = { from: 'preliminary' as OrderStatus, to: 'final' as OrderStatus, payload: { resultValue: '13,5 g/dL' }, order: { critical: false, criticalAckAt: null } };

test('preliminary e final exigem resultValue (trim 1..300)', () => {
  assert.deepEqual(validateTransition({ ...baseFacts, from: 'collected', to: 'preliminary', payload: { resultValue: '13,5 g/dL' } }), []);
  assert.match(validateTransition({ ...baseFacts, from: 'collected', to: 'preliminary', payload: { resultValue: '   ' } })[0], /resultValue/);
  assert.match(validateTransition({ ...baseFacts, from: 'collected', to: 'preliminary', payload: { resultValue: 'x'.repeat(301) } })[0], /resultValue/);
  // final com valor presente passa; sem valor, recusa.
  assert.deepEqual(validateTransition(baseFacts), []);
  assert.equal(validateTransition({ ...baseFacts, payload: {} }).length, 1);
});

test('final exige passar por preliminary (defesa além da matriz)', () => {
  const errors = validateTransition({ ...baseFacts, from: 'collected' as OrderStatus, payload: { resultValue: '13,5 g/dL' } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /preliminary/);
});

test('communicated exige communicatedTo (3..120) e, para crítico, o ack prévio (J1 #12)', () => {
  const facts = { ...baseFacts, from: 'reviewed' as OrderStatus, to: 'communicated' as OrderStatus, order: { critical: false, criticalAckAt: null } };
  assert.match(validateTransition({ ...facts, payload: {} })[0], /communicatedTo/);
  assert.match(validateTransition({ ...facts, payload: { communicatedTo: 'ab' } })[0], /communicatedTo/);
  assert.match(validateTransition({ ...facts, payload: { communicatedTo: 'x'.repeat(121) } })[0], /communicatedTo/);
  assert.deepEqual(validateTransition({ ...facts, payload: { communicatedTo: 'Dr. Recepção por telefone' } }), []);
  // Crítico SEM reconhecimento → recusa honesta; COM ack → passa.
  const criticalNoAck = validateTransition({ ...facts, order: { critical: true, criticalAckAt: null }, payload: { communicatedTo: 'Dr. Ana por telefone' } });
  assert.equal(criticalNoAck.length, 1);
  assert.match(criticalNoAck[0], /critical-ack/);
  assert.deepEqual(validateTransition({ ...facts, order: { critical: true, criticalAckAt: '2026-01-01T00:00:00Z' }, payload: { communicatedTo: 'Dr. Ana por telefone' } }), []);
  // Mensagens nunca ecoam o valor clínico digitado (sem PHI nos erros).
  for (const message of criticalNoAck) assert.ok(!message.includes('Dr. Ana'));
});

test('etapas sem payload (accepted/collected/reviewed/cancelled) não exigem nada', () => {
  for (const [from, to] of [['ordered', 'accepted'], ['accepted', 'collected'], ['final', 'reviewed'], ['ordered', 'cancelled']] as [OrderStatus, OrderStatus][]) {
    assert.deepEqual(validateTransition({ ...baseFacts, from, to, payload: {} }), [], `${from} → ${to}`);
  }
});

test('resultDocumentAllowed cobre exatamente os status com resultado', () => {
  for (const status of ['preliminary', 'final', 'reviewed', 'communicated']) assert.equal(resultDocumentAllowed(status), true);
  for (const status of ['ordered', 'accepted', 'collected', 'in_progress', 'completed', 'cancelled']) assert.equal(resultDocumentAllowed(status), false);
});

// ------------------------------------------------- backoff / DLQ / breaker --

test('nextBackoff: exponencial 2^attempts em minutos com teto de 24h', () => {
  assert.equal(nextBackoff(0), 1);
  assert.equal(nextBackoff(1), 2);
  assert.equal(nextBackoff(2), 4);
  assert.equal(nextBackoff(4), 16);
  assert.equal(nextBackoff(5), 32);
  assert.equal(nextBackoff(11), 1440, 'teto diário evita explosão do horizonte');
  assert.equal(nextBackoff(-3), 1, 'negativo/truncado nunca vira atraso negativo');
});

test('retryDecision: attempts>=5 vira dead (DLQ); abaixo, failed com backoff', () => {
  assert.deepEqual(retryDecision(1), { status: 'failed', delayMinutes: 2 });
  assert.deepEqual(retryDecision(MAX_DISPATCH_ATTEMPTS - 1), { status: 'failed', delayMinutes: 16 });
  assert.deepEqual(retryDecision(MAX_DISPATCH_ATTEMPTS), { status: 'dead', delayMinutes: 0 });
  assert.deepEqual(retryDecision(9), { status: 'dead', delayMinutes: 0 });
  assert.equal(CIRCUIT_FAILURE_THRESHOLD, 5);
});

test('circuitAllows: closed sempre; open só após a janela; half_open libera a sonda', () => {
  const now = new Date('2026-03-01T12:00:00Z');
  const openedFresh = new Date(now.getTime() - 10_000);
  const openedOld = new Date(now.getTime() - CIRCUIT_OPEN_WINDOW_MS);
  assert.equal(circuitAllows('closed', null, now), true);
  assert.equal(circuitAllows('half_open', openedOld, now), true);
  assert.equal(circuitAllows('open', openedFresh, now), false, 'open vigente bloqueia');
  assert.equal(circuitAllows('open', openedOld, now), true, 'janela vencida permite a sonda');
  assert.equal(circuitAllows('open', null, now), false, 'opened_at ausente = fail-closed');
  // Aceita string ISO (TIMESTAMPTZ chega como string) e Date.
  assert.equal(circuitAllows('open', openedOld.toISOString(), now), true);
  assert.equal(circuitAllows('open', 'data-invalida', now), false);
});

// -------------------------------------------- integração nasce DESLIGADA ---

test('lisConfigFromEnv: sem URL a capacidade nasce desligada; LIS_SANDBOX liga o modo simulado', () => {
  assert.deepEqual(lisConfigFromEnv({}), { lisUrl: null, pacsUrl: null, sandbox: false });
  assert.deepEqual(lisConfigFromEnv({ LIS_URL: '  ', PACS_URL: undefined }), { lisUrl: null, pacsUrl: null, sandbox: false });
  assert.equal(channelEnabled(lisConfigFromEnv({}), 'lis'), false, 'sem LIS_URL → desligado');
  assert.equal(channelEnabled(lisConfigFromEnv({}), 'pacs'), false, 'sem PACS_URL → desligado');
  assert.equal(channelEnabled(lisConfigFromEnv({ LIS_URL: 'http://lis.local/hl7' }), 'lis'), true);
  assert.equal(channelEnabled(lisConfigFromEnv({ LIS_URL: 'http://lis.local/hl7' }), 'pacs'), false, 'PACS continua desligado');
  assert.equal(channelEnabled(lisConfigFromEnv({ LIS_SANDBOX: 'true' }), 'lis'), true, 'sandbox simula sem rede');
  assert.equal(lisConfigFromEnv({ LIS_SANDBOX: 'TRUE ' }).sandbox, true);
  assert.equal(lisConfigFromEnv({ LIS_SANDBOX: '1' }).sandbox, false, 'só "true" (case-insensitive) habilita sandbox');
});

// ------------------------------------------------------------- PDF puro ----

test('buildResultPdf: começa com %PDF-, traz descrição/valor e termina com %%EOF', () => {
  const pdf = buildResultPdf({
    orderId: '00000000-0000-4000-8000-000000000001', orderType: 'lab', loincCode: '718-7',
    description: 'Hemoglobina glicada', status: 'final', priority: 'urgent',
    resultValue: '8,2 %', resultReference: 'até 7,0 %', resultUnits: '%',
    generatedAt: '2026-03-01T12:00:00.000Z'
  });
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'), 'deve começar com %PDF-');
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.ok(text.includes('Hemoglobina glicada'), 'descrição do pedido presente');
  assert.ok(text.includes('8,2 %'), 'valor do resultado presente');
  assert.ok(text.includes('RESULTADO DE EXAME'));
  assert.ok(!text.toLowerCase().includes('paciente'), 'PDF do resultado não inclui dado além do pedido');
});

test('buildResultPdf: xref clássico consistente (cada offset aponta para o objeto certo)', () => {
  const pdf = buildResultPdf({
    orderId: '00000000-0000-4000-8000-000000000002', orderType: 'imaging', loincCode: null,
    description: 'Radiografia de tórax (2 críticas) — acentuação: ação', status: 'preliminary', priority: 'routine',
    resultValue: null, resultReference: null, resultUnits: null,
    generatedAt: '2026-03-01T12:00:00.000Z'
  });
  const text = pdf.toString('latin1');
  // startxref aponta para o início da tabela xref.
  const startxref = Number(text.slice(text.lastIndexOf('startxref') + 'startxref'.length).trim().split(/\s+/)[0]);
  assert.ok(Number.isInteger(startxref) && startxref > 0, 'startxref numérico');
  assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref aponta para a tabela xref');
  // Cada entrada "NNNNNNNNNN 00000 n" aponta exatamente para "N 0 obj".
  const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n /gm)];
  assert.equal(entries.length, 5, 'catálogo, páginas, página, conteúdo, fonte');
  entries.forEach((entry, index) => {
    const offset = Number(entry[1]);
    assert.ok(offset > 0 && offset < text.length, `offset ${offset} dentro do arquivo`);
    assert.ok(text.slice(offset).startsWith(`${index + 1} 0 obj`), `entrada ${index + 1} → offset ${offset}`);
  });
  // /Length do stream bate com o byte-length do conteúdo (offsets em Latin-1).
  const lengthMatch = text.match(/<< \/Length (\d+) >>\nstream\n/);
  assert.ok(lengthMatch, 'stream com /Length');
  const streamStart = text.indexOf('stream\n') + 'stream\n'.length;
  const streamEnd = text.indexOf('endstream', streamStart);
  assert.equal(Number(lengthMatch![1]), streamEnd - streamStart, '/Length confere com o stream');
});

test('buildResultPdf: campos ausentes saem como "não informado" (nunca undefined)', () => {
  const text = buildResultPdf({
    orderId: 'o', orderType: 'lab', loincCode: null, description: 'Teste', status: 'preliminary',
    priority: 'routine', resultValue: null, resultReference: null, resultUnits: null,
    generatedAt: '2026-03-01T12:00:00.000Z'
  }).toString('latin1');
  assert.ok(text.includes('LOINC: não informado'));
  assert.ok(text.includes('Valor: não informado'));
  assert.ok(text.includes('Unidades: não informado'));
  assert.ok(!text.includes('undefined'), 'nunca vaza "undefined" para o PDF');
});
