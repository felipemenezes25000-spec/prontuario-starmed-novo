import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, providerPayload, selectBatch } from './dispatch-outbox.mjs';

test('selectBatch: apenas queued e respeita o limite', () => {
  const rows = [
    { id: 1, status: 'queued' },
    { id: 2, status: 'sent' },
    { id: 3, status: 'queued' },
    { id: 4, status: 'failed' },
    { id: 5, status: 'queued' }
  ];
  assert.deepEqual(selectBatch(rows, 2).map((r) => r.id), [1, 3]);
  assert.deepEqual(selectBatch(rows, 10).map((r) => r.id), [1, 3, 5]);
  assert.deepEqual(selectBatch([], 5), []);
});

test('providerPayload: formato de gateway WhatsApp (canal, destino, template renderizado)', () => {
  const payload = providerPayload({
    channel: 'whatsapp',
    recipient: '(11) 99999-0001',
    template: 'appointment_reminder',
    rendered: JSON.stringify({ subject: 'Lembrete', body: 'Olá Maria, sua consulta é em 01/11.' })
  });
  assert.deepEqual(payload, {
    channel: 'whatsapp',
    to: '(11) 99999-0001',
    type: 'template',
    template: { name: 'appointment_reminder', rendered: '{"subject":"Lembrete","body":"Olá Maria, sua consulta é em 01/11."}' }
  });
});

test('classifyResponse: 2xx sent, 429/5xx retry, 4xx failed', () => {
  assert.equal(classifyResponse(200), 'sent');
  assert.equal(classifyResponse(201), 'sent');
  assert.equal(classifyResponse(429), 'retry');
  assert.equal(classifyResponse(503), 'retry');
  assert.equal(classifyResponse(500), 'retry');
  assert.equal(classifyResponse(400), 'failed', 'bad request é definitivo');
  assert.equal(classifyResponse(404), 'failed');
  assert.equal(classifyResponse(422), 'failed');
});
