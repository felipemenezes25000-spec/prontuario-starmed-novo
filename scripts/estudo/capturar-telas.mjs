#!/usr/bin/env node
/**
 * Captura reprodutível das telas do StarMed (desktop 1440×900 e celular 390×844)
 * para avaliação de UX. Só ambiente LOCAL com dados SINTÉTICOS.
 *
 *   CAPTURA_EMAIL=... CAPTURA_SENHA=... [CAPTURA_TOKEN_VERIFICACAO=...] \
 *   node scripts/estudo/capturar-telas.mjs --web http://localhost:5173 --saida docs/estudo/evidencias/ux-AAAA-MM-DD/starmed
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const WEB = (arg('--web') ?? 'http://localhost:5173').replace(/\/$/, '');
const OUT = resolve(arg('--saida') ?? 'capturas');
const EMAIL = process.env.CAPTURA_EMAIL, SENHA = process.env.CAPTURA_SENHA, TOKEN = process.env.CAPTURA_TOKEN_VERIFICACAO;
if (!EMAIL || !SENHA) throw new Error('defina CAPTURA_EMAIL e CAPTURA_SENHA (usuário sintético local)');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const shots = [];
async function shot(page, nome) {
  await page.waitForTimeout(600);
  const file = join(OUT, `${nome}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 72, fullPage: false });
  shots.push(nome);
}
async function login(page) {
  await page.goto(WEB + '/');
  await page.getByLabel('E-mail institucional').fill(EMAIL);
  await page.getByLabel('Senha', { exact: true }).fill(SENHA);
  await page.getByRole('button', { name: 'Entrar no sistema' }).click();
  await page.getByText('Bom atendimento começa').waitFor();
}
const nav = (page, label) => page.locator('.sidebar-menu').getByRole('button', { name: label, exact: true }).click();
async function abrirPaciente(page, nome) {
  await nav(page, 'Pacientes');
  await page.getByPlaceholder('Buscar por nome').fill(nome);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await page.locator('.patient-row').filter({ hasText: nome }).first().click();
}

for (const [rotulo, viewport] of [['desktop', { width: 1440, height: 900 }], ['celular', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, locale: 'pt-BR' });
  const page = await ctx.newPage();
  await page.goto(WEB + '/');
  await shot(page, `${rotulo}-01-login`);
  await login(page);
  await shot(page, `${rotulo}-02-painel`);
  if (rotulo === 'desktop') {
    await nav(page, 'Pacientes');
    await page.getByPlaceholder('Buscar por nome').fill('Ana Beatriz');
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await shot(page, `${rotulo}-03-pacientes-homonimos`);
    await abrirPaciente(page, 'Maria Aparecida Souza');
    await shot(page, `${rotulo}-04-prontuario`);
    await page.getByRole('button', { name: 'Visão 360° do prontuário' }).click();
    await shot(page, `${rotulo}-05-360-linha-do-tempo`);
    await page.getByRole('tab', { name: 'Alto risco' }).click();
    await shot(page, `${rotulo}-06-360-alto-risco`);
    await nav(page, 'Prescrições');
    await shot(page, `${rotulo}-07-prescricoes`);
    await abrirPaciente(page, 'Ana Beatriz Lima');
    await page.getByRole('button', { name: 'Visão 360° do prontuário' }).click();
    await page.getByRole('tab', { name: 'Duplicidades' }).click();
    await shot(page, `${rotulo}-08-360-duplicidades`);
    for (const [i, label] of ['Agenda', 'Resultados', 'Teleconsulta'].entries()) {
      await nav(page, label);
      await shot(page, `${rotulo}-${String(9 + i).padStart(2, '0')}-${label.toLowerCase()}`);
    }
  } else {
    await abrirPaciente(page, 'Maria Aparecida Souza').catch(() => {});
    await shot(page, `${rotulo}-04-prontuario`);
  }
  if (TOKEN) {
    const pub = await ctx.newPage();
    await pub.goto(`${WEB}/verificar/${TOKEN}`);
    await pub.getByText('Verificação de receita').waitFor();
    await shot(pub, `${rotulo}-20-verificacao-publica`);
  }
  await ctx.close();
}
await browser.close();
console.log(`${shots.length} capturas em ${OUT}:\n` + shots.join('\n'));
