/**
 * Jornada 4 — PRONTUÁRIO 360° (ST-P1-001/002/003) + MPI/merge (ST-P1-003).
 * Prova: UI consolidada (linha do tempo com status honesto, alto risco com
 * 'none_recorded' explícito, documentos versionados pelo gatilho do 022) e
 * backend (candidatas MPI, merge de CORRENTE SEM DELETE com moved_counts,
 * preservação do registro perdedor). Dados 100% sintéticos.
 */
import { test, expect } from '@playwright/test';
import { DOCTOR_PASSWORD, adminToken, api, nonce, sharedSetupDoctor } from './helpers';

test.describe('Jornada 4 — Prontuário 360° + MPI', () => {
  const medName = 'Losartana E2E 50 mg';
  let admin = '';
  let doctorEmail = '';
  let doctorToken = '';
  let patientId = '';
  let patientName = '';
  let patientNoAllergyId = '';
  let patientNoAllergyName = '';
  let dupId = '';

  test.beforeAll(async () => {
    admin = await adminToken();
    const doc = await sharedSetupDoctor(); // doctor compartilhado: economiza1 login/10
    doctorEmail = doc.email;
    doctorToken = doc.token;

    // Paciente COM alergia (crítico baixo → review_required) e atendimento.
    patientName = `Paciente E2E 360 ${nonce()}`;
    const p1 = await api<{ id: string }>('/patients', {
      token: doctorToken, method: 'POST', expected: 201,
      body: { fullName: patientName, birthDate: '1990-01-01', administrativeGender: 'female' }
    });
    patientId = p1.id;
    await api(`/patients/${patientId}/allergies`, {
      token: doctorToken, method: 'POST', expected: 201,
      body: { substance: 'Losartana E2E', reaction: 'Reação sintética', criticality: 'low', verificationStatus: 'unconfirmed' }
    });
    const enc = await api<{ id: string }>('/encounters', {
      token: doctorToken, method: 'POST', expected: 201,
      body: { patientId, specialty: 'general', type: 'consultation', reasonForVisit: 'Jornada E2E 360' }
    });
    // Prescrição assinada → clinical_documents (INSERT dispara o gatilho do 022 → v1).
    const rx = await api<{ id: string }>(`/encounters/${enc.id}/prescriptions`, {
      token: doctorToken, method: 'POST', expected: 201,
      body: {
        operationId: crypto.randomUUID(),
        medication: { name: medName, form: 'tablet' },
        dose: { value: 50, unit: 'mg' }, route: 'oral', frequency: '24/24h', duration: '30 dias',
        times: ['08:00'], quantity: 30,
        indication: 'Indicação sintética da jornada 360', instructions: 'Dados sintéticos; sem uso real.'
      }
    });
    // A alergia ativa (low) exige override auditado — caminho positivo do motor.
    await api(`/prescriptions/${rx.id}/sign`, {
      token: doctorToken, method: 'POST', expected: 201,
      body: {
        operationId: crypto.randomUUID(),
        overrideJustification: 'Revisão sintética: benefício supera risco — dados de teste da jornada 360.'
      }
    });

    // Paciente SEM nenhuma alergia registrada (estado 'none_recorded').
    patientNoAllergyName = `Paciente E2E Sem Alergia ${nonce()}`;
    const p2 = await api<{ id: string }>('/patients', {
      token: doctorToken, method: 'POST', expected: 201,
      body: { fullName: patientNoAllergyName, birthDate: '1992-07-07', administrativeGender: 'male' }
    });
    patientNoAllergyId = p2.id;
    // Lote 5 (MPI probabilístico): grafia vizinha, mesmo nascimento e sexo → 'possível'.
    await api('/patients', {
      token: doctorToken, method: 'POST', expected: 201,
      body: { fullName: patientNoAllergyName.replace('Sem Alergia', 'Sem Allergia'), birthDate: '1992-07-07', administrativeGender: 'male' }
    });
  });

  test('UI: linha do tempo honesta, alto risco, documentos versionados (gatilho 022)', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('E-mail institucional').fill(doctorEmail);
    await page.getByLabel('Senha', { exact: true }).fill(DOCTOR_PASSWORD);
    await page.getByRole('button', { name: 'Entrar no sistema' }).click();
    await expect(page.getByText('Bom atendimento começa')).toBeVisible();

    // Abre o prontuário (vínculo via created_by: sem break-glass)…
    await page.getByRole('button', { name: 'Pacientes', exact: true }).click();
    await page.getByPlaceholder('Buscar por nome').fill(patientName);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.locator('.patient-row').filter({ hasText: patientName }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Prontuário eletrônico' })).toBeVisible();

    // …e entra na visão 360°.
    await page.getByRole('button', { name: 'Visão 360° do prontuário' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Prontuário 360°' })).toBeVisible();

    // Linha do tempo: os tipos sintéticos aparecem com rótulo + data honestos.
    await expect(page.getByText(patientName).first()).toBeVisible(); // cabeçalho do paciente
    await expect(page.getByText(medName, { exact: false }).first()).toBeVisible(); // prescrição na timeline
    await expect(page.getByText(/Prescrição • \d{2}\/\d{2}\/\d{4}/).first()).toBeVisible();
    await expect(page.getByText(/Alergia • \d{2}\/\d{2}\/\d{4}/).first()).toBeVisible();

    // Alto risco: alergia registrada + medicação ativa + alerta de revisão.
    await page.getByRole('tab', { name: 'Alto risco' }).click();
    await expect(page.getByText('Losartana E2E', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(medName).first()).toBeVisible();
    await expect(page.getByText('REVISÃO OBRIGATÓRIA').first()).toBeVisible();

    // Documentos: o gatilho do 022 registrou v1 no INSERT do PDF atestado.
    await page.getByRole('tab', { name: 'Documentos' }).click();
    await expect(page.getByText('Prescrição (PDF)').first()).toBeVisible();
    await page.getByRole('button', { name: 'Ver histórico' }).click();
    await expect(page.getByText(/v1 — Criação do documento/)).toBeVisible();

    // Paciente SEM registro de alergia → aviso explícito (H-04: nunca "sem alergias").
    await page.getByRole('button', { name: 'Pacientes', exact: true }).click();
    await page.getByPlaceholder('Buscar por nome').fill(patientNoAllergyName);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.locator('.patient-row').filter({ hasText: patientNoAllergyName }).click();
    await page.getByRole('button', { name: 'Visão 360° do prontuário' }).click();
    await page.getByRole('tab', { name: 'Alto risco' }).click();
    await expect(page.locator('.r360-notice-warn')).toContainText('NÃO significa ausência de alergia');

    // Duplicidades (MPI): sugestão para revisão humana; unir exige justificativa + conferência.
    await page.getByRole('tab', { name: 'Duplicidades' }).click();
    const cand = page.locator('.mpi-item').filter({ hasText: 'Sem Allergia' });
    await expect(cand).toContainText('Semelhança de identidade');
    await expect(cand).toContainText('Possível');
    await cand.getByRole('button', { name: 'Revisar e unir' }).click();
    const unir = page.getByRole('button', { name: 'Unir cadastros' });
    await expect(unir).toBeDisabled();
    await page.getByLabel('Justificativa (mínimo 20 caracteres)').fill('Conferência sintética da jornada E2E de MPI.');
    await expect(unir).toBeDisabled();
    await page.getByRole('button', { name: 'Cancelar' }).click();
  });

  test('backend: none_recorded, candidatas MPI e merge de corrente sem DELETE', async () => {
    // 1) Estado de registro honesto (nunca "sem alergias") + alerta patient-level.
    const bundle = await api<{ allergyState: string; activeMedications: unknown[]; alerts: Array<{ level: string; code?: string }> }>(
      `/patients/${patientNoAllergyId}/medications`, { token: doctorToken });
    expect(bundle.allergyState).toBe('none_recorded');
    expect(bundle.alerts.some(a => a.code === 'no_allergy_record')).toBe(true);
    expect(bundle.activeMedications.length).toBe(0);

    // 2) Timeline do paciente com dados: 7 tipos sintéticos + meta honesta.
    const timeline = await api<Array<{ kind: string; meta?: Record<string, unknown> }>>(
      `/patients/${patientId}/timeline?limit=50`, { token: doctorToken });
    const kinds = new Set(timeline.map(t => t.kind));
    for (const k of ['encounter', 'prescription', 'allergy', 'document']) expect(kinds.has(k), `kind ${k}`).toBe(true);
    const rxItem = timeline.find(t => t.kind === 'prescription');
    expect(rxItem?.meta?.signatureStatus).toBe('attested');
    // Parâmetro desconhecido/inválido → 400 (zod strict), sem PHI.
    await api(`/patients/${patientId}/timeline?types=foo`, { token: doctorToken, expected: 400 });

    // 3) Duplicata EXATA (mesmo nome + nascimento, criada pelo ADMIN com encontro
    //    próprio) — criada AQUI (e não no beforeAll) para a busca da UI no teste
    //    anterior ter nome único. O merge deve MOVÊ-lo (movedCounts.encounters=1).
    const dup = await api<{ id: string }>('/patients', {
      token: admin, method: 'POST', expected: 201,
      body: { fullName: patientName, birthDate: '1990-01-01', administrativeGender: 'female' }
    });
    dupId = dup.id;
    await api('/encounters', {
      token: doctorToken, method: 'POST', expected: 201,
      body: { patientId: dupId, specialty: 'general', type: 'consultation', reasonForVisit: 'Cadastro duplicado sintético' }
    });

    // Candidatas MPI: a duplicata exata aparece.
    const pairs = await api<Array<{ patient: { id: string }; reason: string }>>(
      `/patients/${patientId}/duplicates`, { token: admin });
    expect(pairs.some(p => p.patient.id === dupId && p.reason === 'same-name-birthdate')).toBe(true);

    // 4) Merge (admin): move o encontro da duplicata, preserva o registro perdedor.
    const before = await api<Array<{ id: string }>>(`/encounters?patientId=${patientId}`, { token: doctorToken });
    const merged = await api<{ keepPatientId: string; mergedPatientId: string; movedCounts: Record<string, number> }>(
      '/patients/merge', {
        token: admin, method: 'POST', expected: 201,
        body: { keepPatientId: patientId, mergedPatientId: dupId, reason: 'Cadastro duplicado sintético da jornada E2E — mesmo nome e nascimento.' }
      });
    expect(merged.movedCounts.encounters).toBe(1);
    const after = await api<Array<{ id: string }>>(`/encounters?patientId=${patientId}`, { token: doctorToken });
    expect(after.length).toBe(before.length + 1, 'encontro movido para o paciente mantido');

    // Registro perdedor NUNCA apagado (rastro) — e novo merge da corrente é recusado.
    const loser = await api<{ id: string }>(`/patients/${dupId}`, { token: admin });
    expect(loser.id).toBe(dupId);
    await api('/patients/merge', {
      token: admin, method: 'POST', expected: 409,
      body: { keepPatientId: patientId, mergedPatientId: dupId, reason: 'Tentativa repetida de merge da mesma corrente sintética.' }
    });
    // Auditoria do merge com requestId correlacionável.
    const events = await api<Array<{ action: string; details: { requestId?: string; movedCounts?: Record<string, number> } }>>(
      '/audit/events?action=patient.merged', { token: admin });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(typeof events[0].details.requestId).toBe('string');
  });
});
