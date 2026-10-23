import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { migrationChecksums } from './migration-checksum';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

test('checksum de migração não depende do fim de linha (LF × CRLF)', () => {
  const lf = 'BEGIN;\nSELECT 1;\nCOMMIT;\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.equal(migrationChecksums(lf).checksum, migrationChecksums(crlf).checksum);
});

test('hashes gravados no formato antigo (bytes crus LF ou CRLF) continuam aceitos', () => {
  const lf = 'BEGIN;\nSELECT 1;\nCOMMIT;\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  for (const file of [lf, crlf]) {
    const c = migrationChecksums(file);
    assert.ok([c.checksum, ...c.legacyChecksums].includes(sha(lf)));
    assert.ok([c.checksum, ...c.legacyChecksums].includes(sha(crlf)));
  }
});

test('conteúdo realmente alterado continua sendo drift', () => {
  const c = migrationChecksums('BEGIN;\nSELECT 2;\nCOMMIT;\n');
  assert.ok(![c.checksum, ...c.legacyChecksums].includes(sha('BEGIN;\nSELECT 1;\nCOMMIT;\n')));
});
