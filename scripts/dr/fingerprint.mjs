/**
 * Impressão digital de um banco para o ensaio de DR (§25 da especificação-mãe: "backup não é
 * considerado funcional até que restore seja testado").
 *
 * O ensaio antigo conferia UMA linha-canário. Um restore que perde uma tabela inteira, uma
 * política de RLS, um gatilho de imutabilidade ou a sequência de um contador passava. Aqui a
 * origem e o restauro são comparados por:
 *   - linhas de TODAS as tabelas do esquema public, com RLS ligado/forçado;
 *   - contagem de índices, restrições, gatilhos, funções, políticas e sequências;
 *   - último valor de cada sequência;
 *   - MD5 do conteúdo das tabelas de evidência imutável e de auditoria (ordem estável).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/** SQL que devolve a impressão digital estrutural como uma linha JSON. */
export const FINGERPRINT_SQL = `
WITH t AS (
  SELECT c.relname AS tabela, c.relrowsecurity AS rls, c.relforcerowsecurity AS rls_forcado,
         (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::bigint AS linhas
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
)
SELECT json_build_object(
  'tabelas', (SELECT json_object_agg(tabela, json_build_array(linhas, rls, rls_forcado) ORDER BY tabela) FROM t),
  'objetos', json_build_object(
    'tabelas', (SELECT count(*) FROM t),
    'indices', (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'),
    'restricoes', (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public'),
    'gatilhos', (SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT g.tgisinternal),
    'funcoes', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
    'politicas', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
    'sequencias', (SELECT count(*) FROM pg_sequences WHERE schemaname = 'public')
  ),
  'sequencias', (SELECT coalesce(json_object_agg(sequencename, last_value ORDER BY sequencename), '{}'::json) FROM pg_sequences WHERE schemaname = 'public')
);`;

/** Nomes das tabelas de evidência imutável declaradas no catálogo do backend. */
export function evidenceTables(catalogSource) {
  const bloco = /ImmutableEvidenceTables\s*=\s*\[([\s\S]*?)\];/.exec(catalogSource);
  if (!bloco) throw new Error('ImmutableEvidenceTables não encontrada no catálogo');
  return [...bloco[1].matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]);
}

/**
 * SQL do MD5 de conteúdo das tabelas pedidas que EXISTEM no banco (uma linha JSON). A ordem é
 * pelo texto da linha, estável entre origem e restauro.
 */
export function checksumSql(tables) {
  const lista = tables.map((t) => `'${t.replace(/[^a-z_0-9]/g, '')}'`).join(',');
  return `
SELECT coalesce(json_object_agg(relname, h ORDER BY relname), '{}'::json) FROM (
  SELECT c.relname,
         (xpath('/row/h/text()', query_to_xml(format(
           'select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) as h from public.%I x', '|', '', c.relname),
           false, true, '')))[1]::text AS h
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND (c.relname IN (${lista}) OR c.relname LIKE '%audit%')
) s;`;
}

/** Diferenças entre duas impressões digitais (vazio = restauro fiel). */
export function compareFingerprints(origem, restauro) {
  const diffs = [];
  const chaves = (o) => Object.keys(o ?? {});
  for (const grupo of ['objetos', 'sequencias', 'tabelas', 'conteudo']) {
    const a = origem[grupo] ?? {};
    const b = restauro[grupo] ?? {};
    for (const k of new Set([...chaves(a), ...chaves(b)])) {
      const va = JSON.stringify(a[k]);
      const vb = JSON.stringify(b[k]);
      if (va !== vb) diffs.push(`${grupo}.${k}: origem ${va ?? 'ausente'} ≠ restauro ${vb ?? 'ausente'}`);
    }
  }
  return diffs;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Cifra o dump com AES-256-GCM. A chave é descartável (só existe na memória do ensaio) e o
 * manifesto guarda o que prova integridade: SHA-256 do claro e do cifrado, IV e tag.
 */
// Tag GCM de 16 bytes declarada nas duas pontas: sem `authTagLength` na decifragem, o Node aceitaria
// uma tag encurtada no manifesto — e tag curta é o caminho para forjar cifrado que "passa" na conferência.
const GCM_TAG = 16;

export async function encryptFile(plainPath, encPath, key = randomBytes(32)) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG });
  await pipeline(createReadStream(plainPath), cipher, createWriteStream(encPath));
  const manifest = {
    algoritmo: 'AES-256-GCM',
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    bytesClaro: statSync(plainPath).size,
    bytesCifrado: statSync(encPath).size,
    sha256Claro: await sha256File(plainPath),
    sha256Cifrado: await sha256File(encPath),
  };
  return { key, manifest };
}

/** Decifra e confere: tag GCM (adulteração) e SHA-256 do claro contra o manifesto. */
export async function decryptFile(encPath, outPath, key, manifest) {
  if ((await sha256File(encPath)) !== manifest.sha256Cifrado) throw new Error('backup cifrado adulterado: SHA-256 não confere');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.iv, 'hex'), { authTagLength: GCM_TAG });
  decipher.setAuthTag(Buffer.from(manifest.tag, 'hex'));
  await pipeline(createReadStream(encPath), decipher, createWriteStream(outPath));
  const sha = await sha256File(outPath);
  if (sha !== manifest.sha256Claro) throw new Error('backup decifrado diverge do original');
  return sha;
}

export function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
