#!/usr/bin/env node
/**
 * Provisiona a CREDENCIAL de login do papel de aplicação `starmed_app`
 * (criado pela migração database/018_rls_app_role.sql).
 *
 * Uso (CI ou provisionamento de ambiente — a conexão precisa ser de dono/admin):
 *   DATABASE_URL=postgres://... \
 *   STARMED_APP_ROLE_PASSWORD='<senha sintética exclusiva do ambiente>' \
 *   node scripts/db/setup-app-role.mjs
 *
 * A senha NUNCA vem do repositório: só de variável de ambiente, com charset
 * restrito (não há interpolação de SQL arbitrário). Depois disso, a API deve
 * conectar como starmed_app (não-owner) — é o que o CI faz no job `api`.
 */
import { Client } from 'pg';

const url = process.env.DATABASE_URL;
const password = process.env.STARMED_APP_ROLE_PASSWORD;
if (!url) throw new Error('DATABASE_URL obrigatória (conexão de dono/administrador)');
if (!password || !/^[A-Za-z0-9_-]{8,64}$/.test(password))
  throw new Error('STARMED_APP_ROLE_PASSWORD inválida: use 8..64 caracteres de [A-Za-z0-9_-]');

const client = new Client({ connectionString: url });
await client.connect();
try {
  const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'starmed_app'");
  if (!role.rowCount)
    throw new Error('Papel starmed_app inexistente: aplique database/018_rls_app_role.sql (npm run migrate) antes deste script');
  await client.query(`ALTER ROLE starmed_app WITH LOGIN PASSWORD '${password}'`);
  console.log('Papel starmed_app provisionado com credencial de login (não-owner, sem BYPASSRLS).');
} finally {
  await client.end();
}
