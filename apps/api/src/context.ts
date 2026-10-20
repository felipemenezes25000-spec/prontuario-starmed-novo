import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto por requisição (P0-05/C5) — módulo sem dependências internas, para
 * que `security.ts` e `db.ts` possam importá-lo SEM criar ciclo de import
 * (o emitDecoratorMetadata do NestJS mantém a referência de classe em runtime,
 * então um ciclo db↔security derruba a injeção do JwtGuard).
 *
 * `requestId`: gerado no middleware (main.ts) e anexado a cada evento de
 * auditoria — correlaciona logs, respostas e trilha.
 * `orgId`: contexto de tenant — publicado pelo JwtGuard, pela sessão do portal
 * ou por fluxos pré-autenticação que resolvem o tenant a partir de um segredo
 * (convite, código de verificação ITI); o Db transforma isso em
 * `SET LOCAL starmed.org_id` para as policies de RLS.
 */
export const requestContext = new AsyncLocalStorage<{ requestId: string; orgId?: string }>();

/**
 * Publica o contexto de tenant da requisição atual. Primeiro valor vence (o
 * contexto da sessão autenticada manda).
 */
export function setOrgContext(orgId: string | null | undefined): void {
  const store = requestContext.getStore();
  if (store && !store.orgId && orgId) store.orgId = orgId;
}
