import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from './config';
import { requestContext } from './context';

/**
 * Camada de acesso com contexto de tenant transacional (P0-05/ST-P0-005).
 *
 * Quando há requisição autenticada (contexto `orgId` publicado pelo JwtGuard,
 * `verifyPortalToken` ou `audit()`), CADA query roda numa transação curta com
 * `SET LOCAL starmed.org_id` — exatamente o que as policies de RLS leem. Sem
 * contexto (scripts, rotas públicas antes de resolver o tenant), a query roda
 * direto: as policies estritas de dado clínico NEGAM (fail-closed) e as policies
 * "tier2" de credencial/capabilidade permitem apenas o lookup por segredo.
 *
 * Em desenvolvimento local a URL costuma apontar para o dono superusuário (que
 * sempre contorna RLS); o CI roda a API como `starmed_app` (papel não-owner) e
 * é lá que o isolamento é provado — ver database/018_rls_app_role.sql.
 *
 * Nota de desempenho: são +2 round-trips por query autenticada (BEGIN/COMMIT
 * com SET LOCAL). Evolução: conexão/gestor por requisição. Não troque por
 * `SET` de sessão sem reset — a pool é compartilhada.
 */
@Injectable()
export class Db implements OnModuleDestroy {
  private readonly pool = new Pool({ connectionString: env('DATABASE_URL'), max: 12, ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
  async query<T extends QueryResultRow = any>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    const orgId = requestContext.getStore()?.orgId;
    if (!orgId) return this.pool.query<T>(sql, values);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('starmed.org_id',$1,true)`, [orgId]);
      const result = await client.query<T>(sql, values);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const orgId = requestContext.getStore()?.orgId;
      if (orgId) await client.query(`SELECT set_config('starmed.org_id',$1,true)`, [orgId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async onModuleDestroy() { await this.pool.end(); }
}
