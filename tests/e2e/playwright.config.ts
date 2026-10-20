import { defineConfig, devices } from '@playwright/test';

/**
 * Config E2E do StarMed (EHR).
 * SEM webServer: o orquestrador sobe API + web antes de rodar o Playwright.
 * - Web:  E2E_WEB_URL  (build de produção do Vite com VITE_API_URL=http://127.0.0.1:3001)
 * - API:  E2E_API_URL  (usado pelos helpers via request, não pelo baseURL)
 */
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // workers=1 + retries=0: qualquer flaky aparece em vez de ser mascarado.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Artefato na raiz do repo (o CI sobe test-results/ na falha).
  outputDir: '../../test-results',
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    ...devices['Desktop Chrome'],
  },
});
