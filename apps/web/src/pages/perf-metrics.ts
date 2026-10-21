/**
 * Telemetria de UX SEM PHI (ST-P1-012) — eventos FECHADOS dos5 indicadores
 * nomeados: abrir prontuário (open_record), concluir evolução (sign_note),
 * emitir prescrição (create_prescription), recuperar histórico (load_history),
 * identificar/registrar alergia (check_allergy).
 *
 * Envia {event, durationMs, ok} para POST /metrics/ui (enum rígido no servidor).
 * SEM id de paciente/usuário, sem texto clínico — só duração e sucesso, o que
 * habilita p50/p95 e a taxa de erro/abandono (ok=false) sem associabilidade.
 * Fire-and-forget com timeout3s: telemetria NUNCA quebra nem atrasa a UI.
 */
export type PerfEvent = 'open_record' | 'sign_note' | 'create_prescription' | 'load_history' | 'check_allergy';

const apiBase = (import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '');

export function trackEvent(token: string | null, event: PerfEvent, durationMs: number, ok: boolean): void {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    void fetch(apiBase + '/metrics/ui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ event, durationMs: Math.max(0, Math.round(durationMs)), ok }),
      signal: ctrl.signal,
      keepalive: true
    }).then(
      () => undefined,
      () => undefined
    ).finally(() => clearTimeout(timer));
  } catch { /* silêncio por design */ }
}

/** Mede a ação do usuário e registra sucesso/falha; ERROS são re-lançados
 *  intactos (a UX continua tratando o erro como antes). */
export async function measureEvent<T>(token: string | null, event: PerfEvent, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await fn();
    trackEvent(token, event, performance.now() - t0, true);
    return result;
  } catch (e) {
    trackEvent(token, event, performance.now() - t0, false);
    throw e;
  }
}
