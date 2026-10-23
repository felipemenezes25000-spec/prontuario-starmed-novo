/**
 * Jornada 11 — verificação PÚBLICA da receita (migração 030), no navegador e
 * SEM login: a página mostra só autenticidade; com o código impresso no PDF,
 * mostra os dados para dispensação. axe sem violações serious/critical.
 * Dados 100% sintéticos; nenhum login novo (usa o médico do preflight).
 */
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API_URL, api, nonce, sharedSetupDoctor } from './helpers';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('jornada11: QR/URL pública da receita — autenticidade sem medicamento; código libera dispensação', async ({ page }) => {
  const doctor = await sharedSetupDoctor();
  const token = doctor.token;
  const patient = await api<{ id: string }>('/patients', {
    token, method: 'POST', expected: 201,
    body: { fullName: `Paciente Verificação ${nonce()}`, birthDate: '1980-02-03', administrativeGender: 'female' },
  });
  const visit = await api<{ id: string }>('/encounters', {
    token, method: 'POST', expected: 201,
    body: { patientId: patient.id, specialty: 'general', type: 'consultation', reasonForVisit: 'Consulta sintética de verificação' },
  });
  const rx = await api<{ id: string }>(`/encounters/${visit.id}/prescriptions`, {
    token, method: 'POST', expected: 201,
    body: {
      operationId: crypto.randomUUID(), medication: { name: 'Fictício Verificável 5 mg', form: 'tablet' },
      dose: { value: 5, unit: 'mg' }, route: 'oral', frequency: '12/12h', duration: '7 dias', times: ['08:00', '20:00'],
      quantity: 14, indication: 'Indicação sintética', instructions: 'Orientação sintética de uso',
    },
  });
  const signed = await api<{ verification_url: string }>(`/prescriptions/${rx.id}/sign`, {
    token, method: 'POST', expected: 201,
    body: { operationId: crypto.randomUUID(), overrideJustification: 'Revisado: dados sintéticos da jornada de verificação pública.' },
  });
  const rxToken = signed.verification_url.split('/').pop()!;
  const pdf = Buffer.from(await (await fetch(`${API_URL}/prescriptions/${rx.id}/pdf`, { headers: { authorization: 'Bearer ' + token } })).arrayBuffer());
  const code = /Código de verificação: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(pdf.toString('latin1'))?.[1];
  expect(code, 'código impresso no PDF').toBeTruthy();

  // Navegador SEM sessão: contexto novo do Playwright, nada em storage.
  await page.goto(`/verificar/${rxToken}`);
  await expect(page.getByRole('heading', { name: 'Verificação de receita' })).toBeVisible();
  await expect(page.getByText('Receita emitida e dentro da validade')).toBeVisible();
  await expect(page.getByText(/CRM \d+\/SP/)).toBeVisible();
  await expect(page.getByText('Fictício Verificável')).toHaveCount(0);
  const axePublic = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axePublic.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

  await page.getByLabel('Código de verificação impresso na receita').fill('ZZZZ-ZZZZ');
  await page.getByRole('button', { name: 'Ver dados para dispensação' }).click();
  await expect(page.getByRole('alert')).toContainText('Código inválido');

  await page.getByLabel('Código de verificação impresso na receita').fill(code!.toLowerCase());
  await page.getByRole('button', { name: 'Ver dados para dispensação' }).click();
  await expect(page.getByRole('heading', { name: 'Dados para dispensação' })).toBeVisible();
  await expect(page.getByText('Fictício Verificável 5 mg')).toBeVisible();
  const axeDetails = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axeDetails.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

  await page.goto('/verificar/' + 'x'.repeat(32));
  await expect(page.getByRole('alert')).toContainText('Receita não encontrada');
});
