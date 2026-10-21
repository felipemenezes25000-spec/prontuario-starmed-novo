import { Body, ConflictException, Controller, Get, HttpException, InternalServerErrorException, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, QueryRunner, audit, requireRole } from './security';

/**
 * StarMed ST-P1-005 — EXAMES E RESULTADOS (Fase 3).
 *
 * 1) Máquina de transições do pedido diagnóstico (funções PURAS, testadas em
 *    results.test.ts): ordered → accepted → collected → preliminary → final →
 *    reviewed → communicated (+ cancelled antes do final; legados in_progress/
 *    completed preservados para o smoke e dados existentes — migração 023).
 * 2) Documento do resultado: PDF montado AQUI (buildResultPdf puro), persistido
 *    em clinical_documents (bytes + sha256; o gatilho da 022 grava v1 em
 *    document_versions sozinho) e vinculado em diagnostic_orders.
 *    DOWNLOAD com re-hash honesto (espelho de prescriptions downloadPdf).
 * 3) Integração LIS/PACS NASCE DESLIGADA: sem LIS_URL/PACS_URL (+ LIS_SANDBOX)
 *    não há UM BYTE na rede e o dispatch responde 409 honesto sem enfileirar.
 *    Fila em integration_outbox (pending→sent|failed→dead=DLQ, 5 tentativas,
 *    backoff 2^attempts minutos) + circuit breaker integration_circuit
 *    (5 falhas consecutivas → open; após 60s half_open com UMA sonda; sucesso
 *    fecha). Mesmo padrão "capacidade nasce desligada" da ACT/TSA.
 * 4) Auditoria de TODA transição/envio com metadados estruturados — nenhum
 *    texto clínico livre nos details além dos campos já estruturados do pedido.
 */

type ReqWithActor = { actor: Actor };
type PdfHttpResponse = { setHeader(name: string, value: string | number): unknown; end(chunk?: unknown): unknown };

// ---------------------------------------------------------------------------
// 1) Máquina de estados do pedido diagnóstico — TUDO PURO (sem banco, sem IO).
// ---------------------------------------------------------------------------

export const ORDER_STATUSES = [
  'ordered', 'accepted', 'collected', 'preliminary', 'final', 'reviewed', 'communicated',
  // legados (smoke/dados existentes — nunca reescritos):
  'in_progress', 'completed', 'cancelled'
] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];

/** Transições permitidas por status de ORIGEM. 'completed'/'cancelled'/'communicated' são terminais. */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  ordered: ['accepted', 'in_progress', 'cancelled'],
  accepted: ['collected', 'cancelled'],
  collected: ['preliminary', 'cancelled'],
  preliminary: ['final', 'cancelled'],
  final: ['reviewed'],
  reviewed: ['communicated'],
  communicated: [],
  // legados:
  in_progress: ['completed', 'collected', 'cancelled'],
  completed: [],
  cancelled: []
};

/** Pura: true se `to` é alcançável a partir de `from`. Status desconhecido → false. */
export function canTransition(from: string, to: string): boolean {
  const allowed = ORDER_TRANSITIONS[from as OrderStatus];
  return Array.isArray(allowed) && allowed.includes(to as OrderStatus);
}

/** Pura+exceção: 409 com mensagem clara SEM PHI (só os nomes dos status). */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new ConflictException(`Transição inválida: ${from} → ${to}`);
}

/** Status em que o PDF do resultado faz sentido (antes disso não há resultado). */
export const RESULT_READY_STATUSES = ['preliminary', 'final', 'reviewed', 'communicated'] as const;
export function resultDocumentAllowed(status: string): boolean {
  return (RESULT_READY_STATUSES as readonly string[]).includes(status);
}

// Schema zod ESTENDIDO de PATCH /hospital/orders/:id/status — preserva os campos
// que já existiam (resultSummary/pacsUrl/critical) e adiciona o resultado
// estruturado + destinatário da comunicação (contrato 023).
export const orderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  resultSummary: z.string().trim().max(10000).optional(),
  pacsUrl: z.string().url().max(2000).optional(),
  // Resultado crítico (H-12 / J1 #12): ausente = não altera; true/false define o
  // flag e QUALQUER novo resultado zera o reconhecimento anterior.
  critical: z.boolean().optional(),
  resultValue: z.string().trim().min(1).max(300).optional(),
  resultReference: z.string().trim().max(300).optional(),
  resultUnits: z.string().trim().max(80).optional(),
  communicatedTo: z.string().trim().min(3).max(120).optional()
}).strict();
export type OrderStatusBody = z.infer<typeof orderStatusSchema>;

export type TransitionFacts = {
  from: OrderStatus;
  to: OrderStatus;
  payload: { resultValue?: string; communicatedTo?: string };
  /** Fatos do pedido JÁ considerando o efeito do body nesta mesma transação
   *  (critical efetivo; ack zerado quando o body re-marca critical=true). */
  order: { critical: boolean; criticalAckAt: unknown };
};

/**
 * Pura: regras de payload por ETAPA (além da matriz de transição, que já
 * impede saltos). Devolve mensagens humanas sem PHI; lista vazia = válido.
 */
export function validateTransition(facts: TransitionFacts): string[] {
  const { from, to, payload, order } = facts;
  const errors: string[] = [];
  const value = (payload.resultValue ?? '').trim();
  if ((to === 'preliminary' || to === 'final') && (value.length === 0 || value.length > 300))
    errors.push(`Status '${to}' exige resultValue (1 a 300 caracteres).`);
  // A matriz já proíve final→vindo de collected; defesa em profundidade:
  if (to === 'final' && from !== 'preliminary')
    errors.push(`Status 'final' exige passar por 'preliminary' antes (origem atual: '${from}').`);
  if (to === 'communicated') {
    const target = (payload.communicatedTo ?? '').trim();
    if (target.length < 3 || target.length > 120)
      errors.push("Status 'communicated' exige communicatedTo (3 a 120 caracteres).");
    // J1 #12: escalação de resultado crítico SEM reconhecimento explícito é
    // recusa honesta — notificação push não conta como comunicado.
    if (order.critical && !order.criticalAckAt)
      errors.push('Resultado crítico exige reconhecimento (critical-ack) antes de comunicar.');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 2) Integração LIS/PACS — capacidade NASCE DESLIGADA (funções puras + IO).
// ---------------------------------------------------------------------------

export const MAX_DISPATCH_ATTEMPTS = 5;         // 5ª falha → 'dead' (DLQ)
export const CIRCUIT_FAILURE_THRESHOLD = 5;     // falhas consecutivas → open
export const CIRCUIT_OPEN_WINDOW_MS = 60_000;   // open → half_open após 60s
export const OUTBOX_BATCH = 20;                 // drenagem por chamada (admin)

export type LisConfig = { lisUrl: string | null; pacsUrl: string | null; sandbox: boolean };

/** Pura (env injetável): SEM URL a capacidade nasce DESLIGADA; LIS_SANDBOX='true'
 *  habilita modo simulado (resposta 200 falsa, ZERO bytes na rede). */
export function lisConfigFromEnv(source: Record<string, string | undefined> = process.env): LisConfig {
  const url = (value?: string) => {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    lisUrl: url(source.LIS_URL),
    pacsUrl: url(source.PACS_URL),
    sandbox: (source.LIS_SANDBOX ?? '').trim().toLowerCase() === 'true'
  };
}

/** Pura: canal habilitado = sandbox OU URL do canal configurada. */
export function channelEnabled(cfg: LisConfig, channel: 'lis' | 'pacs'): boolean {
  return cfg.sandbox || (channel === 'lis' ? cfg.lisUrl !== null : cfg.pacsUrl !== null);
}

/** Pura: backoff exponencial em MINUTOS (2^attempts, com teto de 24h). */
export function nextBackoff(attempts: number): number {
  const safe = Math.max(0, Math.floor(attempts));
  return Math.min(2 ** safe, 1440);
}

/** Pura: desfecho de uma tentativa que falhou (attempts já INCREMENTADO). */
export function retryDecision(attempts: number): { status: 'dead' | 'failed'; delayMinutes: number } {
  if (attempts >= MAX_DISPATCH_ATTEMPTS) return { status: 'dead', delayMinutes: 0 };
  return { status: 'failed', delayMinutes: nextBackoff(attempts) };
}

export type CircuitState = 'closed' | 'open' | 'half_open';

/** Pura: o breaker deixa tentar? closed → sim; half_open → sim (a ÚNICA sonda é
 *  reivindicada por CAS no código); open → só após a janela de 60s vencida. */
export function circuitAllows(state: CircuitState, openedAt: Date | string | null, now: Date): boolean {
  if (state === 'closed' || state === 'half_open') return true;
  if (state !== 'open' || !openedAt) return false;
  const openedMs = openedAt instanceof Date ? openedAt.getTime() : new Date(openedAt).getTime();
  if (Number.isNaN(openedMs)) return false;
  return now.getTime() - openedMs >= CIRCUIT_OPEN_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// 3) PDF do resultado — builder PURO e EXPORTADO, xref clássico (espelha o
//    padrão honesto de buildPrescriptionPdf, página única, sem dado além do pedido).
// ---------------------------------------------------------------------------

export type ResultPdfInput = {
  orderId: string;
  orderType: string;                 // 'lab' | 'imaging'
  loincCode: string | null;
  description: string;
  status: string;
  priority: string;                  // 'routine' | 'urgent'
  resultValue: string | null;
  resultReference: string | null;
  resultUnits: string | null;
  generatedAt: string;               // ISO
};

/** Escape de \ ( ) + Latin-1/WinAnsi: fora de 0x00-0xFF vira '?'. */
export function pdfText(value: string): string {
  return value.replace(/[^\u0000-\u00ff]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildResultPdf(input: ResultPdfInput): Buffer {
  const lines: { text: string; size: number }[] = [];
  const push = (text: string, size = 10) => lines.push({ text, size });
  const orNotInformed = (value: string | null) => {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : 'não informado';
  };
  push('StarMed', 12);
  push('RESULTADO DE EXAME', 13);
  push('');
  push(`Pedido: ${input.orderId}`);
  push(`Tipo: ${input.orderType === 'imaging' ? 'Imagem' : 'Laboratório'}`);
  push(`LOINC: ${orNotInformed(input.loincCode)}`);
  push(`Descrição do pedido: ${input.description}`, 11);
  push(`Prioridade: ${input.priority === 'urgent' ? 'urgente' : 'rotina'}`);
  push(`Status na emissão: ${input.status}`);
  push('');
  push('Resultado', 11);
  push(`Valor: ${orNotInformed(input.resultValue)}`);
  push(`Valores de referência: ${orNotInformed(input.resultReference)}`);
  push(`Unidades: ${orNotInformed(input.resultUnits)}`);
  push('');
  push(`Gerado em (ISO 8601): ${input.generatedAt}`);
  push('Documento gerado a partir do pedido diagnóstico; os valores são exatamente', 9);
  push('os registrados no sistema — este PDF não constitui laudo assinado.', 9);

  const A4 = { width: 595, height: 842 };
  // Página única: catálogo(1), páginas(2), página(3), conteúdo(4), fonte(5).
  const content = ['BT', `56 ${A4.height - 56} Td`];
  for (const line of lines) content.push(`/F1 ${line.size} Tf`, '14 TL', `(${pdfText(line.text)}) Tj`, 'T*');
  content.push('ET', '');
  const stream = content.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  ];

  let pdf = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ---------------------------------------------------------------------------
// 4) Transporte HTTP (timeout 5s) — usado SÓ quando o canal está ligado.
// ---------------------------------------------------------------------------

/** POST JSON com timeout de 5s; nunca lança — devolve {ok,status} ou erro de rede. */
async function postJson(url: string, payload: unknown): Promise<{ ok: boolean; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 5) Controller — endpoints novos sob /hospital/orders (o PATCH :id/status e o
//    listador permanecem em hospital.ts, estendidos para o ciclo 023).
// ---------------------------------------------------------------------------

@Controller('hospital/orders')
export class HospitalOrdersResultsController {
  constructor(private db: Db) {}

  /**
   * Gera (ou regenera) o PDF do resultado. DECISÃO DE DOCUMENTO: cada geração
   * faz INSERT NOVO em clinical_documents (o gatilho da 022 grava a v1 em
   * document_versions sozinho) e o vínculo result_document_id é APONTADO para
   * o documento novo — o documento anterior preserva seu histórico append-only.
   * NUNCA UPDATE de content: versionamento é append-only por gatilho.
   */
  @Post(':id/result-document')
  async generateResultDocument(@Req() req: ReqWithActor, @Param('id') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    const id = parse(uuid, rawId);
    const order = await this.db.query<any>(
      `SELECT id, patient_id, order_type, loinc_code, description, status, priority,
              result_value, result_reference, result_units
         FROM diagnostic_orders WHERE id=$1 AND org_id=$2`, [id, actor.org_id]);
    if (!order.rowCount) throw new NotFoundException('Pedido não encontrado');
    const row = order.rows[0];
    if (!resultDocumentAllowed(row.status))
      throw new ConflictException('PDF do resultado disponível apenas após o resultado (status preliminary, final, reviewed ou communicated).');

    const generatedAt = new Date().toISOString();
    const pdf = buildResultPdf({
      orderId: id, orderType: row.order_type, loincCode: row.loinc_code ?? null,
      description: row.description, status: row.status, priority: row.priority,
      resultValue: row.result_value ?? null, resultReference: row.result_reference ?? null,
      resultUnits: row.result_units ?? null, generatedAt
    });
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    // Chave única por geração (sem UNIQUE no schema, mas sem colisão de rastro).
    const storageKey = `orders/${actor.org_id}/${id}-${Date.now()}.pdf`;

    return this.db.tx(async c => {
      const document = await c.query<any>(
        `INSERT INTO clinical_documents(org_id,patient_id,encounter_id,doc_type,storage_key,mime_type,sha256,content,created_by)
         VALUES($1,$2,NULL,'exam_result',$3,'application/pdf',$4,$5,$6) RETURNING id,storage_key,mime_type,sha256,created_at`,
        [actor.org_id, row.patient_id, storageKey, sha256, pdf, actor.id]);
      await c.query('UPDATE diagnostic_orders SET result_document_id=$3, updated_at=now() WHERE id=$1 AND org_id=$2',
        [id, actor.org_id, document.rows[0].id]);
      await audit(c, actor, 'result.document.generated', 'diagnostic_order', id,
        { documentId: document.rows[0].id, sha256, status: row.status });
      return {
        orderId: id, documentId: document.rows[0].id, storageKey,
        sha256, status: row.status, generatedAt,
        note: 'Documento gerado e versionado (document_versions v1 pelo gatilho da migração 022). Este PDF não constitui laudo assinado.'
      };
    });
  }

  /** Download do PDF do resultado com re-hash honesto (espelho de prescriptions
   *  downloadPdf): Bearer obrigatório (nunca link público); content ausente →
   *  404 declarando a ausência; hash divergente → 500 "documento corrompido". */
  @Get(':id/result-document')
  async downloadResultDocument(@Req() req: ReqWithActor, @Param('id') rawId: string, @Res() res: PdfHttpResponse) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    const id = parse(uuid, rawId);
    const loaded = await this.db.query<any>(
      'SELECT result_document_id FROM diagnostic_orders WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
    if (!loaded.rowCount) throw new NotFoundException('Pedido não encontrado');
    const documentId: string | null = loaded.rows[0].result_document_id;
    if (!documentId) throw new NotFoundException('PDF do resultado ainda não foi gerado para este pedido.');
    try {
      const doc = await this.db.query<any>(
        'SELECT sha256, content FROM clinical_documents WHERE id=$1 AND org_id=$2', [documentId, actor.org_id]);
      if (!doc.rowCount) throw new NotFoundException('Documento do resultado não encontrado.');
      if (doc.rows[0].content === null || doc.rows[0].content === undefined)
        throw new NotFoundException('PDF não disponível: o documento do resultado não tem conteúdo persistido.');
      const content = Buffer.from(doc.rows[0].content);
      const digest = createHash('sha256').update(content).digest('hex');
      if (digest !== doc.rows[0].sha256)
        throw new InternalServerErrorException('Documento corrompido: o SHA-256 do conteúdo persistido diverge do hash registrado — o PDF não será servido.');
      await audit(this.db, actor, 'result.document.read', 'diagnostic_order', id, { documentId, sha256: digest });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="resultado-${id}.pdf"`);
      res.setHeader('Content-Length', String(content.length));
      return res.end(content);
    } catch (e) {
      await audit(this.db, actor, 'result.document.read.failed', 'diagnostic_order', id,
        { documentId, reason: e instanceof HttpException ? e.message : 'erro interno ao ler o documento' });
      throw e;
    }
  }

  /**
   * Despacho pontual para LIS/PACS. DESLIGADO → 409 honesta e NÃO enfileira.
   * LIGADO → INSERT integration_outbox + 1 tentativa inline.
   *
   * Contrato do payload (integration_outbox.payload, JSONB):
   *   { orderId, status, orderType, loincCode, description }
   * Somente metadados do pedido diagnóstico — sem resultado clínico livre e sem
   * identificação de paciente (o LIS/PACS resolve o pedido pelo orderId no
   * canal dedicado da organização).
   */
  @Post(':id/lis-dispatch')
  async lisDispatch(@Req() req: ReqWithActor, @Param('id') rawId: string, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const id = parse(uuid, rawId);
    const body = parse(z.object({ channel: z.enum(['lis', 'pacs']) }).strict(), raw);
    const channel: 'lis' | 'pacs' = body.channel;
    const cfg = lisConfigFromEnv();
    if (!channelEnabled(cfg, channel))
      throw new ConflictException(`Integração ${channel} desligada (LIS_URL/PACS_URL não configurada)`);

    const circuit = await this.db.query<any>(
      'SELECT state, opened_at, consecutive_failures FROM integration_circuit WHERE org_id=$1 AND channel=$2',
      [actor.org_id, channel]);
    const state: CircuitState = circuit.rowCount ? circuit.rows[0].state : 'closed';
    if (!circuitAllows(state, circuit.rowCount ? circuit.rows[0].opened_at : null, new Date()))
      throw new ConflictException(`Integração ${channel} pausada: circuito aberto após falhas consecutivas.`);

    const order = await this.db.query<any>(
      'SELECT id, status, order_type, loinc_code, description FROM diagnostic_orders WHERE id=$1 AND org_id=$2',
      [id, actor.org_id]);
    if (!order.rowCount) throw new NotFoundException('Pedido não encontrado');
    const row = order.rows[0];

    return this.db.tx(async c => {
      // half_open: só a sonda reivindicada pelo CAS passa (UMA tentativa).
      if (state !== 'closed' && !(await this.claimProbe(c, actor.org_id, channel)))
        throw new ConflictException(`Integração ${channel} pausada: sonda half-open em andamento.`);
      const payload = { orderId: row.id, status: row.status, orderType: row.order_type, loincCode: row.loinc_code ?? null, description: row.description };
      const queued = await c.query<any>(
        `INSERT INTO integration_outbox(org_id,channel,order_id,payload) VALUES($1,$2,$3,$4)
         RETURNING id,channel,status,attempts,next_attempt_at`,
        [actor.org_id, channel, id, JSON.stringify(payload)]);
      await audit(c, actor, 'lis.dispatch.queued', 'integration_outbox', queued.rows[0].id, { channel, orderId: id });
      const outcome = await this.attemptDelivery(c, actor, queued.rows[0].id, channel, cfg, row.status);
      return { outboxId: queued.rows[0].id, channel, status: outcome.status, sandbox: cfg.sandbox };
    });
  }

  /**
   * Drenagem administrativa: até 20 itens VENCIDOS (pending|failed com
   * next_attempt_at <= now) POR ORG (RLS + WHERE org_id). Canal desligado →
   * item fica na fila (skipped, sem bytes na rede). Circuito open vigente →
   * bloqueia o canal; half_open → UMA sonda por CAS.
   */
  @Post('outbox/dispatch')
  async dispatchOutbox(@Req() req: ReqWithActor) {
    const actor = req.actor;
    requireRole(actor, ['admin']);
    const cfg = lisConfigFromEnv();
    const now = new Date();
    const due = await this.db.query<any>(
      `SELECT id, channel, order_id, status, attempts FROM integration_outbox
        WHERE org_id=$1 AND status IN ('pending','failed') AND next_attempt_at <= now()
        ORDER BY next_attempt_at ASC LIMIT ${OUTBOX_BATCH}`, [actor.org_id]);
    const circuits = await this.db.query<any>(
      'SELECT channel, state, opened_at, consecutive_failures FROM integration_circuit WHERE org_id=$1',
      [actor.org_id]);
    const byChannel = new Map<string, { state: CircuitState; opened_at: Date | null }>();
    for (const circuit of circuits.rows) byChannel.set(circuit.channel, circuit);

    let sent = 0, failed = 0, dead = 0, blockedByCircuit = 0, skippedChannelDisabled = 0;
    for (const item of due.rows) {
      if (!channelEnabled(cfg, item.channel as 'lis' | 'pacs')) { skippedChannelDisabled++; continue; }
      const circuit = byChannel.get(item.channel);
      const state: CircuitState = circuit?.state ?? 'closed';
      if (!circuitAllows(state, circuit?.opened_at ?? null, now)) { blockedByCircuit++; continue; }
      const order = await this.db.query<any>(
        'SELECT status FROM diagnostic_orders WHERE id=$1 AND org_id=$2', [item.order_id, actor.org_id]);
      const orderStatus: string = order.rowCount ? order.rows[0].status : 'unknown';
      const outcome = await this.db.tx(c => this.attemptDelivery(c, actor, item.id, item.channel, cfg, orderStatus));
      if (outcome.status === 'sent') sent++;
      else if (outcome.status === 'dead') dead++;
      else failed++;
    }
    return { drained: due.rows.length, sent, failed, dead, blockedByCircuit, skippedChannelDisabled };
  }

  /** CAS da ÚNICA sonda half_open: open→half_open só após 60s, ou half_open
   *  vencido (>60s sem fechar) reaproveitado. Quem vence o CAS envia. */
  private async claimProbe(c: QueryRunner, orgId: string, channel: string): Promise<boolean> {
    const claimed = await c.query(
      `UPDATE integration_circuit
          SET state='half_open', updated_at=now()
        WHERE org_id=$1 AND channel=$2
          AND ((state='open' AND opened_at <= now() - make_interval(secs => 60))
            OR (state='half_open' AND updated_at <= now() - make_interval(secs => 60)))
        RETURNING state`, [orgId, channel]);
    return claimed.rowCount > 0;
  }

  /** 1 tentativa de envio + atualização honesta de outbox/circuit/DLQ. */
  private async attemptDelivery(
    c: QueryRunner, actor: Actor, outboxId: string, channel: 'lis' | 'pacs', cfg: LisConfig, orderStatus: string
  ): Promise<{ status: 'sent' | 'failed' | 'dead' }> {
    let ok = false;
    let error: string | null = null;
    if (cfg.sandbox) {
      // LIS_SANDBOX='true': simula 200 SEM rede — nenhum byte sai da máquina.
      ok = true;
    } else {
      const url = channel === 'lis' ? cfg.lisUrl! : cfg.pacsUrl!;
      try {
        const response = await postJson(url, { outboxId, channel, orderStatus });
        ok = response.ok;
        if (!ok) error = `HTTP ${response.status}`;
      } catch {
        error = 'falha de rede ou timeout (5s)';
      }
    }

    if (ok) {
      await c.query(
        `UPDATE integration_outbox SET status='sent', attempts=attempts+1, last_error=NULL, updated_at=now()
          WHERE id=$1 AND org_id=$2`, [outboxId, actor.org_id]);
      const closed = await c.query(
        `UPDATE integration_circuit SET state='closed', consecutive_failures=0, opened_at=NULL, updated_at=now()
          WHERE org_id=$1 AND channel=$2 AND (state<>'closed' OR consecutive_failures>0) RETURNING state`,
        [actor.org_id, channel]);
      if (closed.rowCount) await audit(c, actor, 'lis.circuit.closed', 'integration_circuit', null, { channel });
      return { status: 'sent' };
    }

    const bumped = await c.query(
      `UPDATE integration_outbox SET attempts=attempts+1, last_error=$3, updated_at=now()
        WHERE id=$1 AND org_id=$2 RETURNING attempts`, [outboxId, actor.org_id, error]);
    const attempts: number = bumped.rows[0].attempts;
    const decision = retryDecision(attempts);
    if (decision.status === 'dead') {
      await c.query(`UPDATE integration_outbox SET status='dead', updated_at=now() WHERE id=$1 AND org_id=$2`,
        [outboxId, actor.org_id]);
      await audit(c, actor, 'lis.dlq', 'integration_outbox', outboxId, { channel, attempts });
    } else {
      await c.query(
        `UPDATE integration_outbox SET status='failed', next_attempt_at = now() + make_interval(mins => $3), updated_at=now()
          WHERE id=$1 AND org_id=$2`, [outboxId, actor.org_id, decision.delayMinutes]);
    }
    // Circuit breaker por canal: 5 falhas consecutivas → open (auditável).
    const failures = await c.query(
      `UPDATE integration_circuit SET consecutive_failures=consecutive_failures+1, updated_at=now()
        WHERE org_id=$1 AND channel=$2 RETURNING consecutive_failures`, [actor.org_id, channel]);
    let consecutive: number;
    if (failures.rowCount) {
      consecutive = failures.rows[0].consecutive_failures;
    } else {
      await c.query(
        `INSERT INTO integration_circuit(org_id,channel,state,consecutive_failures) VALUES($1,$2,'closed',1)`,
        [actor.org_id, channel]);
      consecutive = 1;
    }
    if (consecutive >= CIRCUIT_FAILURE_THRESHOLD) {
      const opened = await c.query(
        `UPDATE integration_circuit SET state='open', opened_at=COALESCE(opened_at,now()), updated_at=now()
          WHERE org_id=$1 AND channel=$2 AND state<>'open' RETURNING state`, [actor.org_id, channel]);
      if (opened.rowCount) await audit(c, actor, 'lis.circuit.open', 'integration_circuit', null, { channel, consecutiveFailures: consecutive });
    }
    return { status: decision.status };
  }
}
