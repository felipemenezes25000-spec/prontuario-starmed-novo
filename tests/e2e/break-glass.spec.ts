/**
 * Jornada 3 — BREAK-GLASS (H-13 / J1 #13): paciente CRIADO PELO ADMIN, médico
 * sem vínculo →403 → painel → justificativa ≥20 auditada → prontuário carrega →
 * readback administrativo do evento `access.breakglass` (reason + requestId).
 * Dados 100% sintéticos.
 */
import { test, expect } from '@playwright/test';
import { DOCTOR_PASSWORD, adminToken, api, createDoctor, login, nonce } from './helpers';

test.describe('Jornada 3 — break-glass auditado', () => {
  let admin = '';
  let doctorEmail = '';
  let patientId = '';
  let patientName = '';

  test.beforeAll(async () => {
    admin = await adminToken();
    // Paciente criado pelo ADMIN: o médico NÃO tem vínculo de cuidado algum.
    patientName = `Paciente E2E BreakGlass ${nonce()}`;
    const patient = await api<{ id: string }>('/patients', {
      token: admin, method: 'POST', expected: 201,
      body: { fullName: patientName, birthDate: '1985-09-21', administrativeGender: 'unknown' }
    });
    patientId = patient.id;
    doctorEmail = await createDoctor(admin, 'Dr E2E BreakGlass');
  });

  test('403 → painel → justificativa → auditoria correlacionável', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('E-mail institucional').fill(doctorEmail);
    await page.getByLabel('Senha', { exact: true }).fill(DOCTOR_PASSWORD);
    await page.getByRole('button', { name: 'Entrar no sistema' }).click();
    await expect(page.getByText('Bom atendimento começa')).toBeVisible();

    await page.getByRole('button', { name: 'Pacientes', exact: true }).click();
    await page.getByPlaceholder('Buscar por nome').fill(patientName);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.locator('.patient-row').filter({ hasText: patientName }).click();

    // 403 sem vínculo → painel de break-glass (a recusa em si é o painel: sem ele
    // o prontuário teria carregado direto).
    const dialog = page.getByRole('dialog', { name: 'Acesso de emergência (break-glass)' });
    await expect(dialog).toBeVisible();

    // Justificativa (mín. 20) → retry com X-Break-Glass-Reason → prontuário carrega.
    const reason = `Acesso E2E sem vínculo para validar o painel ${nonce()}`;
    await dialog.getByLabel('Motivo do acesso').fill(reason);
    await dialog.getByRole('button', { name: 'Continuar' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Prontuário eletrônico' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Alergias registradas' })).toBeVisible();
    // Listas agora carregadas (paciente sem atendimentos → estado vazio legível).
    await expect(page.getByText('Nenhum atendimento para este paciente.')).toBeVisible();

    // Readback administrativo: evento auditado com a justificativa e requestId.
    const events = await api<Array<{
      action: string; target_id: string;
      details: { reason?: string; requestId?: string | null };
    }>>('/audit/events?action=access.breakglass', { token: admin });
    const hit = events.find(e =>
      e.details?.requestId && e.details?.reason === reason && e.target_id === patientId);
    expect(hit, 'evento access.breakglass com reason + requestId correlacionáveis').toBeTruthy();
  });
});
