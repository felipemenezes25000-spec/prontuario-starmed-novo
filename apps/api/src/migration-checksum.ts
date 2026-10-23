import { createHash } from 'node:crypto';

/** Checksum independente do fim de linha: o Git no Windows (core.autocrlf) grava
 *  CRLF na cópia de trabalho e o mesmo arquivo acusava "drift". O hash dos BYTES
 *  CRUS (formato antigo) continua aceito, para bancos registrados antes. */
export function migrationChecksums(sql: string): { checksum: string; legacyChecksums: string[] } {
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  const lf = sql.replace(/\r\n/g, '\n');
  return { checksum: sha(lf), legacyChecksums: [sha(sql), sha(lf.replace(/\n/g, '\r\n'))] };
}
