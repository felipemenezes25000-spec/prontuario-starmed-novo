import type { QueryRunner } from './security';

/**
 * Rate limit distribuído (P0-07) — store em PostgreSQL (janela fixa por bucket).
 * Substitui o contador em memória nas rotas de autenticação: vale para todas as
 * instâncias que compartilham o banco, sem dependência nova e sem segredo.
 *
 * Falha do store: degradar para SEM limite (fail-open) e registrar o motivo —
 * se o banco estiver inacessível, o próprio login já está indisponível; o
 * limitador não deve ser a peça que derruba o restante. Log sem PHI (só mensagem).
 */

export type RateDecision = { allowed: boolean; remaining: number; retryAfterSec: number };

export class PgRateLimitStore {
  constructor(private readonly db: QueryRunner) {}

  async hit(bucket: string, limit: number, windowMs: number): Promise<RateDecision> {
    const windowSec = Math.max(1, Math.floor(windowMs / 1000));
    const windowStart = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
    const result = await this.db.query(
      `INSERT INTO rate_limits(bucket, window_start, hits) VALUES ($1, to_timestamp($2::double precision), 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limits.hits + 1
       RETURNING hits`,
      [bucket, windowStart]);
    const hits = Number(result.rows?.[0]?.hits ?? 1);
    const windowEndsAt = (windowStart + windowSec) * 1000;
    const retryAfterSec = Math.max(1, Math.ceil((windowEndsAt - Date.now()) / 1000));
    return { allowed: hits <= limit, remaining: Math.max(0, limit - hits), retryAfterSec };
  }
}

type MiddlewareReq = { ip?: string };
type MiddlewareRes = {
  setHeader(name: string, value: string | number): unknown;
  status(code: number): { json(body: unknown): unknown };
};

export function rateLimitMiddleware(
  store: PgRateLimitStore,
  name: string,
  limit: number,
  windowMs: number,
  message: string
) {
  return async (req: MiddlewareReq, res: MiddlewareRes, next: (err?: unknown) => void): Promise<void> => {
    try {
      const decision = await store.hit(`${name}:${req.ip || 'unknown'}`, limit, windowMs);
      res.setHeader('RateLimit-Limit', limit);
      res.setHeader('RateLimit-Remaining', decision.remaining);
      res.setHeader('RateLimit-Reset', decision.retryAfterSec);
      if (!decision.allowed) {
        res.setHeader('Retry-After', decision.retryAfterSec);
        res.status(429).json({ message });
        return;
      }
      next();
    } catch (error) {
      // Fail-open documentado: store indisponível não pode ser o que derruba o
      // fluxo de autenticação (sem PHI no log).
      console.error('rate-limit store indisponível (fail-open):', error instanceof Error ? error.message : 'erro');
      next();
    }
  };
}
