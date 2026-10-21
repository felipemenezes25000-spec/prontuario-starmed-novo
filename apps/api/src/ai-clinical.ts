import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Db } from './db';
import { aiSuggestionSchema, parse, uuid } from './domain';
import { Actor, Public, audit, requestContext, requireRole } from './security';

/**
 * IA clínica com revisão humana OBRIGATÓRIA (CFM 2.454/2026): toda sugestão
 * nasce 'pending' e só um MÉDICO aceita/rejeita, com auditoria. Nenhum dado
 * clínico é alterado pela IA.
 */

type ReqWithActor = { actor: Actor };

const transcriptSchema = z.object({ transcript: z.string().min(10).max(20000), operationId: uuid }).strict();
const codeSuggestSchema = z.object({ text: z.string().trim().min(10).max(20000) }).strict();
const reviewSchema = z.object({ reason: z.string().trim().min(3).max(1000).optional(), appliedNote: z.string().trim().max(4000).optional() }).strict();
const editSchema = z.object({
  payload: z.record(z.unknown()).refine((o) => Object.keys(o).length >= 1, 'payload precisa de ao menos um campo')
}).strict();
const cdsHookSchema = z.object({
  hookInstance: uuid,
  hook: z.enum(['patient-view', 'order-sign', 'medication-prescribe']),
  context: z.record(z.unknown()).default({}),
  userId: z.string().max(200).optional(),
  patientId: z.string().max(200).optional()
}).strict();

// CID-10 brasileiro (SUS): capítulo com letra + 2 dígitos, subcategoria numérica opcional.
const CID10_RE = /^[A-Z][0-9]{2}(\.[0-9]{1,4})?$/;

/**
 * Versão NOMEADA do prompt de extração (Fase 8 — ST-P1-013). Qualquer mudança
 * no prompt de sistema acima DEVE vir acompanhada de um bump aqui: a
 * provenance (modelo + prompt + versão + horário) é o que permite auditar o
 * que gerou cada sugestão — CFM 2.454/2026.
 */
export const AI_PROMPT_VERSION = 'dictation-v3-f8-2026-10';

/** Defesa contra PROMPT INJECTION (Fase 8): a transcrição é CONTEÚDO DO USUÁRIO
 *  passado como mensagem `user`; heurística PT+EN detecta tentativas conhecidas
 *  de sequestrar o system prompt ou inverter o papel do modelo. A saída já é
 *  validada por zod (nada fora do schema é aceito) — aqui protegemos a ENTRADA.
 *  O texto NUNCA vai para audit_events: só os ids dos padrões e o comprimento. */
export const INJECTION_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'ignore-instrucoes', re: /ignore[ -]?(as |todas )?(instruc|instrucoes)/ },
  { id: 'esquecer-prompt', re: /esquec[ae] (o |as )?(system prompt|prompt do sistema|instruc)/ },
  { id: 'disregard', re: /disregard\s+((all|previous|prior)\s+)*(instructions|prompts)/ },
  { id: 'ignore-previous', re: /ignore\s+((all|previous|prior)\s+)*(instructions|prompts)/ },
  { id: 'dan-mode', re: /\bmodo dan\b|\bdan mode\b/ },
  { id: 'jailbreak', re: /jailbreak/ },
  { id: 'voce-e-agora', re: /voce e agora|you are now/ },
  { id: 'act-as-if', re: /act as if/ },
  { id: 'sem-restricoes', re: /responda sem restricoes|sem censura/ },
  { id: 'expor-instrucoes', re: /output (your )?(system prompt|instructions)|mostre (suas|o seu) (instruc|prompt)/ },
  { id: 'prompt-do-sistema', re: /prompt do sistema/ },
  { id: 'role-switch', re: /^(system|assistant)\s*:/m }
];

export function detectPromptInjection(text: string): { suspected: boolean; patterns: string[] } {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const patterns = INJECTION_PATTERNS.filter((p) => p.re.test(normalized)).map((p) => p.id);
  return { suspected: patterns.length > 0, patterns };
}

const INJECTION_MESSAGE =
  'Transcrição recusada: contém instruções direcionadas ao modelo (defesa contra prompt injection). ' +
  'Remova trechos de comando de sistema e reenvie.';

/** Pares de interação medicamentosa (MSE v1) — puro e testável. */
const INTERACTIONS: Array<{ a: RegExp; b: RegExp; severity: 'high' | 'moderate'; message: string }> = [
  { a: /warfarin|acenocumarol/i, b: /ibuprofeno|naproxeno|diclofenaco|celecoxibe|cetorolaco/i,
    severity: 'high', message: 'Anticoagulante + AINA: risco aumentado de sangramento. Prefira paracetamol ou AINA com menor efeito antiagregante.' },
  { a: /metformina/i, b: /iol|contraste|iodado/i,
    severity: 'high', message: 'Metfomina + meio de contraste iodado: risco de acidose láctica. Suspender metfomina 48h antes e após o exame.' },
  { a: /enalapril|losartana|captopril|ramipril/i, b: /espironolactona|amilorida/i,
    severity: 'moderate', message: 'IECA/ARA II + diurético poupador de potássio: monitorar potássio e função renal.' },
  { a: /sinvastatina|atorvastatina|rosuvastatina/i, b: /claritromicina|eritromicina|itraconazol/i,
    severity: 'high', message: 'Estatina + inibidor potente do CYP3A4: risco de rabdomiólise. Suspender a estatina durante o tratamento.' },
  { a: /dipirona/i, b: /warfarin|acenocumarol/i,
    severity: 'moderate', message: 'Dipirona + anticoagulante oral: pode potencializar o efeito anticoagulante; monitorar INR.' }
];

// Escapes Unicode explícitos: combining chars literais no regex são corrompidos pelo esbuild.
const normalize = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

export type MedInteraction = { severity: 'high' | 'moderate'; message: string; involves: string[] };
export function checkMedicationInteractions(meds: Array<{ name: string }>): MedInteraction[] {
  const out: MedInteraction[] = [];
  for (let i = 0; i < meds.length; i++) {
    for (let j = i + 1; j < meds.length; j++) {
      const na = normalize(meds[i].name);
      const nb = normalize(meds[j].name);
      for (const rule of INTERACTIONS) {
        if ((rule.a.test(na) && rule.b.test(nb)) || (rule.a.test(nb) && rule.b.test(na)))
          out.push({ severity: rule.severity, message: rule.message, involves: [meds[i].name, meds[j].name] });
      }
    }
  }
  return out;
}

export function isValidCid10(code: string): boolean { return CID10_RE.test(code); }

function buildCards(interactions: MedInteraction[]) {
  return interactions.map((i) => ({
    summary: { label: `Interação ${i.severity === 'high' ? 'grave' : 'moderada'}` },
    detail: `${i.involves.join(' + ')}: ${i.message}`,
    indicator: i.severity === 'high' ? 'warning' : 'info',
    source: { label: 'StarMed Medication Safety Engine v1' },
    overrideReasons: [
      { code: 'benefit-outweighs-risk', label: 'Benefício supera o risco' },
      { code: 'patient-tolerated', label: 'Paciente já tolera a combinação' },
      { code: 'dose-adjusted', label: 'Ajuste de dose mitigou o risco' }
    ]
  }));
}

const CDS_SERVICES = [
  { id: 'patient-view', title: 'Resumo clínico assistido' },
  { id: 'order-sign', title: 'Checagem de medicações' },
  { id: 'medication-prescribe', title: 'Interação medicamentosa' }
];

@Controller()
export class AiClinicalController {
  constructor(private db: Db) {}

  @Public()
  @Get('cds-services')
  services() { return { services: CDS_SERVICES }; }

  // O hook devolve cartões derivados do payload recebido: exige sessão autenticada
  // (um provedor externo de CDS deve se registrar com OAuth/SMART próprio — pendência
  // de homologação, não motivo para manter rota anônima).
  @Post('cds-services/:hook')
  async hook(@Param('hook') hook: string, @Body() raw: unknown) {
    if (!CDS_SERVICES.some((s) => s.id === hook)) throw new NotFoundException('Serviço CDS inexistente');
    const body = parse(cdsHookSchema, { ...((raw as object) || {}), hook });
    const meds: Array<{ name: string }> = Array.isArray((body.context as any)?.medications)
      ? (body.context as any).medications.filter((m: any) => m && typeof m.name === 'string')
      : [];
    const interactions = checkMedicationInteractions(meds);
    return { cards: buildCards(interactions) };
  }

  @Post('encounters/:encounterId/ai/dictation')
  async dictation(@Req() req: ReqWithActor, @Param('encounterId') rawId: string, @Body() raw: unknown) {
    return this.extract(req.actor, parse(uuid, rawId), parse(transcriptSchema, raw), 'dictation');
  }

  @Post('encounters/:encounterId/ai/discharge-summary')
  async dischargeSummary(@Req() req: ReqWithActor, @Param('encounterId') rawId: string, @Body() raw: unknown) {
    return this.extract(req.actor, parse(uuid, rawId), parse(transcriptSchema, raw), 'discharge-summary');
  }

  private async extract(actor: Actor, encounterId: string, body: { transcript: string; operationId: string }, kind: 'dictation' | 'discharge-summary') {
    requireRole(actor, ['doctor']);
    // Defesa anti-injection ANTES de replay/provedor: tentativa de sequestro do
    // system prompt nunca chega ao modelo nem vira cache de replay.
    const injection = detectPromptInjection(body.transcript);
    if (injection.suspected) {
      await audit(this.db, actor, 'ai.injection.suspected', 'encounter', encounterId,
        { patterns: injection.patterns, length: body.transcript.length });
      throw new BadRequestException(INJECTION_MESSAGE);
    }
    const encounter = await this.db.query('SELECT 1 FROM encounters WHERE id=$1 AND org_id=$2', [encounterId, actor.org_id]);
    if (!encounter.rowCount) throw new NotFoundException('Atendimento não encontrado');
    const replay = await this.db.query('SELECT response FROM idempotency_keys WHERE org_id=$1 AND key=$2', [actor.org_id, body.operationId]);
    if (replay.rowCount) return replay.rows[0].response;
    const model = process.env.LLM_API_URL;
    if (!model) throw new ServiceUnavailableException('Provedor IA não configurado (LLM_API_URL)');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(model, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(process.env.LLM_API_KEY ? { authorization: 'Bearer ' + process.env.LLM_API_KEY } : {}) },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || undefined,
          messages: [
            { role: 'system', content: kind === 'dictation'
              ? 'Extraia do transcript clínico JSON com: chief_complaint, hpi, exam_findings (array), assessment (array de {text, icd10, certainty}), medications_mentioned (array), plan_as_spoken (array), uncertainties (array). Nada de campos extras.'
              : 'Produza JSON de resumo de alta com: motivos (array), condutas (array), medicamentos (array de {name, dose, route, frequency, context}), follow_up (array), uncertainties (array).' },
            { role: 'user', content: body.transcript }
          ],
          temperature: 0.1
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new ServiceUnavailableException('Provedor IA indisponível');
      const payload: any = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.length > 30000) throw new ServiceUnavailableException('Resposta IA inválida');
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new ServiceUnavailableException('JSON IA inválido'); }
      const validated = aiSuggestionSchema.safeParse(parsed);
      if (!validated.success) throw new ServiceUnavailableException('O provedor retornou campos clínicos inválidos; nada foi registrado');
      const suggestion = { ...validated.data, requires_physician_review: true };
      const stored = await this.db.tx(async c => {
        const row = await c.query(
          'INSERT INTO ai_suggestions(org_id,encounter_id,kind,payload,model,prompt_version,generated_at,created_by) VALUES($1,$2,$3,$4,$5,$6,now(),$7) RETURNING id,kind,status,prompt_version,generated_at,created_at',
          [actor.org_id, encounterId, kind, JSON.stringify(suggestion), process.env.LLM_MODEL || 'unknown', AI_PROMPT_VERSION, actor.id]);
        await c.query('INSERT INTO idempotency_keys(org_id,key,operation,response) VALUES($1,$2,$3,$4)',
          [actor.org_id, body.operationId, `ai.${kind}:${encounterId}`, JSON.stringify(row.rows[0])]);
        await c.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',
          [actor.org_id, actor.id, `ai.${kind}.requested`, 'encounter', encounterId, JSON.stringify({requestId:requestContext.getStore()?.requestId??null})]);
        return row.rows[0];
      });
      // PROVENANCE (Fase 8): modelo + versão do prompt + horário saem junto —
      // a revisão humana precisa saber O QUE gerou a sugestão.
      return {
        suggestionId: stored.id, suggestion, status: 'pending', reviewRequired: true,
        provenance: { model: process.env.LLM_MODEL || 'unknown', promptVersion: stored.prompt_version, generatedAt: stored.generated_at }
      };
    } finally { clearTimeout(timeout); }
  }

  @Post('ai/codes/suggest')
  async codes(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['doctor']);
    const body = parse(codeSuggestSchema, raw);
    // Mesma defesa de ENTRADA do dictation: texto com comandos de sistema não
    // chega ao provedor.
    const injection = detectPromptInjection(body.text);
    if (injection.suspected) {
      await audit(this.db, actor, 'ai.injection.suspected', 'organization', actor.org_id,
        { patterns: injection.patterns, length: body.text.length });
      throw new BadRequestException(INJECTION_MESSAGE);
    }
    if (!process.env.LLM_API_URL) throw new ServiceUnavailableException('Provedor IA não configurado (LLM_API_URL)');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(process.env.LLM_API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(process.env.LLM_API_KEY ? { authorization: 'Bearer ' + process.env.LLM_API_KEY } : {}) },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || undefined,
          messages: [
            { role: 'system', content: 'Sugira códigos CID-10 (ex.: I10, E11.9) e, se aplicável, códigos TUSS de procedimento para o texto clínico. JSON: {"icd10":[{"code":"...","display":"..."}],"tuss":[{"code":"...","display":"..."}]}. Nada fora do JSON.' },
            { role: 'user', content: body.text }
          ],
          temperature: 0.1
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new ServiceUnavailableException('Provedor IA indisponível');
      const payload: any = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new ServiceUnavailableException('Resposta IA inválida');
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { throw new ServiceUnavailableException('JSON IA inválido'); }
      const icd10 = Array.isArray(parsed?.icd10)
        ? parsed.icd10.filter((c: any) => c && isValidCid10(String(c.code))).map((c: any) => ({ code: String(c.code), display: String(c.display || '') }))
        : [];
      if (icd10.length === 0 && (!Array.isArray(parsed?.tuss) || parsed.tuss.length === 0))
        throw new ServiceUnavailableException('O provedor não retornou códigos válidos; nada foi registrado');
      const stored = await this.db.query<any>(
        'INSERT INTO ai_suggestions(org_id,kind,payload,model,prompt_version,generated_at,created_by) VALUES($1,$2,$3,$4,$5,now(),$6) RETURNING id,status,prompt_version,generated_at,created_at',
        [actor.org_id, 'code-suggestion', JSON.stringify({ icd10, tuss: parsed?.tuss ?? [] }), process.env.LLM_MODEL || 'unknown', AI_PROMPT_VERSION, actor.id]);
      await audit(this.db, actor, 'ai.codes.suggested', 'organization', actor.org_id);
      return {
        suggestionId: stored.rows[0].id, icd10, tuss: parsed?.tuss ?? [], status: 'pending', reviewRequired: true,
        provenance: { model: process.env.LLM_MODEL || 'unknown', promptVersion: stored.rows[0].prompt_version, generatedAt: stored.rows[0].generated_at }
      };
    } finally { clearTimeout(timeout); }
  }

  @Get('ai/suggestions')
  async list(@Req() req: ReqWithActor, @Query('status') status?: string, @Query('encounterId') encounterId?: string) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    const filters: string[] = ['org_id=$1'];
    const params: unknown[] = [actor.org_id];
    if (status) { params.push(status); filters.push(`status=$${params.length}`); }
    if (encounterId) { params.push(parse(uuid, encounterId)); filters.push(`encounter_id=$${params.length}`); }
    const rows = await this.db.query(
      `SELECT id,encounter_id,kind,status,payload,model,prompt_version,generated_at,created_by,reviewed_by,review_note,reviewed_at,created_at
       FROM ai_suggestions WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT 100`, params);
    // Auditoria da listagem de revisão (Fase 8): quem listou o quê (ids/contagem).
    await audit(this.db, actor, 'ai.suggestions.listed', 'organization', actor.org_id,
      { status: status ?? 'all', count: rows.rowCount });
    return rows.rows;
  }

  /** EDIÇÃO humana antes do aceite (Fase 8): o médico corrige o payload
   *  sugerido; a alteração é auditada por NOMES de campo (sem conteúdo clínico).
   *  Sugestão editada continua 'pending' — só o aceite/rejeição fecha a revisão. */
  @Post('ai/suggestions/:id/edit')
  async editSuggestion(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['doctor']);
    const body = parse(editSchema, raw);
    const id = parse(uuid, rawId);
    const current = await this.db.query<any>(
      'SELECT payload FROM ai_suggestions WHERE id=$1 AND org_id=$2 AND status=\'pending\'', [id, actor.org_id]);
    if (!current.rowCount) throw new NotFoundException('Sugestão inexistente ou já revisada');
    const merged = { ...(current.rows[0].payload as Record<string, unknown>), ...body.payload, requires_physician_review: true };
    const updated = await this.db.query<any>(
      'UPDATE ai_suggestions SET payload=$3 WHERE id=$1 AND org_id=$2 AND status=\'pending\' RETURNING id,status',
      [id, actor.org_id, JSON.stringify(merged)]);
    if (!updated.rowCount) throw new NotFoundException('Sugestão já revisada');
    const fields = Object.keys(body.payload);
    await audit(this.db, actor, 'ai.suggestion.edited', 'ai_suggestion', id, { fields });
    return { ...updated.rows[0], editedFields: fields };
  }

  @Post('ai/suggestions/:id/accept')
  async accept(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    return this.review(req.actor, parse(uuid, rawId), parse(reviewSchema, raw), 'accepted');
  }

  @Post('ai/suggestions/:id/reject')
  async reject(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    return this.review(req.actor, parse(uuid, rawId), parse(reviewSchema, raw), 'rejected');
  }

  private async review(actor: Actor, id: string, body: { reason?: string; appliedNote?: string }, decision: 'accepted' | 'rejected') {
    requireRole(actor, ['doctor']);
    if (decision === 'rejected' && !body.reason)
      throw new ForbiddenException('Rejeição exige reason');
    const updated = await this.db.query<any>(
      'UPDATE ai_suggestions SET status=$3, reviewed_by=$4, review_note=$5, reviewed_at=now() WHERE id=$1 AND org_id=$2 AND status=\'pending\' RETURNING id,status,reviewed_at',
      [id, actor.org_id, decision, actor.id, body.reason ?? body.appliedNote ?? null]);
    if (!updated.rowCount) throw new NotFoundException('Sugestão inexistente ou já revisada');
    await audit(this.db, actor, `ai.suggestion.${decision}`, 'ai_suggestion', id);
    return updated.rows[0];
  }
}
