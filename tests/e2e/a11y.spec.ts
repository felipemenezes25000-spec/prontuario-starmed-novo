/**
 * Jornada 9 — ACESSIBILIDADE WCAG 2.2 AA (Fase 7, ST-P1-012).
 * Varreduras `axe-core` com tags wcag2a/2a AA/2.1/2.2 nas jornadas críticas:
 * login, portal, dashboard, pacientes, prontuário (evolução/alergias),
 * prontuário 360 (histórico), prescrição, resultados e teleconsulta.
 * SOMENTE impactos serious/critical falham (moderate/minor são impressos para
 * correção assistida — nunca mascarados com ignore).
 *
 * ORÇAMENTO DE LOGIN: esta spec gasta exatamente1 login de /auth/login (o
 * setup usa os presets E2E_PRESET_* —0 logins — e o login do portal é outra
 * rota). Total da suíte:10/10 (limite do rate limit) — ADICIONAR UMA JORNADA
 * COM LOGIN exige revisar o orçamento (ver helpers.ts).
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DOCTOR_PASSWORD, api, nonce, sharedSetupDoctor } from './helpers';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: import('@playwright/test').Page, context: string) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  const minor = results.violations.filter(v => v.impact !== 'serious' && v.impact !== 'critical');
  if (minor.length) console.log(`[a11y:info] ${context} — não bloqueantes: ` +
    minor.map(v => `${v.id}(${v.impact})x${v.nodes.length}`).join(', '));
  if (serious.length) console.log(`[a11y:BLOQUEIO] ${context}: ` +
    serious.map(v => `${v.id}(${v.impact})x${v.nodes.length} — ${v.help} :: ` +
      v.nodes.slice(0, 10).map(n => {
        const d = (n.any?.[0]?.data ?? {}) as { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string };
        return `${n.target.join(' ')} [fg=${d.fgColor} bg=${d.bgColor} ratio=${d.contrastRatio} esperado=${d.expectedContrastRatio}]`;
      }).join(' | ')).join('\n'));
  expect(serious, `Violações serious/critical de acessibilidade em: ${context}`).toEqual([]);
}

test.describe('Jornada 9 — acessibilidade (axe WCAG 2.2 AA)', () => {
  let doctorEmail = '';
  let portalEmail = '';
  const portalPassword = 'Portal-A11y-E2e-2026';
  let patientName = '';

  test.beforeAll(async () => {
    const doc = await sharedSetupDoctor();
    doctorEmail = doc.email;
    // Conta do portal criada100% via API (o login do portal NÃO consome o
    // orçamento de /auth/login da equipe).
    const patient = await api<{ id: string }>('/patients', {
      token: doc.token, method: 'POST', expected: 201,
      body: { fullName: `Paciente A11y ${nonce()}`, birthDate: '1990-09-09', administrativeGender: 'unknown' }
    });
    await api('/encounters', {
      token: doc.token, method: 'POST', expected: 201,
      body: { patientId: patient.id, specialty: 'general', type: 'consultation', reasonForVisit: 'Jornada a11y sintética' }
    });
    patientName = (await api<{ full_name: string }>(`/patients/${patient.id}`, { token: doc.token })).full_name;
    const invite = await api<{ inviteCode: string }>('/portal/invites', {
      token: doc.token, method: 'POST', expected: 201, body: { patientId: patient.id, ttlHours: 1 }
    });
    portalEmail = `titular-a11y-${nonce()}@example.invalid`;
    await api('/portal/activate', {
      method: 'POST', expected: 201,
      body: { inviteCode: invite.inviteCode, email: portalEmail, password: portalPassword }
    });
  });

  test('telas públicas: login da equipe e login do portal', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Acesse seu ambiente' })).toBeVisible();
    await scan(page, 'login (equipe)');

    await page.getByRole('button', { name: 'Área do paciente' }).click();
    await expect(page.getByRole('heading', { name: 'Entre na sua área' })).toBeVisible();
    await scan(page, 'login (portal)');
  });

  test('jornadas críticas autenticadas: dashboard → pacientes → prontuário →360 → prescrição → resultados → teleconsulta', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('E-mail institucional').fill(doctorEmail);
    await page.getByLabel('Senha', { exact: true }).fill(DOCTOR_PASSWORD);
    await page.getByRole('button', { name: 'Entrar no sistema' }).click();
    await expect(page.getByText('Bom atendimento começa')).toBeVisible();
    await scan(page, 'dashboard');

    await page.getByRole('button', { name: 'Pacientes', exact: true }).click();
    await page.getByPlaceholder('Buscar por nome').fill(patientName);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(page.locator('.patient-row').first()).toBeVisible();
    await scan(page, 'pacientes (lista)');

    // Prontuário: evolução + alergias (os5 eventos nomeados do ST-P1-012 moram aqui).
    await page.locator('.patient-row').first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Prontuário eletrônico' })).toBeVisible();
    await scan(page, 'prontuário (evolução/alergias)');

    // Histórico consolidado.
    await page.getByRole('button', { name: 'Visão 360° do prontuário' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Prontuário 360°' })).toBeVisible();
    await scan(page, 'prontuário 360 (linha do tempo)');
    await page.getByRole('tab', { name: 'Alto risco' }).click();
    await scan(page, 'prontuário 360 (alto risco)');

    // Prescrição.
    await page.getByRole('button', { name: 'Pacientes', exact: true }).click();
    await page.getByPlaceholder('Buscar por nome').fill(patientName);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.locator('.patient-row').first().click();
    await page.getByRole('button', { name: 'Prescrições do paciente' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Prescrições' })).toBeVisible();
    await scan(page, 'prescrição');

    // Resultados e Teleconsulta (rotas de navegação).
    await page.getByRole('button', { name: 'Resultados', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Resultados' }).or(page.getByRole('heading', { name: 'Exames e resultados' }))).toBeVisible();
    await scan(page, 'resultados');
    await page.getByRole('button', { name: 'Teleconsulta', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Teleconsulta' })).toBeVisible();
    await scan(page, 'teleconsulta');
  });

  test('portal autenticado: home com documentos, notificações e perfil', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Área do paciente' }).click();
    await page.getByLabel('E-mail').fill(portalEmail);
    await page.getByLabel('Senha', { exact: true }).fill(portalPassword);
    await page.getByRole('button', { name: 'Entrar na minha área' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sua saúde em um só lugar' })).toBeVisible();
    await scan(page, 'portal (home/documentos/notificações/perfil)');
  });
});
