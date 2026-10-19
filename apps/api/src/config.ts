import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

export function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error('Missing required environment variable: ' + key);
  return value;
}
export function assertSecurityConfig() {
  const secret = env('AUTH_SECRET');
  if (secret.length < 32 || secret.startsWith('REPLACE_'))
    throw new Error('AUTH_SECRET must be a generated secret of at least 32 characters');
  env('DATABASE_URL'); env('AUTH_ISSUER'); env('AUTH_AUDIENCE');
}
