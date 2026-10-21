/**
 * Jornada 7 — TELECONSULTA (Fase 4, ST-P1-007): mídia real browser↔browser com
 * dispositivos FAKE (config do Playwright), consentimento obrigatório, convite
 * single-use, token de sala do paciente em memória, estados de conexão e
 * reconexão após queda de rede simulada, encerramento por `bye`.
 * Dados 100% sintéticos.
 */
import { test, expect } from '@playwright/test';
import { DOCTOR_PASSWORD, api, nonce, sharedSetupDoctor } from './helpers';

type Room = { id: string; status: string; inviteCode: string };

test.describe('Jornada 7 — teleconsulta', () => {
  let token = '';
  let doctorEmail = '';
  let encounterId = '';
  let roomId = '';
  let inviteCode = '';

  test.beforeAll(async () => {
    const doc = await sharedSetupDoctor();
    token = doc.token;
    doctorEmail = doc.email;
    const patient = await api<{ id: string }>('/patients', {
      token, method: 'POST', expected: 201,
      body: { fullName: `Paciente Teleconsulta ${nonce()}`, birthDate: '1975-06-06', administrativeGender: 'unknown' }
    });
    const enc = await api<{ id: string }>('/encounters', {
      token, method: 'POST', expected: 201,
      body: { patientId: patient.id, specialty: 'general', type: 'teleconsultation', reasonForVisit: 'Teleconsulta sintética F4' }
    });
    encounterId = enc.id;
    const room = await api<Room>('/teleconsult/rooms', {
      token, method: 'POST', expected: 201, body: { encounterId }
    });
    roomId = room.id;
    inviteCode = room.inviteCode;
  });

  test('pareamento completo: consentimento → mídia → Conectado → reconexão → encerrar', async ({ browser }) => {
    const origin = process.env.E2E_WEB_URL || 'http://127.0.0.1:5174';

    // ---------- EQUIPE (contexto 1) — permissões de mídia explícitas ----------
    const staffCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const staff = await staffCtx.newPage();
    // Diagnóstico de rede/signaling (logs já são sem PHI no código do componente).
    staff.on('console', m => { if (m.text().includes('[teleconsult]')) console.log('[staff-console]', m.text()); });
    await staff.goto('/');
    await staff.getByLabel('E-mail institucional').fill(doctorEmail);
    await staff.getByLabel('Senha', { exact: true }).fill(DOCTOR_PASSWORD);
    await staff.getByRole('button', { name: 'Entrar no sistema' }).click();
    await expect(staff.getByText('Bom atendimento começa')).toBeVisible();
    await staff.getByRole('button', { name: 'Teleconsulta', exact: true }).click();
    await expect(staff.getByRole('heading', { level: 1, name: 'Teleconsulta' })).toBeVisible();

    // Honestidade de gravação: o padrão declarado é visível antes de qualquer entrada.
    await expect(staff.getByText('Gravação: desligada (padrão deste ambiente — armazenamento de mídia é pendência LGPD/DPO)', { exact: false }).first()).toBeVisible();

    // Carrega a sala (estado) e prova o BLOQUEIO sem consentimento (client + server).
    await staff.getByLabel('Sala (UUID)').fill(roomId);
    await staff.getByRole('button', { name: 'Recarregar estado' }).click();
    await staff.getByRole('button', { name: 'Entrar da sala' }).click();
    await expect(staff.locator('.notice.error')).toContainText('Registre o consentimento');
    await expect(staff.getByText('Conexão: Conectando')).toHaveCount(0);

    // Consentimento RECUSADO (gravação segue desligada) → libera a entrada.
    await staff.getByLabel('Consentimento').selectOption('false');
    await staff.getByRole('button', { name: 'Registrar consentimento' }).click();
    await expect(staff.getByText('Consentimento de gravação registrado.')).toBeVisible();
    await staff.getByRole('button', { name: 'Entrar da sala' }).click();
    // Diagnóstico: se a mídia falhar, o motivo aparece no log do run.
    const mediaErr = await staff.locator('.inline-error').allTextContents().catch(() => [] as string[]);
    if (mediaErr.length) console.log('[tc:staff] mediaError:', mediaErr.join(' | '));
    await expect(staff.getByTestId('tc-video-local')).toBeVisible();
    await expect(staff.getByText('Conexão: Conectando')).toBeVisible();

    // ---------- PACIENTE (contexto 2) — link compartilhado + convite single-use ----------
    const patientCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const patient = await patientCtx.newPage();
    patient.on('console', m => { if (m.text().includes('[teleconsult]')) console.log('[patient-console]', m.text()); });
    patient.on('requestfailed', r => console.log(`[patient-net] FALHOU ${r.method()} ${r.url()} → ${r.failure()?.errorText ?? '?'}`));
    patient.on('response', r => { if (r.url().includes(':3001')) console.log(`[patient-net] ${r.status()} ${r.request().method()} ${r.url()}`); });
    await patient.goto(`${origin}/#teleconsult=${roomId}`);
    await expect(patient.getByRole('heading', { level: 1, name: 'Teleconsulta do paciente' })).toBeVisible();
    await patient.getByLabel('Código de convite').fill(inviteCode);
    await patient.getByRole('button', { name: 'Entrar na teleconsulta' }).click();
    await expect(patient.getByTestId('tc-video-local')).toBeVisible();
    await expect(patient.getByText('Você entrou na teleconsulta.', { exact: false })).toBeVisible();

    // WebRTC REAL: a equipe alcança 'Conectado' (ICE host no mesmo host do CI).
    await expect(staff.getByText('Conexão: Conectado')).toBeVisible({ timeout: 45_000 });
    // Trilha remota recebida (vídeo do paciente chegando na equipe).
    const remoteTracks = await staff.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>('[data-testid="tc-video-remote"]');
      return v?.srcObject ? v.srcObject.getVideoTracks().length : -1;
    });
    expect(remoteTracks).toBeGreaterThan(0);

    // ---------- REDE DEGRADADA: queda do CANAL DE SINALIZAÇÃO no paciente ----------
    // (setOffline do Playwright afeta HTTP — a sinalização —; a mídia UDP do
    // WebRTC pode seguir viva: por isso o estado degradado é o do canal de sinais,
    // medido no PRÓPRIO paciente que ficou offline.)
    await patientCtx.setOffline(true);
    await expect(patient.getByText('Conexão: Reconectando…')).toBeVisible({ timeout: 30_000 });
    await patientCtx.setOffline(false);
    // Recuperação: a fila volta e o badge volta ao estado do WebRTC real.
    await expect(patient.getByText('Conexão: Conectado')).toBeVisible({ timeout: 45_000 });

    // ---------- ENCERRAMENTO: bye da equipe fecha a sala nos dois lados ----------
    await staff.getByRole('button', { name: 'Encerrar' }).click();
    await expect(staff.getByText('Sala encerrada — crie uma nova sala', { exact: false })).toBeVisible();
    await expect(patient.getByText('Sala encerrada pelo profissional.')).toBeVisible({ timeout: 15_000 });
    const roomState = await api<{ status: string }>(`/teleconsult/rooms/${roomId}`, { token });
    expect(roomState.status).toBe('closed');

    await patientCtx.close();
    await staffCtx.close();
  });

  test('regras do servidor: convite single-use, consentimento, token de sala e ICE', async () => {
    // Sala2 (encounter2 — o encounter tem UNIQUE de sala).
    const enc2 = await api<{ id: string }>('/encounters', {
      token, method: 'POST', expected: 201,
      body: { patientId: (await api<{ patient_id: string }>(`/encounters/${encounterId}`, { token })).patient_id, specialty: 'general', type: 'teleconsultation', reasonForVisit: 'Segunda teleconsulta sintética' }
    });
    const room2 = await api<{ id: string; inviteCode: string }>('/teleconsult/rooms', {
      token, method: 'POST', expected: 201, body: { encounterId: enc2.id }
    });

    // (a) Entrar sem consentimento →409 E o convite NÃO é queimado.
    const noConsent = await api<{ message: string }>(`/teleconsult/rooms/${room2.id}/join-patient`,
      { method: 'POST', expected: 409, body: { inviteCode: room2.inviteCode } });
    expect(noConsent.message).toMatch(/consentimento/i);
    // (b) Join staff sem consentimento também →409.
    await api(`/teleconsult/rooms/${room2.id}/join`, { token, method: 'POST', expected: 409 });

    // (c) Consentimento registrado → paciente entra UMA vez e ganha token de sala.
    await api(`/teleconsult/rooms/${room2.id}/consent`, { token, method: 'POST', expected: 201, body: { recordingConsent: false } });
    const joined = await api<{ status: string; patientToken: string }>(`/teleconsult/rooms/${room2.id}/join-patient`,
      { method: 'POST', expected: 201, body: { inviteCode: room2.inviteCode } });
    expect(joined.patientToken.length).toBeGreaterThan(20);

    // (d) Sinais do paciente COM token funcionam; SEM token →401.
    const sig = await api<{ seq: number }>(`/teleconsult/rooms/${room2.id}/signals/patient`, {
      method: 'POST', expected: 201,
      headers: { 'x-teleconsult-token': joined.patientToken },
      body: { kind: 'ice', senderKind: 'patient', payload: { candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host' } } }
    });
    expect(sig.seq).toBe(1);
    await api(`/teleconsult/rooms/${room2.id}/signals/patient`, { method: 'POST', expected: 401, body: { kind: 'ice', senderKind: 'patient' } });
    const polled = await api<Array<{ seq: number }>>(`/teleconsult/rooms/${room2.id}/signals/patient?after=0`,
      { headers: { 'x-teleconsult-token': joined.patientToken } });
    expect(polled.some(r => r.seq === 1)).toBe(true);

    // (e) Convite SINGLE-USE: o segundo join (mesmo válido) →401.
    const reuse = await api<{ message: string }>(`/teleconsult/rooms/${room2.id}/join-patient`,
      { method: 'POST', expected: 401, body: { inviteCode: room2.inviteCode } });
    expect(reuse.message).toMatch(/inválido|expirado/i);

    // (f) ICE config: sem env → P2P direto (shape honesto).
    const ice = await api<{ iceServers: unknown[] }>('/teleconsult/ice-config');
    expect(Array.isArray(ice.iceServers)).toBe(true);
    expect(ice.iceServers.length).toBe(0);

    // (g) bye do paciente encerra a sala; sinal posterior →409.
    await api(`/teleconsult/rooms/${room2.id}/signals/patient`, {
      method: 'POST', expected: 201,
      headers: { 'x-teleconsult-token': joined.patientToken },
      body: { kind: 'bye', senderKind: 'patient', payload: {} }
    });
    const closed = await api<{ status: string }>(`/teleconsult/rooms/${room2.id}`, { token });
    expect(closed.status).toBe('closed');
    await api(`/teleconsult/rooms/${room2.id}/signals/patient`, {
      method: 'POST', expected: 409,
      headers: { 'x-teleconsult-token': joined.patientToken },
      body: { kind: 'ice', senderKind: 'patient', payload: {} }
    });
  });
});
