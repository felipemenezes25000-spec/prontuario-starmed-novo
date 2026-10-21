/**
 * Jornada 8 — PORTAL DO PACIENTE (Fase 5, ST-P1-008).
 * Prova: ativação com convite single-use, perfil mínimo, CONTEÚDO de documentos
 * (PDF com re-hash + nota assinada) SEM link público, preferências de notificação
 * (opt-out de canal SEMPRE aceito; marketing opt-in), comprovação de entrega com
 * status REAL da fila (nunca "entregue" sem confirmação) e histórico LGPD do
 * titular. Dados 100% sintéticos.
 */
import { test, expect } from '@playwright/test';
import { adminToken, api, nonce, sharedSetupDoctor, syntheticEmail } from './helpers';

const API_URL = (process.env.E2E_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const PORTAL_PASSWORD = 'Portal-Password-E2e-2026';

test.describe('Jornada 8 — portal do paciente', () => {
  let token = '';
  let nameA = '';
  let nameB = '';
  let inviteA = '';
  let inviteB = '';
  const emailA = syntheticEmail('titular-a');
  const emailB = syntheticEmail('titular-b');

  const createPatient = (fullName: string) =>
    api<{ id: string }>('/patients', {
      token, method: 'POST', expected: 201,
      body: { fullName, birthDate: '1983-03-03', administrativeGender: 'female', phone: '+5511988887777' }
    });

  const signNote = async (patientId: string) => {
    const enc = await api<{ id: string }>('/encounters', {
      token, method: 'POST', expected: 201,
      body: { patientId, specialty: 'general', type: 'consultation', reasonForVisit: 'Portal E2E' }
    });
    const draft = await api<{ version: number }>(`/encounters/${enc.id}/notes/draft`, {
      token, method: 'PUT', expected: 200,
      body: {
        operationId: crypto.randomUUID(), expectedVersion: 0, templateId: 'general',
        sections: { assessment: 'Avaliação sintética do portal E2E.', plan: 'Plano sintético do portal.' }
      }
    });
    await api(`/encounters/${enc.id}/notes/sign`, { token, method: 'POST', expected: 201, body: { expectedVersion: draft.version } });
    return enc.id;
  };

  const invite = (patientId: string) =>
    api<{ inviteCode: string }>('/portal/invites', {
      token, method: 'POST', expected: 201, body: { patientId, ttlHours: 1 }
    });

  test.beforeAll(async () => {
    const doc = await sharedSetupDoctor();
    token = doc.token;

    // Titular A: nota assinada + prescrição (PDF) + telefone (canal whatsapp).
    nameA = `Paciente Portal A ${nonce()}`;
    const pa = await createPatient(nameA);
    await signNote(pa.id);
    // prescrição assinada → clinical_documents (PDF no portal)
    const encList = await api<Array<{ id: string }>>(`/encounters?patientId=${pa.id}`, { token });
    const rx = await api<{ id: string }>(`/encounters/${encList[0].id}/prescriptions`, {
      token, method: 'POST', expected: 201,
      body: {
        operationId: crypto.randomUUID(),
        medication: { name: 'Losartana Portal 50 mg', form: 'tablet' },
        dose: { value: 50, unit: 'mg' }, route: 'oral', frequency: '24/24h', duration: '30 dias',
        times: ['08:00'], quantity: 30,
        indication: 'Indicação sintética do portal', instructions: 'Dados sintéticos.'
      }
    });
    await api(`/prescriptions/${rx.id}/sign`, { token, method: 'POST', expected: 201, body: { operationId: crypto.randomUUID() } });
    inviteA = (await invite(pa.id)).inviteCode;

    // Titular B: só nota assinada (UI).
    nameB = `Paciente Portal B ${nonce()}`;
    const pb = await createPatient(nameB);
    await signNote(pb.id);
    inviteB = (await invite(pb.id)).inviteCode;
  });

  test('API: perfil, conteúdo de documentos, prefs/opt-out, comprovação e LGPD', async () => {
    // Ativação com convite single-use → sessão do portal (purpose:'portal').
    const act = await api<{ accessToken: string; activated: boolean }>('/portal/activate', {
      method: 'POST', expected: 201, body: { inviteCode: inviteA, email: emailA, password: PORTAL_PASSWORD }
    });
    expect(act.activated).toBe(true);
    const ptoken = act.accessToken;

    // Perfil mínimo do titular.
    const profile = await api<{ fullName: string; phone: string }>('/portal/me/profile', { token: ptoken });
    expect(profile.fullName).toBe(nameA);
    expect(profile.phone).toBe('+5511988887777');

    // Documentos: nota E pdf com sha256.
    const docs = await api<Array<{ id: string; kind: string; sha256?: string }>>('/portal/me/documents', { token: ptoken });
    const note = docs.find(d => d.kind === 'note');
    const pdf = docs.find(d => d.kind === 'pdf');
    expect(note, 'nota assinada listada').toBeTruthy();
    expect(pdf, 'PDF listado').toBeTruthy();
    expect(pdf!.sha256?.length).toBe(64);

    // CONTEÚDO do PDF: bytes com re-hash NA resposta autenticada (sem link público).
    const pdfRes = await fetch(`${API_URL}/portal/me/documents/${pdf!.id}/content`, {
      headers: { authorization: 'Bearer ' + ptoken }
    });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-type') ?? '').toContain('application/pdf');
    expect(pdfRes.headers.get('content-disposition') ?? '').toContain('inline');
    expect(Buffer.from(await pdfRes.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // CONTEÚDO da nota assinada: JSON com as seções.
    const noteContent = await api<{ sections: Record<string, string> }>(`/portal/me/documents/${note!.id}/content`, { token: ptoken });
    expect(noteContent.sections.assessment).toContain('sintética');

    // Id inexistente →404 honesto.
    await api('/portal/me/documents/00000000-0000-0000-0000-000000000099/content', { token: ptoken, expected: 404 });

    // Preferências: defaults (serviço ligado, marketing NÃO) → opt-out + opt-in.
    const prefs0 = await api<{ prefs: Record<string, boolean> }>('/portal/me/notifications', { token: ptoken });
    expect(prefs0.prefs).toEqual({ whatsapp: true, email: true, sms: true, marketingOptIn: false });
    const prefs1 = await api<{ prefs: Record<string, boolean>; changed: string[] }>('/portal/me/notifications', {
      token: ptoken, method: 'PUT', body: { sms: false, marketingOptIn: true }
    });
    expect(prefs1.prefs.sms).toBe(false);
    expect(prefs1.prefs.marketingOptIn).toBe(true);
    expect(prefs1.changed).toContain('sms');
    // Patch vazio →400; tipo errado →400 (zod strict).
    await api('/portal/me/notifications', { token: ptoken, method: 'PUT', body: {}, expected: 400 });
    await api('/portal/me/notifications', { token: ptoken, method: 'PUT', body: { sms: 'sim' }, expected: 400 });

    // OPT-OUT obrigatório: SMS desligado → send recusa com409; whatsapp segue.
    const vars = { date: '21/10/2026', time: '10:00', clinicName: 'Clínica E2E', email: 'x@example.invalid' };
    const patientAId = (await api<{ id: string }>('/portal/me/profile', { token: ptoken })).id;
    const blocked = await api<{ message: string }>('/portal/notifications/send', {
      token, method: 'POST', expected: 409,
      body: { channel: 'sms', patientId: patientAId, template: 'appointment_reminder', vars }
    });
    expect(blocked.message).toMatch(/opt-out/i);
    const queued = await api<{ status: string; provider: string }>('/portal/notifications/send', {
      token, method: 'POST', expected: 201,
      body: { channel: 'whatsapp', patientId: patientAId, template: 'appointment_reminder', vars }
    });
    expect(queued.status).toBe('queued');
    expect(queued.provider).toBe('desligado'); // sem CRM_PROVIDER_URL: honesto

    // Comprovação de entrega: status REAL da fila (nunca "entregue" sem worker).
    const history = await api<Array<{ channel: string; status: string; template: string }>>(
      '/portal/me/notifications/history', { token: ptoken });
    expect(history.some(h => h.channel === 'whatsapp' && h.status === 'queued')).toBe(true);

    // Pedido de agendamento entra na mesma fila vinculado ao paciente.
    await api('/portal/me/appointment-requests', {
      token: ptoken, method: 'POST', expected: 201,
      body: { preferredSpecialty: 'cardiology', preferredPeriod: 'morning' }
    });
    const history2 = await api<Array<{ template: string }>>('/portal/me/notifications/history', { token: ptoken });
    expect(history2.some(h => h.template === 'appointment_request_received')).toBe(true);

    // LGPD: pedido do titular + histórico (mudou de "recurso indisponível").
    const lgpd = await api<{ kind: string }>('/portal/me/lgpd/requests', {
      token: ptoken, method: 'POST', expected: 201, body: { kind: 'access', channel: 'portal' }
    });
    expect(lgpd.kind).toBe('access');
    const lgpdHistory = await api<Array<{ kind: string; status: string }>>('/portal/me/lgpd/requests', { token: ptoken });
    expect(lgpdHistory.some(r => r.kind === 'access' && r.status === 'requested')).toBe(true);

    // Auditoria do conteúdo com requestId (readback admin).
    const admin = await adminToken();
    const events = await api<Array<{ action: string; details: { requestId?: string; kind?: string } }>>(
      '/audit/events?action=portal.documents.content.read', { token: admin });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(typeof events[0].details.requestId).toBe('string');
  });

  test('UI: ativação com convite → documentos com conteúdo → notificações (opt-out) → perfil', async ({ page }) => {
    // Entrada pública: tela de login da equipe → "Área do paciente".
    await page.goto('/');
    await page.getByRole('button', { name: 'Área do paciente' }).click();
    await expect(page.getByRole('heading', { name: 'Entre na sua área' })).toBeVisible();

    // ATIVAÇÃO via UI (convite single-use do titular B).
    await page.getByRole('button', { name: 'Ativar convite' }).click();
    await page.getByLabel('Código de convite').fill(inviteB);
    await page.getByLabel('E-mail').fill(emailB);
    await page.getByLabel('Nova senha (mínimo de 12 caracteres)').fill(PORTAL_PASSWORD);
    await page.getByRole('button', { name: 'Ativar e entrar' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sua saúde em um só lugar' })).toBeVisible();

    // Documentos: nota listada e conteúdo aberto INLINE (sem link público).
    // Linhas de nota trazem "Assinado em …" (a pílula é "versão N"); PDFs trazem "Emitido em …".
    await expect(page.getByRole('heading', { name: 'Meus documentos' })).toBeVisible();
    const noteRow = page.locator('.list-line').filter({ hasText: 'Assinado em' }).first();
    await expect(noteRow).toBeVisible();
    await noteRow.getByRole('button', { name: 'Abrir conteúdo' }).click();
    await expect(page.getByText(/— assessment —/)).toBeVisible();

    // Notificações: opt-out do SMS pela UI (pilha honesta) + opt-in de marketing.
    await expect(page.getByRole('heading', { name: 'Notificações' })).toBeVisible();
    const smsRow = page.locator('label.portal-consent').filter({ hasText: 'SMS' }).first();
    await expect(smsRow).toContainText('Ativo');
    await smsRow.getByLabel('Receber mensagens de serviço por SMS').uncheck();
    await expect(smsRow).toContainText('Desligado');
    const marketingRow = page.locator('label.portal-consent').filter({ hasText: 'Comunicações de marketing' }).first();
    await marketingRow.getByLabel('Aceito comunicações de marketing').check();
    await expect(marketingRow).toContainText('Aceito');
    // Comprovação: nada gerado para B ainda → estado vazio honesto.
    await expect(page.getByText('Nenhuma mensagem foi gerada para você até agora.')).toBeVisible();
    await expect(page.getByText(/Nunca mostramos .entregue. sem confirmação/)).toBeVisible();

    // Perfil e LGPD com as seções novas (nada de "Recurso indisponível").
    await expect(page.getByRole('heading', { name: 'Meu perfil' })).toBeVisible();
    await expect(page.getByText(nameB)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Solicitações de privacidade' })).toBeVisible();
    await expect(page.getByText(/Recurso indisponível/)).toHaveCount(0);
  });
});
