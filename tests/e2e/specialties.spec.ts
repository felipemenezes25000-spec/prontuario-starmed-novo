/**
 * Jornada 5 — CENÁRIOS POR ESPECIALIDADE (Fase 2b): 1 jornada sintética cada,
 * exercitando TRANSPORTE/DADOS de cada especialidade — NÃO regras clínicas duras
 * (base farmacológica licenciada é pendência externa nomeada — ADR-0003).
 *   geral · cardiologia (duplicidade) · pediatria (dose por peso INFORMATIVO) ·
 *   psiquiatria (privacidade: 403→break-glass + timeline sem seções) ·
 *   ginecologia (especialidade nova na UI; sem regra de teratogenicidade) ·
 *   ortopedia (lateralidade preservada, sem vazamento na timeline).
 * Dados 100% sintéticos.
 */
import { test, expect } from '@playwright/test';
import { DOCTOR_PASSWORD, adminToken, api, nonce, sharedSetupDoctor } from './helpers';

type Note = { id: string; version: number; status: string; content?: { sections: Record<string, string> } };

test.describe('Jornada 5 — cenários por especialidade', () => {
  let admin = '';
  let token = '';
  let doctorEmail = '';

  test.beforeAll(async () => {
    admin = await adminToken();
    const doc = await sharedSetupDoctor();
    token = doc.token;
    doctorEmail = doc.email;
  });

  const createPatient = (fullName: string, social?: Record<string, unknown>) =>
    api<{ id: string }>('/patients', {
      token, method: 'POST', expected: 201,
      body: { fullName, birthDate: '1995-04-04', administrativeGender: 'unknown', ...(social ? { socialDeterminants: social } : {}) }
    });
  const createEncounter = (patientId: string, specialty: string) =>
    api<{ id: string }>('/encounters', {
      token, method: 'POST', expected: 201,
      body: { patientId, specialty, type: 'consultation', reasonForVisit: `Jornada sintética ${specialty}` }
    });
  const draftAndSign = async (encounterId: string, templateId: string, sections: Record<string, string>): Promise<void> => {
    const draft = await api<Note>(`/encounters/${encounterId}/notes/draft`, {
      token, method: 'PUT', expected: 200,
      body: { operationId: crypto.randomUUID(), expectedVersion: 0, templateId, sections }
    });
    await api(`/encounters/${encounterId}/notes/sign`, {
      token, method: 'POST', expected: 201, body: { expectedVersion: draft.version }
    });
  };

  test('clínica geral: nota assinada compõe a timeline com autor, versão e tipo', async () => {
    const p = await createPatient(`Paciente Geral ${nonce()}`);
    const enc = await createEncounter(p.id, 'general');
    await draftAndSign(enc.id, 'general', { assessment: 'Avaliação sintética geral.', plan: 'Plano sintético geral.' });
    const items = await api<Array<{ kind: string; author: string | null; meta: Record<string, unknown> }>>(
      `/patients/${p.id}/timeline?limit=50`, { token });
    const note = items.find(i => i.kind === 'note');
    expect(note, 'item nota presente').toBeTruthy();
    expect(note!.author, 'autor da nota (display_name)').toBeTruthy();
    // A assinatura congela a nota numa versão ≥1 (v é número honesto, não texto fixo).
    expect(Number.isInteger(note!.meta.version)).toBe(true);
    expect(Number(note!.meta.version)).toBeGreaterThanOrEqual(1);
    expect(items.some(i => i.kind === 'encounter')).toBe(true);
  });

  test('cardiologia: terapia duplicada entre duas assinaturas vira review_required', async () => {
    const p = await createPatient(`Paciente Cardio ${nonce()}`);
    const enc = await createEncounter(p.id, 'cardiology');
    const rxPayload = (op: string) => ({
      operationId: op,
      medication: { name: 'Atenolol E2E 50 mg', form: 'tablet' },
      dose: { value: 50, unit: 'mg' }, route: 'oral', frequency: '24/24h', duration: '30 dias',
      times: ['08:00'], quantity: 30,
      indication: 'Sintética cardiologia', instructions: 'Dados sintéticos.'
    });
    const rx1 = await api<{ id: string }>(`/encounters/${enc.id}/prescriptions`, { token, method: 'POST', expected: 201, body: rxPayload(crypto.randomUUID()) });
    await api(`/prescriptions/${rx1.id}/sign`, { token, method: 'POST', expected: 201, body: { operationId: crypto.randomUUID() } });
    const rx2 = await api<{ id: string }>(`/encounters/${enc.id}/prescriptions`, { token, method: 'POST', expected: 201, body: rxPayload(crypto.randomUUID()) });
    // A 2ª assinatura encontra a terapia ativa → exige override auditado (409 antes).
    const blocked = await api<{ message: string }>(`/prescriptions/${rx2.id}/sign`,
      { token, method: 'POST', expected: 409, body: { operationId: crypto.randomUUID() } });
    expect(blocked.message).toMatch(/revisão obrigatória/i);
    await api(`/prescriptions/${rx2.id}/sign`, {
      token, method: 'POST', expected: 201,
      body: { operationId: crypto.randomUUID(), overrideJustification: 'Duplicidade revisada — paciente sintético de cardiologia com terapia otimizada.' }
    });
    const bundle = await api<{ alerts: Array<{ code: string; medicationId?: string | null; existingPrescriptionId?: string; level: string }> }>(
      `/patients/${p.id}/medications`, { token });
    const dups = bundle.alerts.filter(a => a.code === 'duplicate_therapy');
    expect(dups.length, 'painel acusa duplicidade entre as duas assinaturas').toBeGreaterThanOrEqual(1);
    expect(dups[0].level).toBe('review_required');
  });

  test('pediatria: dose por peso INFORMATIVO (mg/kg, sem faixa licenciada)', async () => {
    const p = await createPatient(`Paciente Pediatria ${nonce()}`, { weightKg: 14.5 });
    const enc = await createEncounter(p.id, 'pediatrics');
    const rx = await api<{ id: string }>(`/encounters/${enc.id}/prescriptions`, {
      token, method: 'POST', expected: 201,
      body: {
        operationId: crypto.randomUUID(),
        medication: { name: 'Dipirona Gotas E2E', form: 'solution' },
        dose: { value: 200, unit: 'mg' }, route: 'oral', frequency: '6/6h', duration: '2 dias',
        times: ['08:00', '14:00'], quantity: 4,
        indication: 'Sintética pediatria', instructions: 'Dados sintéticos; sem uso real.'
      }
    });
    await api(`/prescriptions/${rx.id}/sign`, { token, method: 'POST', expected: 201, body: { operationId: crypto.randomUUID() } });
    const bundle = await api<{ alerts: Array<{ code: string; level: string; message: string }> }>(
      `/patients/${p.id}/medications`, { token });
    const dose = bundle.alerts.find(a => a.code === 'dose_per_kg');
    expect(dose, 'alerta de dose por peso presente').toBeTruthy();
    expect(dose!.level).toBe('info');
    expect(dose!.message).toMatch(/13\.79 mg\/kg/);
    // Honestidade regulatória: SEM faixa de referência (base licenciada externa).
    expect(dose!.message).toMatch(/sem faixa de referência/);
    expect(dose!.message).toMatch(/licenciada/);
    // Sem peso não há alerta (paciente sem social_determinants.weightKg).
    const p2 = await createPatient(`Paciente Sem Peso ${nonce()}`);
    const enc2 = await createEncounter(p2.id, 'pediatrics');
    const rx2 = await api<{ id: string }>(`/encounters/${enc2.id}/prescriptions`, {
      token, method: 'POST', expected: 201,
      body: {
        operationId: crypto.randomUUID(),
        medication: { name: 'Dipirona Gotas E2E', form: 'solution' },
        dose: { value: 200, unit: 'mg' }, route: 'oral', frequency: '6/6h', duration: '2 dias',
        times: ['08:00'], quantity: 2,
        indication: 'Sintética pediatria sem peso', instructions: 'Dados sintéticos.'
      }
    });
    await api(`/prescriptions/${rx2.id}/sign`, { token, method: 'POST', expected: 201, body: { operationId: crypto.randomUUID() } });
    const bundle2 = await api<{ alerts: Array<{ code: string }> }>(`/patients/${p2.id}/medications`, { token });
    expect(bundle2.alerts.some(a => a.code === 'dose_per_kg'), 'sem peso → nenhum alerta de dose').toBe(false);
  });

  test('psiquiatria: 403 sem vínculo → break-glass → nota completa; timeline NÃO vaza seções', async () => {
    // Paciente criado pelo ADMIN: o médico de setup NÃO tem vínculo algum.
    const p = await api<{ id: string }>('/patients', {
      token: admin, method: 'POST', expected: 201,
      body: { fullName: `Paciente Psiquiatria ${nonce()}`, birthDate: '1988-11-11', administrativeGender: 'female' }
    });
    const BG = 'Acesso E2E autorizado para a jornada sintética de psiquiatria.';

    // (a) Porta clínica FECHADA sem vínculo:403 nas leituras.
    await api(`/encounters?patientId=${p.id}`, { token, expected: 403 });
    await api(`/patients/${p.id}/allergies`, { token, expected: 403 });

    // (b) Break-glass com justificativa → leitura liberada e AUDITADA.
    await api(`/patients/${p.id}/allergies`, { token, headers: { 'x-break-glass-reason': BG } });

    // (c) Jornada completa sob o vínculo criado (encontro dá contexto).
    const enc = await api<{ id: string }>('/encounters', {
      token, method: 'POST', expected: 201,
      body: { patientId: p.id, specialty: 'psychiatry', type: 'consultation', reasonForVisit: 'Jornada sintética psiquiatria' }
    });
    await draftAndSign(enc.id, 'psychiatry', {
      mentalStatus: 'Estado mental sintético SIGNILOSO-XYZ',
      riskAssessment: 'Avaliação de risco sintética RISCO-ABC',
      assessment: 'Avaliação clínica sintética.', plan: 'Plano terapêutico sintético.'
    });

    // (d) A nota completa (com seções sensíveis) fica atrás do endpoint dedicado…
    const note = await api<Note>(`/encounters/${enc.id}/notes`, { token });
    expect(note.status).toBe('signed');
    expect(note.content!.sections.mentalStatus).toContain('SIGNILOSO-XYZ');

    // …e a TIMELINE (leitura agregada) NÃO expõe o conteúdo das seções.
    const items = await api<Array<{ kind: string; summary: string | null; title: string }>>(
      `/patients/${p.id}/timeline?limit=50`, { token });
    const dump = JSON.stringify(items);
    expect(dump).not.toContain('SIGNILOSO-XYZ');
    expect(dump).not.toContain('RISCO-ABC');
    // Resumo da nota na timeline é só o marcador de versão (nunca as seções).
    expect(items.find(i => i.kind === 'note')?.summary).toMatch(/^Nota clínica v\d+$/);

    // (e) Auditoria do break-glass da jornada com requestId.
    const events = await api<Array<{ action: string; details: { requestId?: string; reason?: string } }>>(
      '/audit/events?action=access.breakglass', { token: admin });
    expect(events.some(e => e.details.reason === BG && e.details.requestId)).toBe(true);
  });

  test('ortopedia: lateralidade preservada na nota e sem vazamento na timeline', async () => {
    const p = await createPatient(`Paciente Ortopedia ${nonce()}`);
    const enc = await createEncounter(p.id, 'orthopedics');
    await draftAndSign(enc.id, 'orthopedics', {
      affectedRegion: 'Ombro direito — dominância direita',
      assessment: 'Avaliação ortopédica sintética.', plan: 'Reabilitação sintética.'
    });
    const note = await api<Note>(`/encounters/${enc.id}/notes`, { token });
    expect(note.content!.sections.affectedRegion).toBe('Ombro direito — dominância direita');

    const items = await api<Array<{ kind: string; summary: string | null; title: string }>>(
      `/patients/${p.id}/timeline?limit=50`, { token });
    expect(items.some(i => i.kind === 'encounter' && i.title === 'orthopedics · consultation')).toBe(true);
    expect(JSON.stringify(items), 'lateralidade não vaza na leitura agregada').not.toContain('Ombro direito');
  });

  test('ginecologia: especialidade disponível na UI com campos próprios (sem regra de teratogenicidade)', async ({ page }) => {
    // Setup: paciente do doctor compartilhado (vínculo via created_by).
    const p = await createPatient(`Paciente Ginecologia ${nonce()}`);
    // GET /patients/:id devolve colunas snake_case; o ADMIN não passa pela porta
    // de contexto de cuidado — busca de nome aqui é só para o seletor da UI.
    const { full_name: patientFullName } = await api<{ full_name: string }>(`/patients/${p.id}`, { token: admin });

    await page.goto('/');
    await page.getByLabel('E-mail institucional').fill(doctorEmail);
    await page.getByLabel('Senha', { exact: true }).fill(DOCTOR_PASSWORD);
    await page.getByRole('button', { name: 'Entrar no sistema' }).click();
    await expect(page.getByText('Bom atendimento começa')).toBeVisible();

    await page.getByRole('button', { name: 'Pacientes', exact: true }).click();
    await page.getByPlaceholder('Buscar por nome').fill(patientFullName);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await page.locator('.patient-row').filter({ hasText: patientFullName }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Prontuário eletrônico' })).toBeVisible();

    // Formulário de início: a nova especialidade aparece e é selecionável.
    await page.getByLabel('Especialidade').selectOption('gynecology');
    await page.getByLabel('Motivo da consulta').fill('Consulta ginecológica sintética da jornada E2E');
    await page.getByRole('button', { name: 'Iniciar', exact: true }).click();

    // Campos próprios da especialidade renderizam (EVOLUÇÃO MÉDICA: Ginecologia).
    // exact:true — o cabeçalho do paciente também contém "Ginecologia" no nome.
    await expect(page.getByRole('heading', { name: 'Ginecologia', exact: true })).toBeVisible();
    await expect(page.getByText('História ginecológica')).toBeVisible();
    await expect(page.getByText('Última menstruação (DMA)')).toBeVisible();
    // Honestidade: NENHUM texto de teratogenicidade — a regra clínica exige base
    // licenciada (pendência externa nomeada no ADR-0003).
    await expect(page.getByText(/teratog/)).toHaveCount(0);

    // O encontro gravado chega na timeline com a especialidade nova.
    const items = await api<Array<{ kind: string; title: string }>>(`/patients/${p.id}/timeline?limit=50`, { token });
    expect(items.some(i => i.kind === 'encounter' && i.title.startsWith('gynecology'))).toBe(true);
  });
});
