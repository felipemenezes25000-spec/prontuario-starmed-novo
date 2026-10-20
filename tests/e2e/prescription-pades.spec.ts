/**
 * Jornada 2 — PRESCRIÇÃO ponta a ponta (ST-P1-004 + PAdES J1 #9/#10).
 * Fluxo: rascunho estruturado na UI → alerta de segurança (alergia ativa) →
 * override auditado → atestação → PDF → assinatura PAdES POSITIVA com a CA de
 * teste (trust store injetado pelo runner) → verify-pades → adulteração de
 * 1 byte do PDF armazenado DETECTADA (e restauração prova que a falha vinha da
 * adulteração, não do canal). Dados 100% sintéticos.
 */
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { DOCTOR_PASSWORD, adminToken, api, caFiles, createDoctor, login, nonce } from './helpers';

test.describe('Jornada 2 — prescrição completa + PAdES', () => {
  const medName = 'Dipirona E2E 500 mg';
  let doctorEmail = '';
  let doctorToken = '';
  let patientId = '';
  let patientName = '';

  test.beforeAll(async () => {
    const admin = await adminToken();
    doctorEmail = await createDoctor(admin, 'Dr E2E Receita');
    doctorToken = (await login(doctorEmail, DOCTOR_PASSWORD)).accessToken!;
    patientName = `Paciente E2E Receita ${nonce()}`;
    const patient = await api<{ id: string }>('/patients', {
      token: doctorToken, method: 'POST', expected: 201,
      body: { fullName: patientName, birthDate: '1991-05-04', administrativeGender: 'female' }
    });
    patientId = patient.id;
    // Alergia ATIVA de criticidade baixa compartilhando termo ≥4 chars com o
    // medicamento → review_required (exige justificativa) e NÃO block.
    await api(`/patients/${patientId}/allergies`, {
      token: doctorToken, method: 'POST', expected: 201,
      body: { substance: 'Dipirona E2E', reaction: 'Reação sintética', criticality: 'low', verificationStatus: 'unconfirmed' }
    });
    await api('/encounters', {
      token: doctorToken, method: 'POST', expected: 201,
      body: { patientId, specialty: 'general', type: 'consultation', reasonForVisit: 'Jornada E2E de prescrição' }
    });
  });

  test('rascunho → alerta → override → atestar → PDF → PAdES → adulteração detectada', async ({ page }) => {
    // Diagnóstico de rede (visível no stdout do CI quando algo falha): toda
    // resposta/requisição para a API é registrada sem expor dados clínicos.
    page.on('requestfailed', r => console.log(`[e2e:net] FALHOU ${r.method()} ${r.url()} → ${r.failure()?.errorText ?? '?'}`));
    page.on('response', r => { if (r.url().includes(':3001')) console.log(`[e2e:net] ${r.status()} ${r.request().method()} ${r.url()}`); });

    await page.goto('/');
    await page.getByLabel('E-mail institucional').fill(doctorEmail);
    await page.getByLabel('Senha', { exact: true }).fill(DOCTOR_PASSWORD);
    await page.getByRole('button', { name: 'Entrar no sistema' }).click();
    await expect(page.getByText('Bom atendimento começa')).toBeVisible();

    // Pacientes → busca → prontuário (vínculo via created_by: NÃO dispara break-glass).
    await page.getByRole('button', { name: 'Pacientes', exact: true }).click();
    await page.getByPlaceholder('Buscar por nome').fill(patientName);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.locator('.patient-row').filter({ hasText: patientName }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Prontuário eletrônico' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Acesso de emergência (break-glass)' })).toHaveCount(0);

    // Abre o atendimento criado na preparação e vai para prescrições.
    await page.locator('.encounter-row').first().click();
    await page.getByRole('button', { name: 'Prescrições do paciente' }).click();
    await expect(page.getByRole('heading', { name: 'Nova prescrição' })).toBeVisible();

    // Formulário estruturado (campos obrigatórios do zod server-side).
    await page.getByLabel('Nome do medicamento').fill(medName);
    await page.getByLabel('Dose — valor').fill('500');
    await page.getByLabel('Dose — unidade').fill('mg');
    await page.getByLabel('Via de administração').fill('Oral');
    await page.getByLabel('Frequência').fill('8/8h');
    await page.getByLabel('Duração').fill('5 dias');
    await page.getByLabel('Quantidade').fill('20');
    await page.getByLabel('Indicação').fill('Cefaleia sintética para verificação automatizada');
    await page.getByLabel('Orientações ao paciente').fill('Dados sintéticos; sem uso clínico real.');
    await page.getByRole('button', { name: 'Salvar rascunho' }).click();

    // Motor de segurança: alergia ativa → REVISÃO OBRIGATÓRIA (não é silencioso).
    await expect(page.getByRole('heading', { name: 'Segurança medicamentosa' })).toBeVisible();
    await expect(page.locator('.rx-alert-badge', { hasText: 'REVISÃO OBRIGATÓRIA' })).toBeVisible();

    await page.locator('#rx-override').fill('Revisão realizada: benefício supera risco neste caso sintético; dados de teste.');
    await page.getByRole('button', { name: 'Assinar com justificativa' }).click();

    // Status honesto: 'Atestada' (attested) ≠ assinatura qualificada; PDF emitido.
    await expect(page.getByRole('heading', { name: 'Resultado da assinatura' })).toBeVisible();
    await expect(page.locator('.small-pill', { hasText: 'Atestada' }).first()).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Baixar PDF' }).click()
    ]);
    const pdfPath = await download.path();
    expect(pdfPath, 'download do PDF emitido').toBeTruthy();
    expect(readFileSync(pdfPath!).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // ---- PAdES POSITIVO (fixture com CA de teste aceita pelo trust store injetado) ----
    const list = await api<Array<{ id: string; medication_name: string; status: string }>>(
      `/patients/${patientId}/prescriptions`, { token: doctorToken });
    const rx = list.find(r => r.medication_name === medName && r.status === 'signed');
    expect(rx, 'prescrição atestada presente na lista').toBeTruthy();

    const ca = caFiles();
    const signed = await api<{ signatureId: string; padesEmbedding: { embedded: boolean } }>(
      `/prescriptions/${rx!.id}/sign-pades`, {
        token: doctorToken, method: 'POST', expected: 201,
        body: {
          signerCertPem: ca.signerCertPem,
          privateKeyPkcs8Pem: ca.privateKeyPkcs8Pem,
          councilNumber: '123456',
          councilState: 'SP'
        }
      });
    expect(signed.signatureId, 'registro em document_signatures').toBeTruthy();
    expect(signed.padesEmbedding.embedded, 'CMS embarcado com ByteRange').toBe(true);
    // Status honesto persistido na prescrição (attested → pades).
    const afterSign = await api<{ signature_status: string }>(`/prescriptions/${rx!.id}`, { token: doctorToken });
    expect(afterSign.signature_status).toBe('pades');

    const verified = await api<{ byteRangeOk: boolean; signatureValid: boolean; tamperSuspect: boolean }>(
      `/prescriptions/${rx!.id}/verify-pades`, { token: doctorToken, method: 'POST' });
    expect(verified.byteRangeOk).toBe(true);
    expect(verified.signatureValid).toBe(true);
    expect(verified.tamperSuspect).toBe(false);

    // ---- ADULTERAÇÃO (J1 #10): 2 camadas de detecção sobre o PDF persistido ----
    expect(process.env.DATABASE_URL, 'DATABASE_URL do banco descartável do E2E').toBeTruthy();
    const current = await api<{ signed_document_id: string }>(`/prescriptions/${rx!.id}`, { token: doctorToken });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const read = 'SELECT sha256, content FROM clinical_documents WHERE id = $1';
    try {
      // Camada 1 — re-hash: bytes alterados NÃO batem com o sha256 registrado →
      // o servidor recusa servir/verificar (500 honesto, nunca "válido").
      const before = await pool.query(read, [current.signed_document_id]);
      const original: Buffer = before.rows[0].content;
      const originalSha: string = before.rows[0].sha256;
      const dirty = Buffer.from(original);
      dirty[0] ^= 0x01;
      await pool.query('UPDATE clinical_documents SET content = $2 WHERE id = $1', [current.signed_document_id, dirty]);
      const rehash = await api<{ message: string }>(`/prescriptions/${rx!.id}/verify-pades`,
        { token: doctorToken, method: 'POST', expected: 500 });
      expect(rehash.message).toMatch(/corrompido/i);

      // Camada 2 — CMS/ByteRange: atacante que também "conserta" o sha256 registrado
      // continua REPROVADO na assinatura (1 byte fora do buraco invalida o CMS).
      const tamperedSha = createHash('sha256').update(dirty).digest('hex');
      await pool.query('UPDATE clinical_documents SET content = $2, sha256 = $3 WHERE id = $1',
        [current.signed_document_id, dirty, tamperedSha]);
      const tampered = await api<{ byteRangeOk: boolean; signatureValid: boolean; tamperSuspect: boolean }>(
        `/prescriptions/${rx!.id}/verify-pades`, { token: doctorToken, method: 'POST' });
      expect(tampered.byteRangeOk, 'geometria intacta — a falha é do CMS').toBe(true);
      expect(tampered.signatureValid, 'CMS não cobre mais os bytes adulterados').toBe(false);
      expect(tampered.tamperSuspect).toBe(true);

      // Restauração: bytes originais voltam a validar (a falha vinha da adulteração).
      await pool.query('UPDATE clinical_documents SET content = $2, sha256 = $3 WHERE id = $1',
        [current.signed_document_id, original, originalSha]);
      const restored = await api<{ signatureValid: boolean }>(
        `/prescriptions/${rx!.id}/verify-pades`, { token: doctorToken, method: 'POST' });
      expect(restored.signatureValid, 'bytes restaurados → assinatura volta a validar').toBe(true);
    } finally {
      await pool.end();
    }
  });
});
