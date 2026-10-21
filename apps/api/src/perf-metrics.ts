import { Body, Controller, Get, HttpException, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, audit, requireRole } from './security';
import { Db } from './db';

/**
 * Métricas de desempenho SEM PHI (ST-P1-012).
 *
 * - API: middleware mede toda requisição e agrupa por ROTA NORMALIZADA (ids
 *   substituídos por :id — nunca paciente/usuário nos dados). Amostragem
 *   limitada em memória por chave (janela desde o boot; nada persistido).
 * - UI: `POST /metrics/ui` recebe {event, durationMs, ok} dos5 eventos nomeados
 *   do ST-P1-012 — enum FECHADO (sem texto livre ⇒ sem canal de PHI) e sessão
 *   obrigatória ( JwtGuard padrão: sem @Public não entra ).
 * - `GET /metrics/perf` (admin) devolve por chave: count, errorRate, p50, p95,
 *   janela (since) — taxa de erro = erros/total; "abandono" do fluxo é o
 *   equivalente a ok=false (cliente cancelou/falhou antes de concluir).
 * Honestidade: métricas em MEMÓRIA, zeram no restart, sem cross-sessão e sem
 * qualquer identificador de paciente/usuário.
 */

export const UI_PERF_EVENTS = ['open_record', 'sign_note', 'create_prescription', 'load_history', 'check_allergy'] as const;
export type UiPerfEvent = typeof UI_PERF_EVENTS[number];

const MAX_SAMPLES_PER_KEY = 2000;
type Bucket = { durations: number[]; ok: number; err: number; since: number };
const store = new Map<string, Bucket>();

function bucketFor(key: string): Bucket {
  let b = store.get(key);
  if (!b) { b = { durations: [], ok: 0, err: 0, since: Date.now() }; store.set(key, b); }
  return b;
}

export function recordSample(key: string, durationMs: number, ok: boolean): void {
  const b = bucketFor(key);
  if (ok) b.ok += 1; else b.err += 1;
  b.durations.push(durationMs);
  if (b.durations.length > MAX_SAMPLES_PER_KEY) b.durations.splice(0, b.durations.length - MAX_SAMPLES_PER_KEY);
}

/** Rota → chave sem identificadores: UUIDs e trechos numéricos viram :id. */
export function normalizeRouteKey(method: string, path: string): string {
  const clean = path.split('?')[0];
  const normalized = clean
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[^/]{16,}(?=\/|$)/g, '/:id'); // códigos longos (convites etc.)
  return `${method} ${normalized}`.slice(0, 160);
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

export function summarize(storeSnapshot: Map<string, Bucket>): Array<{
  key: string; count: number; errorRate: number; p50: number | null; p95: number | null; since: string;
}> {
  const out: ReturnType<typeof summarize> = [];
  for (const [key, b] of storeSnapshot) {
    const count = b.ok + b.err;
    if (!count) continue;
    const sorted = [...b.durations].sort((a, c) => a - c);
    out.push({
      key,
      count,
      errorRate: Math.round((b.err / count) * 10000) / 10000,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      since: new Date(b.since).toISOString()
    });
  }
  return out.sort((a, c) => a.key.localeCompare(c.key));
}

export function perfSnapshot(): ReturnType<typeof summarize> {
  return summarize(store);
}

/** Middleware factory: mede no `finish` de cada resposta (rota normalizada). */
export function perfMetricsMiddleware() {
  const started = new WeakMap<object, number>();
  return (req: { method?: string; originalUrl?: string; url?: string }, res: {
    statusCode?: number;
    on(event: 'finish', cb: () => void): unknown;
  }, next: () => void): void => {
    if (req.originalUrl?.startsWith('/metrics')) { next(); return; }
    started.set(res as object, Date.now());
    res.on('finish', () => {
      try {
        const begin = started.get(res as object);
        if (begin === undefined) return;
        const path = req.originalUrl ?? req.url ?? '/';
        if (path.startsWith('/metrics')) return;
        const key = normalizeRouteKey(req.method ?? 'GET', path);
        const ok = (res.statusCode ?? 500) < 400;
        recordSample(key, Date.now() - begin, ok);
      } catch { /* métrica nunca derruba a aplicação */ }
    });
    next();
  };
}

const uiEventSchema = z.object({
  event: z.enum(UI_PERF_EVENTS),
  durationMs: z.number().finite().min(0).max(120_000),
  ok: z.boolean()
}).strict();

type ReqWithActor = { actor: Actor };

@Controller('metrics')
export class PerfMetricsController {
  constructor(private db: Db) {}

  /** Recebe o beacon da UI: enum fechado + duração limitada — sem texto, sem
   *  ids, sem PHI possível por construção. Sessão staff obrigatória (sem @Public). */
  @Post('ui')
  async uiEvent(@Req() req: ReqWithActor, @Body() raw: unknown) {
    requireRole(req.actor, ['admin', 'doctor', 'nurse', 'reception']);
    const parsed = uiEventSchema.safeParse(raw);
    if (!parsed.success) throw new HttpException({ message: 'Métrica inválida' }, 400);
    const { event, durationMs, ok } = parsed.data;
    recordSample(`ui:${event}`, durationMs, ok);
    return { ok: true };
  }

  /** Agregados p50/p95 + taxa de erro por rota/evento (admin; sem PHI). */
  @Get('perf')
  async perf(@Req() req: ReqWithActor) {
    requireRole(req.actor, ['admin']);
    await audit(this.db, req.actor, 'metrics.perf.read', 'metrics', null, {});
    return {
      window: 'em memória desde o boot da API (reinicia zerando; nada persistido; rotas normalizadas sem ids)',
      items: perfSnapshot()
    };
  }
}
