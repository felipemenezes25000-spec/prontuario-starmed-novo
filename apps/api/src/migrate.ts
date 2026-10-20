/**
 * Versioned migration runner (P0-03 / ST-P0-004).
 *
 * Applies database/schema.sql then database/00*.sql in deterministic order,
 * recording version + sha256 checksum in schema_migrations. Fails closed on
 * checksum drift, on a non-empty database that was never registered, or on
 * anything it cannot prove safe.
 *
 * Usage (cwd may be repo root or apps/api):
 *   tsx src/migrate.ts             apply pending migrations
 *   tsx src/migrate.ts --dry-run   print the plan, change nothing
 *   tsx src/migrate.ts --adopt     register already-applied migrations WITHOUT
 *                                  executing them (one-time migration of a
 *                                  legacy database onto versioned tracking)
 *
 * NEVER point --adopt at a database whose real schema you have not verified.
 * Runs inside CI only with exclusively synthetic credentials.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';

config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Missing required environment variable: DATABASE_URL');

type Mode = 'apply' | 'dry-run' | 'adopt';
const mode: Mode = process.argv.includes('--adopt') ? 'adopt'
  : process.argv.includes('--dry-run') ? 'dry-run'
  : 'apply';

function findMigrationsDir(): string {
  const candidates = [
    resolve(process.cwd(), 'database'),
    resolve(process.cwd(), '../../database'),
    resolve(process.cwd(), '../database'),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, 'schema.sql')));
  if (!found) throw new Error('database/schema.sql not found from ' + process.cwd());
  return found;
}

type Migration = { version: string; file: string; sql: string; checksum: string };

function loadMigrations(): Migration[] {
  const dir = findMigrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const schema = files.find((f) => f === 'schema.sql');
  if (!schema) throw new Error('database/schema.sql is missing');
  const numbered = files.filter((f) => f !== 'schema.sql').sort((a, b) => a.localeCompare(b, 'en'));
  for (const f of numbered) if (!/^\d{3}_.+\.sql$/.test(f))
    throw new Error('Migration file does not follow NNN_name.sql: ' + f);
  const ordered = [schema, ...numbered];
  return ordered.map((f) => {
    const sql = readFileSync(join(dir, f), 'utf8');
    return {
      version: f === 'schema.sql' ? '001_schema' : f.replace(/\.sql$/, ''),
      file: f,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

async function main() {
  const migrations = loadMigrations();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['starmed_migrations']);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations(
         version TEXT PRIMARY KEY,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    const applied = new Map<string, string>();
    const rows = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations'
    );
    for (const row of rows.rows) applied.set(row.version, row.checksum);

    // Drift: a registered migration whose file changed after application.
    for (const m of migrations) {
      const seen = applied.get(m.version);
      if (seen && seen !== m.checksum)
        throw new Error(
          `Migration drift: ${m.file} changed after being applied ` +
          `(recorded ${seen.slice(0, 12)}…, file ${m.checksum.slice(0, 12)}…). ` +
          'Never edit an applied migration: add a new NNN_ file instead.'
        );
    }
    for (const version of applied.keys())
      if (!migrations.some((m) => m.version === version))
        throw new Error(
          `Migration drift: ${version} is recorded as applied but its file no longer exists.`
        );

    const pending = migrations.filter((m) => !applied.has(m.version));
    const usersExists = await client.query<{ present: string | null }>(
      "SELECT to_regclass('public.users')::text AS present"
    );

    if (mode === 'dry-run') {
      console.log('Plan (no changes made):');
      console.log('  applied: ' + (applied.size || 0));
      for (const m of pending) console.log('  pending: ' + m.file);
      if (!pending.length) console.log('  (database is up to date)');
      return;
    }

    if (mode === 'adopt') {
      if (!usersExists.rows[0].present)
        throw new Error('--adopt requires a database where the schema already exists');
      for (const m of migrations)
        if (!applied.has(m.version)) {
          await client.query(
            'INSERT INTO schema_migrations(version, checksum) VALUES($1,$2) ON CONFLICT (version) DO NOTHING',
            [m.version, m.checksum]
          );
          console.log('adopted (not executed): ' + m.file);
        }
      console.log('Adopted ' + pending.length + ' existing migration(s). Verify the schema manually.');
      return;
    }

    if (pending.length && applied.size === 0 && usersExists.rows[0].present)
      throw new Error(
        'Refusing to run creation migrations on a database that already has data but was ' +
        'never registered in schema_migrations. Verify the schema and register it once with ' +
        '--adopt (never against a production database without backup and review).'
      );

    for (const m of pending) {
      // Each .sql file manages its own BEGIN/COMMIT; a failure aborts before the
      // schema_migrations record is written, so the migration is retried next run.
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations(version, checksum) VALUES($1,$2)',
        [m.version, m.checksum]
      );
      console.log('applied: ' + m.file);
    }
    console.log(
      'Migrations OK — ' + applied.size + ' previously applied, ' + pending.length + ' applied now.'
    );
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['starmed_migrations']); }
    catch { /* connection already unusable */ }
    client.release();
    await pool.end();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
