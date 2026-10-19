import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS, RBAC_MATRIX, parsePatientCsv, validateRbacMatrix } from './product';

test('parsePatientCsv: aceita 3 linhas válidas com aspas', () => {
  const csv = [
    'external_id,full_name,birth_date,administrative_gender,phone',
    'P001,Maria da Silva,1990-05-12,female,"(11) 99999-0001"',
    'P002,João Souza,1985-02-28,male,',
    'P003,"Souza, Ana Maria",2001-12-31,other,'
  ].join('\n');
  const out = parsePatientCsv(csv);
  assert.equal(out.total, 3);
  assert.equal(out.valid.length, 3);
  assert.equal(out.invalid.length, 0);
  assert.equal(out.valid[2].fullName, 'Souza, Ana Maria', 'vírgula dentro de aspas preservada');
});

test('parsePatientCsv: rejeita data no formato brasileiro e gênero inválido', () => {
  const csv = [
    'external_id,full_name,birth_date,administrative_gender',
    'P010,Maria,31/12/1990,female',
    'P011,João,1990-01-01,x'
  ].join('\n');
  const out = parsePatientCsv(csv);
  assert.equal(out.valid.length, 0);
  assert.equal(out.invalid.length, 2);
  assert.match(out.invalid[0].reason, /YYYY-MM-DD/);
  assert.match(out.invalid[1].reason, /administrative_gender/);
});

test('parsePatientCsv: detecta duplicatas e header errado', () => {
  const dup = [
    'external_id,full_name,birth_date,administrative_gender',
    'P1,Maria,1990-05-12,female',
    'P1,Outra Maria,1991-06-13,female'
  ].join('\n');
  const out = parsePatientCsv(dup);
  assert.equal(out.valid.length, 1);
  assert.match(out.invalid[0].reason, /duplicado/);
  const bad = 'nome,errado\nX,Y';
  const out2 = parsePatientCsv(bad);
  assert.match(out2.invalid[0].reason, /coluna obrigatória ausente/);
});

test('parsePatientCsv: data fora de faixa (nascimento no futuro) rejeitada', () => {
  const csv = [
    'external_id,full_name,birth_date,administrative_gender',
    'P99,Bebê,2999-01-01,female'
  ].join('\n');
  const out = parsePatientCsv(csv);
  assert.equal(out.valid.length, 0);
  assert.match(out.invalid[0].reason, /faixa/);
});

test('RBAC: toda permissão coberta por ≥1 role e todo role com ≥1 permissão', () => {
  const result = validateRbacMatrix(RBAC_MATRIX as unknown as Record<string, (typeof PERMISSIONS)[number][]>);
  assert.deepEqual(result.missingPermissions, []);
  assert.deepEqual(result.emptyRoles, []);
});

test('RBAC: matriz incompleta é detectada', () => {
  const broken = { admin: ['settings.manage' as const], doctor: [], nurse: [], reception: [] };
  const result = validateRbacMatrix(broken);
  assert.ok(result.missingPermissions.length > 0);
  assert.deepEqual(result.emptyRoles, ['doctor', 'nurse', 'reception']);
});
