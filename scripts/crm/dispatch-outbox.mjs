#!/usr/bin/env node
/**
 * Worker de envio do crm_outbox (CRM/WhatsApp/e-mail/SMS).
 * A capacidade NASCE DESLIGADA: sem CRM_PROVIDER_URL não há bytes na rede — o worker
 * apenas reporta a fila. Com o provider configurado, envia mensagens 'queued' em
 * lotes (FOR UPDATE SKIP LOCKED — seguro para execução concorrente) e registra
 * sent/failed com o id da mensagem no provedor.
 *
 * Uso:
 *   node scripts/crm/dispatch-outbox.mjs [--batch N] [--dry-run]
 *   DATABASE_URL obrigatório (mesma base da API).
 */
import { Client } from 'pg';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BATCH = Number(flag('--batch') || 20);
const DRY_RUN = args.includes('--dry-run');

const log = (m) => process.stderr.write(m + '\n');
const fail = (m) => { log('ERRO: ' + m); process.exit(1); };

/** Seleciona o próximo lote de mensagens pendentes (puro — testável). */
export function selectBatch(rows, limit) {
  return rows.filter((r) => r.status === 'queued').slice(0, limit);
}

/** Payload enviado ao provider (puro — o formato segue o contrato comum de gateways WhatsApp). */
export function providerPayload(row) {
  return {
    channel: row.channel,
    to: row.recipient,
    type: 'template',
    template: { name: row.template, rendered: row.rendered }
  };
}

/** Classifica a resposta do provider (puro). */
export function classifyResponse(status) {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 429 || status >= 500) return 'retry';   // volta a queued para nova tentativa
  return 'failed';                                        // 4xx: erro definitivo (template/destino)
}

export async function dispatchRow(row, providerUrl, fetchImpl = fetch) {
  const response = await fetchImpl(providerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.CRM_PROVIDER_TOKEN ? { authorization: 'Bearer ' + process.env.CRM_PROVIDER_TOKEN } : {}) },
    body: JSON.stringify(providerPayload(row)),
    signal: AbortSignal.timeout(10_000)
  });
  const outcome = classifyResponse(response.status);
  const providerId = response.ok ? (await response.json().catch(() => ({})))?.id ?? null : null;
  return { outcome, providerId, status: response.status };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL é obrigatório');
  const providerUrl = process.env.CRM_PROVIDER_URL;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const pending = await client.query('SELECT count(*) AS n FROM crm_outbox WHERE status=$1', ['queued']);
    const total = Number(pending.rows[0].n);
    if (!providerUrl) {
      log(`CRM_PROVIDER_URL não configurado: capacidade desligada. Fila atual: ${total} mensagem(ns) 'queued'.`);
      log('Nada foi enviado (nasce desligado por decisão de projeto).');
      return;
    }
    if (DRY_RUN) {
      log(`[dry-run] ${total} mensagem(ns) seriam enviadas para ${providerUrl}.`);
      return;
    }
    const batch = await client.query(
      "SELECT id, channel, recipient, template, rendered FROM crm_outbox WHERE status='queued' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED", [BATCH]);
    let sent = 0, retried = 0, failed = 0;
    for (const row of batch.rows) {
      try {
        const result = await dispatchRow(row, providerUrl);
        if (result.outcome === 'sent') {
          await client.query("UPDATE crm_outbox SET status='sent', provider_message_id=$2 WHERE id=$1", [row.id, result.providerId]);
          sent++;
        } else if (result.outcome === 'retry') {
          retried++; // permanece queued; backoff fica para o agendador externo
        } else {
          await client.query("UPDATE crm_outbox SET status='failed', error_detail=$2 WHERE id=$1", [row.id, `HTTP ${result.status}`]);
          failed++;
        }
      } catch (error) {
        retried++; // rede/timeout: permanece queued
      }
    }
    log(`Lote processado: ${sent} enviada(s), ${retried} mantida(s) na fila, ${failed} falha(s).`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('dispatch-outbox.mjs')) {
  main().catch((e) => { fail(e.message); });
}
