/**
 * WEB_ORIGIN aceita UMA ou VÁRIAS origens separadas por vírgula
 * (ex.: local "http://localhost:5173,http://127.0.0.1:5173").
 *  - webOrigins(): lista exata liberada no CORS (nunca curinga);
 *  - primaryWebOrigin(): a 1ª, usada para montar links (verificação pública, SSO).
 */
const DEFAULT_ORIGIN = 'http://localhost:5173';

export function webOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const list = String(env.WEB_ORIGIN || DEFAULT_ORIGIN).split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (list.some(o => o === '*')) throw new Error('WEB_ORIGIN não aceita curinga "*": liste as origens exatas');
  return list.length ? list : [DEFAULT_ORIGIN];
}

export function primaryWebOrigin(env: Record<string, string | undefined> = process.env): string {
  return webOrigins(env)[0];
}
