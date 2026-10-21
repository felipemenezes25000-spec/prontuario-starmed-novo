// StarMed Fase 6 — ADAPTERS DE SAÍDA de interoperabilidade (ST-P1-009/010).
//
// O integration_outbox nasceu no 023 com 'lis'|'pacs'; a migração 025 alarga o
// MESMO mecanismo (pending→sent|failed→dead, backoff 2^n, circuit breaker por
// canal/org) para hl7/tiss/nfse/rnds/dicom — um único audit em vez de filas
// paralelas. Todos os canais NASCEM DESLIGADOS: sem o env correspondente não
// há um byte na rede (o despacho reporta skippedChannelDisabled e a mensagem
// permanece na fila).
//
// Reuso deliberado das funções puras de orders.ts (nextBackoff/retryDecision/
// circuitAllows): a regra de retry/breaker é UMA, testada no hospitalar, e é
// re-exportada aqui para os testes de interoperabilidade.
import {
  CIRCUIT_FAILURE_THRESHOLD,
  OUTBOX_BATCH,
  circuitAllows,
  nextBackoff,
  retryDecision,
  type CircuitState
} from '../orders';
import type { Db } from '../db';
import { audit, type Actor, type QueryRunner } from '../security';
import { sendHl7MllpTls } from './mllp';

// Re-export puro: os testes de interoperabilidade exercitam exatamente as
// funções usadas pelo despacho (sem duplicar lógica).
export { circuitAllows, nextBackoff, retryDecision };
export { CIRCUIT_FAILURE_THRESHOLD, OUTBOX_BATCH };

/** Canais aceitos pela constraint 025 — fonte única para zod e testes. */
export const INTEROP_CHANNELS = ['lis', 'pacs', 'hl7', 'tiss', 'nfse', 'rnds', 'dicom'] as const;
export type InteropChannel = (typeof INTEROP_CHANNELS)[number];

/** Env primário (URL/host) e de sandbox de cada canal — usado nas mensagens
 *  honestas de "desligado" e documentado no relatório da fase. */
export const OUTBOUND_ENVS: Record<InteropChannel, { primary: string; sandbox: string }> = {
  lis: { primary: 'LIS_URL', sandbox: 'LIS_SANDBOX' },
  pacs: { primary: 'PACS_URL', sandbox: 'PACS_SANDBOX' },
  hl7: { primary: 'HL7_MLLP_HOST', sandbox: 'HL7_MLLP_SANDBOX' },
  tiss: { primary: 'TISS_LOTE_URL', sandbox: 'TISS_SANDBOX' },
  nfse: { primary: 'NFSE_URL', sandbox: 'NFSE_SANDBOX' },
  rnds: { primary: 'RNDS_SUBMIT_URL', sandbox: 'RNDS_SANDBOX' },
  dicom: { primary: 'DICOMWEB_URL', sandbox: 'DICOMWEB_SANDBOX' }
};

export type OutboundConfig = {
  channel: InteropChannel;
  enabled: boolean;
  /** null quando habilitado; caso contrário o motivo honesto (sem PHI). */
  reason: string | null;
  /** Endpoint HTTP(S) do canal; null para hl7 (transporte MLLP dedicado). */
  url: string | null;
  /** *_SANDBOX='true' → resposta simulada, ZERO bytes na rede. */
  sandbox: boolean;
  /** Nome do env primário (para mensagens de erro honestas). */
  primaryEnv: string;
  // Campos MLLP (hl7); nulos nos demais canais.
  host: string | null;
  port: number | null;
  tls: boolean;
  caPath: string | null;
  clientCertPath: string | null;
  clientKeyPath: string | null;
};

const trim = (value?: string) => (value ?? '').trim();
const present = (value?: string) => trim(value).length > 0;
const isTrue = (value?: string) => trim(value).toLowerCase() === 'true';

/** Porta MLLP clássica (HL7 transport); cobre a ausência de HL7_MLLP_PORT. */
export const DEFAULT_MLLP_PORT = 2575;

/**
 * Pura (env injetável): configuração de SAÍDA do canal. Nasce DESLIGADA quando
 * falta o env primário; `reason` nomeia exatamente o env ausente. Decisão de
 * segurança do canal hl7: MLLP SEM TLS não é suportado (HL7_MLLP_TLS=false ⇒
 * segue desligado) e TLS exige CA própria em PEM (HL7_MLLP_CA) — nunca
 * caímos para "confiar em qualquer certificado".
 */
export function outboundConfigFromEnv(
  channel: InteropChannel,
  source: Record<string, string | undefined> = process.env
): OutboundConfig {
  const meta = OUTBOUND_ENVS[channel];
  const base: OutboundConfig = {
    channel,
    enabled: false,
    reason: null,
    url: null,
    sandbox: false,
    primaryEnv: meta.primary,
    host: null,
    port: null,
    tls: false,
    caPath: null,
    clientCertPath: null,
    clientKeyPath: null
  };

  if (channel === 'hl7') {
    const host = present(source.HL7_MLLP_HOST) ? trim(source.HL7_MLLP_HOST) : null;
    const portRaw = trim(source.HL7_MLLP_PORT);
    const port = /^\d+$/.test(portRaw) ? Number(portRaw) : DEFAULT_MLLP_PORT;
    const tlsRaw = trim(source.HL7_MLLP_TLS).toLowerCase();
    const tls = tlsRaw === '' ? true : tlsRaw === 'true'; // só 'true' é aceito
    const caPath = present(source.HL7_MLLP_CA) ? trim(source.HL7_MLLP_CA) : null;
    const clientCertPath = present(source.HL7_MLLP_CLIENT_CERT) ? trim(source.HL7_MLLP_CLIENT_CERT) : null;
    const clientKeyPath = present(source.HL7_MLLP_CLIENT_KEY) ? trim(source.HL7_MLLP_CLIENT_KEY) : null;
    // LIS_SANDBOX-style: o sandbox habilita a operação SIMULADA sem rede.
    const sandbox = isTrue(source.HL7_MLLP_SANDBOX);
    const configured = host !== null && tls && caPath !== null;
    const enabled = sandbox || configured;
    let reason: string | null = null;
    if (!enabled) {
      if (host === null) reason = 'hl7 desligado (HL7_MLLP_HOST ausente)';
      else if (!tls) reason = "hl7 desligado (HL7_MLLP_TLS deve ser 'true' — MLLP sem TLS não é suportado)";
      else reason = 'hl7 desligado (HL7_MLLP_CA ausente — TLS com CA própria é obrigatório)';
    }
    return { ...base, enabled, reason, sandbox, host, port, tls, caPath, clientCertPath, clientKeyPath };
  }

  // lis/pacs: espelha lisConfigFromEnv de orders.ts (LIS_SANDBOX cobre os dois,
  // como no despacho hospitalar); PACS_SANDBOX é aceito como alias de pacs.
  if (channel === 'lis' || channel === 'pacs') {
    const url = present(source[meta.primary]) ? trim(source[meta.primary]) : null;
    const sandbox = isTrue(source.LIS_SANDBOX) || isTrue(source[meta.sandbox]);
    const enabled = sandbox || url !== null;
    return { ...base, enabled, reason: enabled ? null : `${channel} desligado (${meta.primary} ausente)`, url, sandbox };
  }

  // tiss/nfse/rnds/dicom: URL obrigatória; *_SANDBOX='true' simula sem rede.
  const url = present(source[meta.primary]) ? trim(source[meta.primary]) : null;
  const sandbox = isTrue(source[meta.sandbox]);
  const enabled = sandbox || url !== null;
  return { ...base, enabled, reason: enabled ? null : `${channel} desligado (${meta.primary} ausente)`, url, sandbox };
}

// ---------------------------------------------------------------------------
// Enfileiramento — metadados de mensagem, nunca dado clínico além do pedido.
// ---------------------------------------------------------------------------

export type EnqueueInteropInput = {
  orgId: string;
  channel: InteropChannel;
  /** JSON do pedido/metadados da mensagem (JSONB de integration_outbox). */
  payload: Record<string, unknown>;
  /** 023: integration_outbox.order_id é NOT NULL + FK em diagnostic_orders. */
  orderId?: string | null;
  patientId?: string | null;
};

/**
 * INSERT em integration_outbox (status 'pending'). `patientId`, quando informado,
 * é gravado como referência `Patient/<id>` DENTRO do payload — só o identificador
 * (metadado já presente na própria mensagem), sem nome/data/clínica.
 *
 * Pendência de migração registrada no relatório: a coluna order_id nasceu
 * NOT NULL com FK para diagnostic_orders (023) e nenhum canal interop escapa
 * disso; sem orderId o INSERT violaria a constraint e abortaria a transação,
 * então falhamos CEDO e honestamente.
 */
export async function enqueueInterop(client: QueryRunner, input: EnqueueInteropInput): Promise<{ id: string; status: string }> {
  const { orgId, channel, payload, orderId, patientId } = input;
  if (!orderId) {
    throw new Error(
      `integration_outbox.order_id é NOT NULL (migração 023): informe um orderId para enfileirar no canal '${channel}'.`
    );
  }
  const body: Record<string, unknown> = {
    ...payload,
    ...(patientId ? { patientRef: `Patient/${patientId}` } : {})
  };
  const inserted = await client.query(
    `INSERT INTO integration_outbox(org_id,channel,order_id,payload) VALUES($1,$2,$3,$4)
     RETURNING id,status`,
    [orgId, channel, orderId, JSON.stringify(body)]
  );
  return { id: inserted.rows[0].id, status: inserted.rows[0].status };
}

// ---------------------------------------------------------------------------
// Despacho — espelha o padrão do hospital (orders.ts): drenagem de vencidos,
// breaker por canal, DLQ na 5ª falha, audit `interop.dlq`.
// ---------------------------------------------------------------------------

export type DispatchInteropOutcome = {
  drained: number;
  sent: number;
  failed: number;
  dead: number;
  blockedByCircuit: number;
  skippedChannelDisabled: number;
};

/** POST JSON com timeout de 5s; nunca lança — devolve {ok,status} ou erro. */
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

/**
 * Drena até OUTBOX_BATCH itens VENCIDOS (pending|failed vencidos) de UM canal
 * da org (RLS + WHERE org_id). Canal desligado → skippedChannelDisabled (a
 * mensagem fica na fila; zero bytes na rede). Circuito open vigente →
 * blockedByCircuit. Cada item recebe UMA tentativa em transação própria.
 */
export async function dispatchInterop(db: Db, actor: Actor, channel: InteropChannel): Promise<DispatchInteropOutcome> {
  const cfg = outboundConfigFromEnv(channel);
  const now = new Date();
  const due = await db.query(
    `SELECT id, status, attempts, payload FROM integration_outbox
      WHERE org_id=$1 AND channel=$2 AND status IN ('pending','failed') AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC LIMIT ${OUTBOX_BATCH}`,
    [actor.org_id, channel]
  );
  const circuits = await db.query(
    'SELECT state, opened_at, consecutive_failures FROM integration_circuit WHERE org_id=$1 AND channel=$2',
    [actor.org_id, channel]
  );
  const state: CircuitState = circuits.rowCount ? circuits.rows[0].state : 'closed';
  const openedAt = circuits.rowCount ? circuits.rows[0].opened_at : null;

  const out: DispatchInteropOutcome = {
    drained: due.rows.length,
    sent: 0,
    failed: 0,
    dead: 0,
    blockedByCircuit: 0,
    skippedChannelDisabled: 0
  };
  for (const item of due.rows) {
    if (!cfg.enabled) {
      out.skippedChannelDisabled++;
      continue;
    }
    if (!circuitAllows(state, openedAt, now)) {
      out.blockedByCircuit++;
      continue;
    }
    const outcome = await db.tx(c => attemptInteropDelivery(c, actor, item.id, channel, cfg, item.payload));
    if (outcome.status === 'sent') out.sent++;
    else if (outcome.status === 'dead') out.dead++;
    else out.failed++;
  }
  return out;
}

type AttemptOutcome = { status: 'sent' | 'failed' | 'dead' };

/** 1 tentativa de envio + atualização honesta de outbox/circuit/DLQ. */
async function attemptInteropDelivery(
  c: QueryRunner,
  actor: Actor,
  outboxId: string,
  channel: InteropChannel,
  cfg: OutboundConfig,
  payload: unknown
): Promise<AttemptOutcome> {
  let ok = false;
  let error: string | null = null;

  if (cfg.sandbox) {
    // *_SANDBOX='true': simula 200 SEM rede — nenhum byte sai da máquina.
    ok = true;
  } else if (channel === 'hl7') {
    const message =
      payload && typeof payload === 'object' && typeof (payload as { message?: unknown }).message === 'string'
        ? ((payload as { message: string }).message as string)
        : null;
    if (!message) {
      error = "payload sem campo 'message' (HL7 exige o texto da mensagem para MLLP)";
    } else {
      try {
        const resposta = await sendHl7MllpTls({
          host: cfg.host!,
          port: cfg.port!,
          message,
          caPath: cfg.caPath!,
          certPath: cfg.clientCertPath,
          keyPath: cfg.clientKeyPath
        });
        ok = resposta.ack !== null && resposta.ack.code === 'AA';
        if (!ok) error = resposta.ack ? `ACK ${resposta.ack.code}` : 'conexão encerrada sem ACK';
      } catch (e) {
        error = e instanceof Error ? e.message : 'falha MLLP (timeout 5s ou TLS)';
      }
    }
  } else {
    try {
      const response = await postJson(cfg.url!, { outboxId, channel, payload });
      ok = response.ok;
      if (!ok) error = `HTTP ${response.status}`;
    } catch {
      error = 'falha de rede ou timeout (5s)';
    }
  }

  if (ok) {
    await c.query(
      `UPDATE integration_outbox SET status='sent', attempts=attempts+1, last_error=NULL, updated_at=now()
        WHERE id=$1 AND org_id=$2`,
      [outboxId, actor.org_id]
    );
    const closed = await c.query(
      `UPDATE integration_circuit SET state='closed', consecutive_failures=0, opened_at=NULL, updated_at=now()
        WHERE org_id=$1 AND channel=$2 AND (state<>'closed' OR consecutive_failures>0) RETURNING state`,
      [actor.org_id, channel]
    );
    if (closed.rowCount) await auditSafe(c, actor, 'interop.circuit.closed', channel);
    return { status: 'sent' };
  }

  const bumped = await c.query(
    `UPDATE integration_outbox SET attempts=attempts+1, last_error=$3, updated_at=now()
      WHERE id=$1 AND org_id=$2 RETURNING attempts`,
    [outboxId, actor.org_id, error]
  );
  const attempts: number = bumped.rows[0].attempts;
  const decision = retryDecision(attempts);
  if (decision.status === 'dead') {
    await c.query(`UPDATE integration_outbox SET status='dead', updated_at=now() WHERE id=$1 AND org_id=$2`, [
      outboxId,
      actor.org_id
    ]);
    // DLQ: sem retry automático depois disso (reprocesso é decisão humana).
    await audit(c, actor, 'interop.dlq', 'integration_outbox', outboxId, { channel, attempts });
  } else {
    await c.query(
      `UPDATE integration_outbox SET status='failed', next_attempt_at = now() + make_interval(mins => $3), updated_at=now()
        WHERE id=$1 AND org_id=$2`,
      [outboxId, actor.org_id, decision.delayMinutes]
    );
  }
  const consecutive = await bumpCircuit(c, actor.org_id, channel);
  if (consecutive >= CIRCUIT_FAILURE_THRESHOLD) {
    const opened = await c.query(
      `UPDATE integration_circuit SET state='open', opened_at=COALESCE(opened_at,now()), updated_at=now()
        WHERE org_id=$1 AND channel=$2 AND state<>'open' RETURNING state`,
      [actor.org_id, channel]
    );
    if (opened.rowCount)
      await audit(c, actor, 'interop.circuit.open', 'integration_circuit', null, {
        channel,
        consecutiveFailures: consecutive
      });
  }
  return { status: decision.status };
}

/** Audit sem PHI: só canal — delega ao helper audit() (audit_events + requestId). */
async function auditSafe(c: QueryRunner, actor: Actor, action: string, channel: InteropChannel): Promise<void> {
  await audit(c, actor, action, 'integration_circuit', null, { channel });
}

/**
 * Falhas consecutivas por canal: UPDATE quando a linha existe; INSERT quando
 * não existe — mas o CHECK de channel de integration_circuit nasceu no 023
 * limitado a 'lis'|'pacs' e o 025 alargou SÓ o outbox. Savepoint mantém a
 * transação viva (outbox atualizado com honestidade) até a migração alargar a
 * tabela de circuito; retorna 0 = breaker ainda não suportado neste canal.
 */
async function bumpCircuit(c: QueryRunner, orgId: string, channel: InteropChannel): Promise<number> {
  const failures = await c.query(
    `UPDATE integration_circuit SET consecutive_failures=consecutive_failures+1, updated_at=now()
      WHERE org_id=$1 AND channel=$2 RETURNING consecutive_failures`,
    [orgId, channel]
  );
  if (failures.rowCount > 0) return failures.rows[0].consecutive_failures;
  await c.query('SAVEPOINT interop_circuit_row');
  try {
    await c.query(`INSERT INTO integration_circuit(org_id,channel,state,consecutive_failures) VALUES($1,$2,'closed',1)`, [
      orgId,
      channel
    ]);
    await c.query('RELEASE SAVEPOINT interop_circuit_row');
    return 1;
  } catch {
    await c.query('ROLLBACK TO SAVEPOINT interop_circuit_row');
    return 0;
  }
}
