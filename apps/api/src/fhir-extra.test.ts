/** Testes puros do FhirExtraController: sem banco, sem rede, sem Nest runtime. */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import {
  buildCapabilityStatement,
  buildSearchSetBundle,
  buildSmartConfiguration,
  parseCount,
  parseDateRange,
  parsePatientParam,
  DEFAULT_COUNT,
  MAX_COUNT,
} from './fhir-extra';

test('buildSearchSetBundle monta Bundle searchset com links self e first', () => {
  const url = '/fhir/R4/Patient?name=Maria&_count=20';
  const bundle = buildSearchSetBundle([{ resourceType: 'Patient', id: 'abc-123' }], 42, url);

  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.type, 'searchset');
  assert.equal(bundle.total, 42);

  const self = bundle.link.find((l) => l.relation === 'self');
  const first = bundle.link.find((l) => l.relation === 'first');
  assert.ok(self, 'link self ausente');
  assert.equal(self.url, url);
  assert.ok(first, 'link first ausente');
  assert.ok(first.url.startsWith('/fhir/R4/Patient?'));

  assert.equal(bundle.entry.length, 1);
  assert.equal((bundle.entry[0].resource as { id: string }).id, 'abc-123');
  assert.equal(bundle.entry[0].fullUrl, 'urn:uuid:abc-123');
  assert.equal(bundle.entry[0].search.mode, 'match');
});

test('buildSearchSetBundle: bundle vazio e link first zera o _offset', () => {
  const url = '/fhir/R4/Condition?patient=x&_count=10&_offset=30';
  const bundle = buildSearchSetBundle([], 0, url);

  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.type, 'searchset');
  assert.equal(bundle.total, 0);
  assert.equal(bundle.entry.length, 0);

  const first = bundle.link.find((l) => l.relation === 'first');
  assert.ok(first, 'link first ausente');
  assert.ok(first.url.includes('_offset=0'), `first deveria zerar _offset: ${first.url}`);
  assert.ok(!first.url.includes('_offset=30'));
});

test('parsePatientParam valida uuid com parse() e lança BadRequestException', () => {
  const valid = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(parsePatientParam(valid), valid);

  assert.throws(() => parsePatientParam('nao-e-uuid'), (e) => e instanceof BadRequestException);
  assert.throws(() => parsePatientParam('123e4567-e89b-42d3-g456-426614174000'), (e) => e instanceof BadRequestException);
  assert.throws(() => parsePatientParam('123e4567-e89b-42d3-a456-42661417400'), (e) => e instanceof BadRequestException);
  assert.throws(() => parsePatientParam(undefined), (e) => e instanceof BadRequestException);
  assert.throws(() => parsePatientParam(''), (e) => e instanceof BadRequestException);
});

test('parseCount: default 20 e cap 50; offset e date também validados', () => {
  assert.equal(parseCount(undefined), DEFAULT_COUNT);
  assert.equal(parseCount(''), DEFAULT_COUNT);
  assert.equal(parseCount('5'), 5);
  assert.equal(parseCount('500'), MAX_COUNT);
  assert.throws(() => parseCount('abc'), (e) => e instanceof BadRequestException);
  assert.throws(() => parseCount('0'), (e) => e instanceof BadRequestException);

  const range = parseDateRange('2024-03');
  assert.ok(range);
  assert.ok(range.start.startsWith('2024-03-01'));
  assert.ok(range.end.startsWith('2024-04-01'));
  assert.equal(parseDateRange(undefined), null);
  assert.throws(() => parseDateRange('2024-13-45'), (e) => e instanceof BadRequestException);
});

test('CapabilityStatement R4 mínimo válido com os resources esperados', () => {
  const cs = buildCapabilityStatement(new Date('2024-06-01T10:00:00.000Z'));

  assert.equal(cs.resourceType, 'CapabilityStatement');
  assert.equal(cs.status, 'active');
  assert.equal(cs.kind, 'instance');
  assert.equal(cs.fhirVersion, '4.0.1');
  assert.deepEqual(cs.format, ['json']);
  assert.equal(cs.date, '2024-06-01T10:00:00.000Z');

  assert.equal(cs.rest.length, 1);
  const rest = cs.rest[0];
  assert.equal(rest.mode, 'server');

  const types = rest.resource.map((r) => r.type);
  for (const expected of [
    'Patient', 'Condition', 'AllergyIntolerance', 'Observation',
    'MedicationRequest', 'DiagnosticReport', 'DocumentReference',
  ]) {
    assert.ok(types.includes(expected), `resource ${expected} ausente do CapabilityStatement`);
  }

  const patient = rest.resource.find((r) => r.type === 'Patient');
  assert.ok(patient);
  assert.deepEqual(patient.interaction.map((i) => i.code), ['read', 'search-type']);
  assert.deepEqual(patient.searchParam.map((p) => p.name), ['name', 'birthdate']);

  const condition = rest.resource.find((r) => r.type === 'Condition');
  assert.ok(condition);
  assert.deepEqual(condition.searchParam.map((p) => p.name), ['patient', 'code']);

  const observation = rest.resource.find((r) => r.type === 'Observation');
  assert.ok(observation);
  assert.deepEqual(observation.searchParam.map((p) => p.name), ['patient', 'category', 'date']);
});

test('smart-configuration expõe endpoints, capability e scopes', () => {
  const cfg = buildSmartConfiguration({});

  assert.equal(cfg.authorization_endpoint, 'http://localhost:3001/auth/sso/start');
  assert.equal(cfg.token_endpoint, 'http://localhost:3001/auth/login');
  // HONESTIDADE (Fase 6): sem authorization server NÃO há capability SMART nem
  // scopes concedidos — discovery informa endpoints, não promete permissões.
  assert.deepEqual(cfg.capability, []);
  assert.deepEqual(cfg.scopes_supported, []);

  const custom = buildSmartConfiguration({
    SMART_AUTH_URL: 'https://id.example/auth',
    SMART_TOKEN_URL: 'https://id.example/token',
  });
  assert.equal(custom.authorization_endpoint, 'https://id.example/auth');
  assert.equal(custom.token_endpoint, 'https://id.example/token');
});
