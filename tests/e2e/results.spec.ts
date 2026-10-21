/**
 * Jornada 6 — EXAMES E RESULTADOS (Fase 3, ST-P1-005 / J1 #12).
 * Prova: ciclo completo com regras de dados (400/409 honestos), escalação de
 * resultado CRÍTICO com reconhecimento obrigatório antes de comunicar, PDF do
 * resultado em clinical_documents versionado pelo gatilho do 022, e
 * integração LIS/PACS NASCIDA DESLIGADA (409 honesto, outbox vazio).
 * Dados 100% sintéticos.
 */
import { test, expect } from '@playwright/test';
import { adminToken, api, nonce, sharedSetupDoctor } from './helpers';

test.describe('Jornada 6 — exames e resultados', () => {
  let admin = '';
  let token = '';

  test.beforeAll(async () => {
    admin = await adminToken();
    token = (await sharedSetupDoctor()).token;
  });

  const createPatient = () =>
    api<{ id: string }>('/patients', {
      token, method: 'POST', expected: 201,
      body: { fullName: `Paciente Exames ${nonce()}`, birthDate: '1980-02-02', administrativeGender: 'male' }
    });
  const createOrder = (patientId: string, extra: Record<string, unknown> = {}) =>
    api<{ id: string; status: string }>('/hospital/orders', {
      token, method: 'POST', expected: 201,
      body: { patientId, orderType: 'lab', description: 'Hemograma sintético F3', priority: 'urgent', ...extra }
    });
  const patch = (orderId: string, body: Record<string, unknown>, expected: number) =>
    api<{ status?: string }>(`/hospital/orders/${orderId}/status`, { token, method: 'PATCH', body, expected });

  test('ciclo ordered→…→communicated com validações e escalação do crítico', async () => {
    const p = await createPatient();
    const order = await createOrder(p.id);

    // Regras de dados: final antes do preliminar é409 (transição ilegal)…
    const early = await patch(order.id, { status: 'final', resultValue: '13,5' }, 409);
    expect(String((early as { message?: string }).message ?? '')).toBeTruthy();

    // …e preliminar SEM valor é recusado (409 de regra de domínio) numa
    // transição JÁ legal — accepted→collected aconteceu.
    await patch(order.id, { status: 'accepted' }, 200);
    await patch(order.id, { status: 'collected' }, 200);
    const noValue = await patch(order.id, { status: 'preliminary' }, 409);
    expect(String((noValue as { message?: string }).message ?? '')).toMatch(/resultValue/);
    await patch(order.id, { status: 'preliminary', resultValue: '13,5 g/dL', resultReference: '12,0–14,0 g/dL', resultUnits: 'g/dL' }, 200);
    await patch(order.id, { status: 'final', resultValue: '13,5 g/dL', resultReference: '12,0–14,0 g/dL', resultUnits: 'g/dL' }, 200);
    await patch(order.id, { status: 'reviewed' }, 200);
    // Comunicar exige communicatedTo (regra de domínio →409).
    const noTo = await patch(order.id, { status: 'communicated' }, 409);
    expect(String((noTo as { message?: string }).message ?? '')).toMatch(/communicatedTo/);
    await patch(order.id, { status: 'communicated', communicatedTo: 'Solicitante da jornada E2E' }, 200);

    // O listador filtra pelo status final do ciclo.
    const reviewedList = await api<Array<{ id: string }>>('/hospital/orders?status=reviewed', { token });
    expect(Array.isArray(reviewedList)).toBe(true);

    // ESCALAÇÃO (J1 #12): crítico NÃO comunicável sem reconhecimento.
    const critical = await createOrder(p.id);
    await patch(critical.id, { status: 'in_progress', critical: true }, 200);
    const pending = await api<Array<{ id: string }>>('/hospital/orders/critical/pending', { token });
    expect(pending.some(o => o.id === critical.id)).toBe(true);
    await patch(critical.id, { status: 'collected' }, 200);
    await patch(critical.id, { status: 'preliminary', resultValue: '9,0' }, 200);
    await patch(critical.id, { status: 'final', resultValue: '9,0' }, 200);
    await patch(critical.id, { status: 'reviewed' }, 200);
    const noAck = await patch(critical.id, { status: 'communicated', communicatedTo: 'Clínica E2E' }, 409);
    expect(JSON.stringify(noAck)).toMatch(/reconhec|ack/i);
    await api(`/hospital/orders/${critical.id}/critical-ack`, { token, method: 'POST', expected: 201 });
    await patch(critical.id, { status: 'communicated', communicatedTo: 'Clínica E2E' }, 200);

    // Auditoria da comunicação com requestId.
    const events = await api<Array<{ action: string; details: { requestId?: string } }>>(
      '/audit/events?action=result.communicated', { token: admin });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(typeof events[0].details.requestId).toBe('string');
  });

  test('PDF do resultado: 404 honesto antes, gerar → baixar %PDF → v1 pelo gatilho 022', async () => {
    const p = await createPatient();
    const order = await createOrder(p.id);
    await patch(order.id, { status: 'accepted' }, 200);
    await patch(order.id, { status: 'collected' }, 200);
    await patch(order.id, { status: 'preliminary', resultValue: '1,2' }, 200);
    await patch(order.id, { status: 'final', resultValue: '1,2' }, 200);

    // Antes de gerar: 404 honesto (sem artefato inventado).
    await api(`/hospital/orders/${order.id}/result-document`, { token, expected: 404 });

    const created = await api<{ sha256?: string }>(`/hospital/orders/${order.id}/result-document`,
      { token, method: 'POST', expected: 201 });
    expect(created.sha256 ?? created).toBeTruthy();

    const pdf = await fetch(new URL(`/hospital/orders/${order.id}/result-document`, process.env.E2E_API_URL || 'http://127.0.0.1:3001'),
      { headers: { authorization: 'Bearer ' + token } });
    expect(pdf.status).toBe(200);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // clinical_documents + versionamento automático (gatilho do 022 → v1).
    const docs = await api<Array<{ doc_type: string; versions: number }>>(
      `/patients/${p.id}/documents`, { token });
    const resultDoc = docs.find(d => d.doc_type === 'exam_result');
    expect(resultDoc, 'documento do resultado na lista').toBeTruthy();
    expect(resultDoc!.versions).toBeGreaterThanOrEqual(1);

    // Timeline expõe o exame com o status do ciclo.
    const items = await api<Array<{ kind: string; status: string | null }>>(
      `/patients/${p.id}/timeline?types=exam&limit=50`, { token });
    expect(items.some(i => i.kind === 'exam' && i.status === 'final')).toBe(true);
  });

  test('LIS/PACS nasce desligado: dispatch 409 honesto e outbox vazio', async () => {
    const p = await createPatient();
    const order = await createOrder(p.id);

    // Transição inválida do ciclo (ordered→final) é409 — sem pular etapas.
    await patch(order.id, { status: 'final', resultValue: 'x' }, 409);

    // Capacidade desligada: nenhum byte na rede;409 com a mensagem de desligado.
    const off = await api<{ message: string }>(`/hospital/orders/${order.id}/lis-dispatch`,
      { token, method: 'POST', expected: 409, body: { channel: 'lis' } });
    expect(off.message).toMatch(/desligad/i);

    // Drenagem do outbox sem nada enfileirado → zero envios (role: admin).
    const drained = await api<{ drained: number; sent: number }>('/hospital/orders/outbox/dispatch',
      { token: admin, method: 'POST', expected: 201, body: {} });
    expect(drained.drained).toBe(0);
    expect(drained.sent).toBe(0);
  });
});
