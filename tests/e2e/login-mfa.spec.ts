/**
 * Jornada 1 — LOGIN + MFA (ST-P0-006 / J1).
 * Prova de segurança: o 1º fator NÃO abre sessão (sem navegação do app antes do
 * TOTP); código errado fica no desafio com erro auditável na tela; código certo
 * (RFC 6238, janela atual) entra. Dados 100% sintéticos.
 */
import { test, expect } from '@playwright/test';
import { DOCTOR_PASSWORD, adminToken, api, createDoctor, login, totpNow } from './helpers';

test.describe('Jornada 1 — login com MFA', () => {
  let doctorEmail = '';
  let secret = '';

  test.beforeAll(async () => {
    const admin = await adminToken();
    doctorEmail = await createDoctor(admin, 'Dr E2E MFA');
    // Enrollment + ativação via API (o UI de segurança já é coberto pelos smokes).
    const session = await login(doctorEmail, DOCTOR_PASSWORD);
    const enrolled = await api<{ secretBase32: string; digits: number; periodSeconds: number }>(
      '/auth/mfa/enroll', { token: session.accessToken!, method: 'POST', body: {}, expected: 201 });
    expect(enrolled.digits).toBe(6);
    secret = enrolled.secretBase32;
    await api('/auth/mfa/activate', { token: session.accessToken!, method: 'POST', body: { code: totpNow(secret) }, expected: 201 });
  });

  test('desafio TOTP: sem sessão antes do 2º fator; errado recusa; certo entra', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Acesse seu ambiente' })).toBeVisible();

    await page.getByLabel('E-mail institucional').fill(doctorEmail);
    await page.getByLabel('Senha', { exact: true }).fill(DOCTOR_PASSWORD);
    await page.getByRole('button', { name: 'Entrar no sistema' }).click();

    // 1º fator NÃO abre sessão: aparece o desafio e a navegação do app continua fora.
    await expect(page.getByRole('heading', { name: 'Confirme sua identidade' })).toBeVisible();
    await expect(page.locator('.nav-item')).toHaveCount(0);
    await expect(page.getByText('Bom atendimento começa')).toHaveCount(0);

    // Código errado → erro visível, permanece no desafio (nenhuma sessão).
    await page.getByLabel('Código de 6 dígitos').fill('000000');
    await page.getByRole('button', { name: 'Verificar e entrar' }).click();
    await expect(page.locator('[role="alert"].inline-error')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Confirme sua identidade' })).toBeVisible();

    // Código certo do relógio atual → dashboard carrega.
    await page.getByLabel('Código de 6 dígitos').fill(totpNow(secret));
    await page.getByRole('button', { name: 'Verificar e entrar' }).click();
    await expect(page.getByText('Bom atendimento começa')).toBeVisible();
    await expect(page.locator('.nav-item', { hasText: 'Pacientes' })).toBeVisible();
  });
});
