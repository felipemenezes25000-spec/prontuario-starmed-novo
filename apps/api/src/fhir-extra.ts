/**
 * FhirExtraController — complementa o FhirController (controllers.ts), que já serve
 * GET /fhir/R4/:resource/:id (read). Aqui ficam CapabilityStatement, SMART discovery
 * e buscas FHIR em Bundle searchset:
 *
 *   GET /fhir/R4/metadata                          — CapabilityStatement R4 (@Public)
 *   GET /fhir/R4/.well-known/smart-configuration   — config SMART (@Public)
 *   GET /.well-known/smart-configuration           — config SMART na raiz do servidor (@Public)
 *   GET /fhir/R4/Patient?name=&birthdate=&identifier=<system CPF|CNS da RNDS>|<valor>
 *   GET /fhir/R4/Condition?patient=&code=
 *   GET /fhir/R4/AllergyIntolerance?patient=
 *   GET /fhir/R4/Observation?patient=&category=&date=
 *   GET /fhir/R4/MedicationRequest?patient=&status=
 *   GET /fhir/R4/DiagnosticReport?patient=&date=
 *   GET /fhir/R4/DocumentReference?patient=&type=&date=
 *
 * Sem migração: usa apenas tabelas já existentes — patients, patient_conditions,
 * patient_allergies, prescriptions+encounters, clinical_notes+encounters e
 * clinical_documents (as duas primeiras são as mesmas que o FhirController já lê).
 *
 * DECISÃO (documentada): database/schema.sql não possui tabela de vitals
 * (ex.: clinical_history), logo Observation?patient=&category=vital-signs responde
 * um Bundle searchset vazio com total: 0, sem inventar fonte de dados.
 */
import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import { FHIR_SYSTEM_CNS, FHIR_SYSTEM_CPF, fhirPatientIdentifiers, isValidCns, isValidCpf } from './br-identifiers';
import { Db } from './db';
import { toFhirAllergy, toFhirCondition, type AllergyRow, type ConditionRow } from './fhir-mappers';
import { Actor, Public, audit, requireRole } from './security';
import { parse, uuid } from './domain';

type R = { actor: Actor };
type QueryParams = Record<string, unknown>;

export const DEFAULT_COUNT = 20;
export const MAX_COUNT = 50;

const str = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

const iso = (v: unknown): string | undefined => {
  if (!v) return undefined;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};
const dateOnly = (v: unknown): string | undefined => iso(v)?.slice(0, 10);

// ---------------------------------------------------------------------------
// Helpers puros (testados sem banco/rede)
// ---------------------------------------------------------------------------

/** _count: default 20, cap 50. */
export function parseCount(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_COUNT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException('_count deve ser um inteiro >= 1');
  return Math.min(n, MAX_COUNT);
}

/** _offset: default 0 (usado apenas no link "first"). */
export function parseOffset(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new BadRequestException('_offset deve ser um inteiro >= 0');
  return n;
}

/** Valida o parâmetro patient= como uuid (parse do domain lança BadRequestException). */
export function parsePatientParam(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') {
    throw new BadRequestException('Parâmetro patient (uuid) é obrigatório');
  }
  return parse(uuid, String(raw));
}

const DATE_RANGE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** date= aceita YYYY, YYYY-MM ou YYYY-MM-DD e devolve intervalo [start, end) em UTC. */
export function parseDateRange(raw: unknown): { start: string; end: string } | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw);
  if (!DATE_RANGE_RE.test(s)) {
    throw new BadRequestException('Parâmetro date inválido (use YYYY, YYYY-MM ou YYYY-MM-DD)');
  }
  const start = s.length === 4 ? `${s}-01-01` : s.length === 7 ? `${s}-01` : s;
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  if (Number.isNaN(startMs)) {
    throw new BadRequestException('Parâmetro date inválido (use YYYY, YYYY-MM ou YYYY-MM-DD)');
  }
  let end: string;
  if (s.length === 4) end = `${Number(s) + 1}-01-01`;
  else if (s.length === 7) {
    const [y, m] = s.split('-').map(Number);
    end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  } else {
    end = new Date(startMs + 86400000).toISOString().slice(0, 10);
  }
  return { start: `${start}T00:00:00.000Z`, end: `${end}T00:00:00.000Z` };
}

/** Token param: "system|code" -> "code"; vazio -> null. */
const tokenValue = (raw: unknown): string | null => {
  const s = str(raw)?.trim();
  if (!s) return null;
  return s.includes('|') ? s.slice(s.indexOf('|') + 1).trim() || null : s;
};

function firstPageUrl(url: string): string {
  const [base, query] = url.split('?');
  if (!query) return url;
  const params = new URLSearchParams(query);
  params.set('_offset', '0');
  return `${base}?${params.toString()}`;
}

/** Bundle searchset com links self/first e uma entrada por recurso. */
export function buildSearchSetBundle(resources: unknown[], total: number, url: string) {
  return {
    resourceType: 'Bundle' as const,
    type: 'searchset' as const,
    total,
    link: [
      { relation: 'self', url },
      { relation: 'first', url: firstPageUrl(url) },
    ],
    entry: resources.map((resource) => {
      const r = resource as { resourceType?: string; id?: string } | null;
      return {
        ...(r && r.resourceType && r.id ? { fullUrl: `urn:uuid:${r.id}` } : {}),
        resource,
        search: { mode: 'match' as const },
      };
    }),
  };
}

export type SearchParamDef = { name: string; type: string };
export const CAPABILITY_RESOURCES: { type: string; searchParam: SearchParamDef[] }[] = [
  { type: 'Patient', searchParam: [{ name: 'name', type: 'string' }, { name: 'birthdate', type: 'date' }, { name: 'identifier', type: 'token' }] },
  { type: 'Condition', searchParam: [{ name: 'patient', type: 'reference' }, { name: 'code', type: 'token' }] },
  { type: 'AllergyIntolerance', searchParam: [{ name: 'patient', type: 'reference' }] },
  { type: 'Observation', searchParam: [{ name: 'patient', type: 'reference' }, { name: 'category', type: 'token' }, { name: 'date', type: 'date' }] },
  { type: 'MedicationRequest', searchParam: [{ name: 'patient', type: 'reference' }, { name: 'status', type: 'token' }] },
  { type: 'DiagnosticReport', searchParam: [{ name: 'patient', type: 'reference' }, { name: 'date', type: 'date' }] },
  { type: 'DocumentReference', searchParam: [{ name: 'patient', type: 'reference' }, { name: 'type', type: 'token' }, { name: 'date', type: 'date' }] },
];

/** CapabilityStatement R4 mínimo válido (kind: instance, fhirVersion 4.0.1).
 *  HONESTO (Fase 6): declara somente interações de LEITURA (read + search-type)
 *  e NÃO anuncia security/SMART de autorização — não há authorization server
 *  neste servidor; a discovery SMART fica em /.well-known/smart-configuration
 *  com scopes_supported vazio. */
export function buildCapabilityStatement(now: Date = new Date()) {
  return {
    resourceType: 'CapabilityStatement' as const,
    status: 'active' as const,
    date: now.toISOString(),
    kind: 'instance' as const,
    fhirVersion: '4.0.1',
    format: ['json'],
    // invariantes cpb-2/cpb-14 do validador oficial (Fase 6): kind=instance
    // EXIGE `implementation`, e o recurso exige description|software|implementation.
    implementation: { description: 'StarMed EHR — prontuário eletrônico (instância de demonstração/homologação; não apto a uso clínico real)' },
    rest: [{
      mode: 'server' as const,
      resource: CAPABILITY_RESOURCES.map((r) => ({
        type: r.type,
        interaction: [{ code: 'read' as const }, { code: 'search-type' as const }],
        searchParam: r.searchParam,
      })),
    }],
  };
}

/**
 * SMART discovery (/.well-known/smart-configuration) — mantida como endpoint
 * de DESCoberta, mas HONESTA (decisão nomeada Fase 6): este servidor NÃO tem
 * authorization server. Sem AS nenhum scope é concedido hoje, então
 * `scopes_supported` e `capability` saem VAZIOS — anunciar 'patient/*.read'
 * ou 'launch-standalone' seria prometer concessão que não existe. Os valores
 * entram aqui QUANDO houver um AS real apontado por SMART_AUTH_URL/SMART_TOKEN_URL.
 */
export function buildSmartConfiguration(source: Record<string, string | undefined> = process.env) {
  return {
    authorization_endpoint: source.SMART_AUTH_URL || 'http://localhost:3001/auth/sso/start',
    token_endpoint: source.SMART_TOKEN_URL || 'http://localhost:3001/auth/login',
    capability: [] as string[],
    scopes_supported: [] as string[],
  };
}

function selfUrl(path: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
  const q = qs.toString();
  return q ? `${path}?${q}` : path;
}

// ---------------------------------------------------------------------------
// Mapeadores FHIR locais (os de fhir-mappers.ts cobrem Condition/Allergy)
// ---------------------------------------------------------------------------

export function toFhirPatient(p: any) {
  return {
    resourceType: 'Patient' as const,
    id: p.id,
    identifier: fhirPatientIdentifiers(p),
    active: true,
    name: [{ use: 'official' as const, text: p.full_name }],
    gender: p.administrative_gender ?? 'unknown',
    birthDate: dateOnly(p.birth_date),
  };
}

/** prescriptions.status ('draft'|'cancelled'|'signed') <-> MedicationRequest.status (FHIR). */
const MEDICATION_STATUS_TO_FHIR: Record<string, string> = {
  signed: 'active', draft: 'draft', cancelled: 'cancelled',
};
const MEDICATION_STATUS_TO_DB: Record<string, string> = {
  active: 'signed', draft: 'draft', cancelled: 'cancelled',
};

function toFhirMedicationRequest(r: any) {
  const authoredOn = iso(r.created_on ?? r.created_at);
  const dosage = [r.dose, r.frequency].filter(Boolean).join(' — ');
  return {
    resourceType: 'MedicationRequest' as const,
    id: r.id,
    status: MEDICATION_STATUS_TO_FHIR[r.status] ?? 'unknown',
    intent: 'order' as const,
    medicationCodeableConcept: {
      text: r.medication_name,
      ...(r.medication_code ? { coding: [{ system: 'urn:starmed:medication-code', code: r.medication_code }] } : {}),
    },
    subject: { reference: 'Patient/' + r.patient_id },
    requester: { reference: 'Practitioner/' + r.prescriber_id },
    ...(authoredOn ? { authoredOn } : {}),
    ...(dosage ? { dosageInstruction: [{ text: dosage }] } : {}),
  };
}

function toFhirDiagnosticReport(n: any) {
  const sections = n.content && typeof n.content === 'object' ? n.content.sections : undefined;
  const assessment = sections && typeof sections.assessment === 'string' ? sections.assessment.trim() : '';
  const effective = iso(n.signed_at) ?? iso(n.updated_at);
  return {
    resourceType: 'DiagnosticReport' as const,
    id: n.id,
    status: 'final' as const,
    category: [{ text: 'Clinical note' }],
    code: { text: `Nota clínica assinada (${n.template_id})` },
    subject: { reference: 'Patient/' + n.patient_id },
    ...(effective ? { effectiveDateTime: effective, issued: effective } : {}),
    ...(n.signed_by ? { performer: [{ reference: 'Practitioner/' + n.signed_by }] } : {}),
    ...(assessment ? { conclusion: assessment.slice(0, 8000) } : {}),
  };
}

function toFhirDocumentReference(d: any) {
  const created = iso(d.created_at);
  return {
    resourceType: 'DocumentReference' as const,
    id: d.id,
    status: 'current' as const,
    docStatus: 'final' as const,
    type: {
      coding: [{ system: 'urn:starmed:doc-type', code: d.doc_type }],
      text: d.doc_type,
    },
    subject: { reference: 'Patient/' + d.patient_id },
    ...(created ? { date: created } : {}),
    author: [{ reference: 'Practitioner/' + d.created_by }],
    content: [{
      attachment: {
        contentType: d.mime_type,
        ...(d.sha256 ? { hash: Buffer.from(String(d.sha256), 'hex').toString('base64') } : {}),
        title: d.doc_type,
        url: 'urn:starmed:storage:' + d.storage_key,
      },
    }],
  };
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

const FHIR_PATH = '/fhir/R4';
const CLINICAL_ROLES: Actor['role'][] = ['doctor', 'nurse'];
const PATIENT_ROLES: Actor['role'][] = ['admin', 'doctor', 'nurse', 'reception'];

@Controller('fhir/R4')
export class FhirExtraController {
  constructor(private readonly db: Db) {}

  @Public()
  @Get('metadata')
  metadata() {
    return buildCapabilityStatement();
  }

  @Public()
  @Get('.well-known/smart-configuration')
  smartConfiguration() {
    return buildSmartConfiguration();
  }

  @Get('Patient')
  async searchPatient(@Req() req: R, @Query() q: QueryParams = {}) {
    const actor = req.actor;
    requireRole(actor, PATIENT_ROLES);
    const limit = parseCount(q._count);
    const skip = parseOffset(q._offset);
    const values: unknown[] = [actor.org_id];
    const where: string[] = ['org_id = $1'];

    const pattern = str(q.name)?.trim().slice(0, 120) ?? '';
    if (pattern) {
      values.push('%' + pattern.replace(/[\\%_]/g, '\\$&') + '%');
      where.push(`full_name ILIKE $${values.length}`);
    }
    const birthdate = str(q.birthdate);
    if (birthdate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
        throw new BadRequestException('birthdate deve ser YYYY-MM-DD');
      }
      values.push(birthdate);
      where.push(`birth_date = $${values.length}`);
    }
    // identifier=<system>|<valor> (token FHIR): só CPF/CNS da RNDS. Sistema
    // desconhecido ou DV inválido -> 400 (nunca um "0 resultados" enganoso).
    const identifier = str(q.identifier);
    if (identifier) {
      const bar = identifier.indexOf('|');
      const system = bar >= 0 ? identifier.slice(0, bar) : '';
      const value = (bar >= 0 ? identifier.slice(bar + 1) : identifier).replace(/\D/g, '');
      const column = system === FHIR_SYSTEM_CPF ? 'cpf' : system === FHIR_SYSTEM_CNS ? 'cns' : null;
      if (!column) throw new BadRequestException('identifier exige o system de CPF ou CNS da RNDS');
      if (!(column === 'cpf' ? isValidCpf(value) : isValidCns(value))) {
        throw new BadRequestException('identifier com dígito verificador inválido');
      }
      values.push(value);
      where.push(`${column} = $${values.length}`);
    }
    values.push(limit, skip);
    const r = await this.db.query<any>(
      `SELECT id, full_name, birth_date, administrative_gender, external_id, cpf, cns, count(*) OVER() AS total
         FROM patients WHERE ${where.join(' AND ')} ORDER BY full_name
        LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    const resources = r.rows.map(toFhirPatient);
    const total = Number(r.rows[0]?.total ?? 0);
    await audit(this.db, actor, 'fhir.search', 'Patient', null, { count: total });
    return buildSearchSetBundle(resources, total, selfUrl(`${FHIR_PATH}/Patient`, {
      name: pattern || undefined, birthdate, identifier,
      _count: String(limit), _offset: skip ? String(skip) : undefined,
    }));
  }

  @Get('Condition')
  async searchCondition(@Req() req: R, @Query() q: QueryParams = {}) {
    const actor = req.actor;
    requireRole(actor, CLINICAL_ROLES);
    const patientId = parsePatientParam(q.patient);
    const limit = parseCount(q._count);
    const skip = parseOffset(q._offset);
    const values: unknown[] = [actor.org_id, patientId];
    const where: string[] = ['org_id = $1', 'patient_id = $2'];
    const code = tokenValue(q.code);
    if (code) { values.push(code); where.push(`code = $${values.length}`); }
    values.push(limit, skip);
    const r = await this.db.query<any>(
      `SELECT *, count(*) OVER() AS total FROM patient_conditions
        WHERE ${where.join(' AND ')} ORDER BY recorded_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    const resources = r.rows.map(toFhirCondition);
    const total = Number(r.rows[0]?.total ?? 0);
    await audit(this.db, actor, 'fhir.search', 'Condition', patientId, { count: total });
    return buildSearchSetBundle(resources, total, selfUrl(`${FHIR_PATH}/Condition`, {
      patient: patientId, code: str(q.code),
      _count: String(limit), _offset: skip ? String(skip) : undefined,
    }));
  }

  @Get('AllergyIntolerance')
  async searchAllergy(@Req() req: R, @Query() q: QueryParams = {}) {
    const actor = req.actor;
    requireRole(actor, CLINICAL_ROLES);
    const patientId = parsePatientParam(q.patient);
    const limit = parseCount(q._count);
    const skip = parseOffset(q._offset);
    const values: unknown[] = [actor.org_id, patientId, limit, skip];
    const r = await this.db.query<AllergyRow & { total: string }>(
      `SELECT *, count(*) OVER() AS total FROM patient_allergies
        WHERE org_id = $1 AND patient_id = $2 ORDER BY recorded_at DESC
        LIMIT $3 OFFSET $4`, values);
    const resources = r.rows.map((row) => toFhirAllergy(row));
    const total = Number(r.rows[0]?.total ?? 0);
    await audit(this.db, actor, 'fhir.search', 'AllergyIntolerance', patientId, { count: total });
    return buildSearchSetBundle(resources, total, selfUrl(`${FHIR_PATH}/AllergyIntolerance`, {
      patient: patientId,
      _count: String(limit), _offset: skip ? String(skip) : undefined,
    }));
  }

  @Get('Observation')
  async searchObservation(@Req() req: R, @Query() q: QueryParams = {}) {
    const actor = req.actor;
    requireRole(actor, CLINICAL_ROLES);
    const patientId = parsePatientParam(q.patient);
    const limit = parseCount(q._count);
    const skip = parseOffset(q._offset);
    // Valida date= mesmo sem fonte de dados, mantendo o contrato de busca.
    parseDateRange(q.date);
    // database/schema.sql não possui tabela de vitals (ex.: clinical_history):
    // sem fonte de dados, respondemos o Bundle searchset vazio com total: 0.
    await audit(this.db, actor, 'fhir.search', 'Observation', patientId, { count: 0 });
    return buildSearchSetBundle([], 0, selfUrl(`${FHIR_PATH}/Observation`, {
      patient: patientId, category: str(q.category), date: str(q.date),
      _count: String(limit), _offset: skip ? String(skip) : undefined,
    }));
  }

  @Get('MedicationRequest')
  async searchMedicationRequest(@Req() req: R, @Query() q: QueryParams = {}) {
    const actor = req.actor;
    requireRole(actor, CLINICAL_ROLES);
    const patientId = parsePatientParam(q.patient);
    const limit = parseCount(q._count);
    const skip = parseOffset(q._offset);
    const values: unknown[] = [actor.org_id, patientId];
    const where: string[] = ['pr.org_id = $1', 'e.patient_id = $2'];
    const status = str(q.status);
    if (status) {
      const dbStatus = MEDICATION_STATUS_TO_DB[status];
      if (!dbStatus) throw new BadRequestException('status deve ser: active, draft ou cancelled');
      values.push(dbStatus);
      where.push(`pr.status = $${values.length}`);
    }
    values.push(limit, skip);
    const r = await this.db.query<any>(
      `SELECT pr.*, e.patient_id AS patient_id, count(*) OVER() AS total
         FROM prescriptions pr
         JOIN encounters e ON e.id = pr.encounter_id AND e.org_id = pr.org_id
        WHERE ${where.join(' AND ')} ORDER BY pr.created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    const resources = r.rows.map(toFhirMedicationRequest);
    const total = Number(r.rows[0]?.total ?? 0);
    await audit(this.db, actor, 'fhir.search', 'MedicationRequest', patientId, { count: total });
    return buildSearchSetBundle(resources, total, selfUrl(`${FHIR_PATH}/MedicationRequest`, {
      patient: patientId, status,
      _count: String(limit), _offset: skip ? String(skip) : undefined,
    }));
  }

  @Get('DiagnosticReport')
  async searchDiagnosticReport(@Req() req: R, @Query() q: QueryParams = {}) {
    const actor = req.actor;
    requireRole(actor, CLINICAL_ROLES);
    const patientId = parsePatientParam(q.patient);
    const limit = parseCount(q._count);
    const skip = parseOffset(q._offset);
    const range = parseDateRange(q.date);
    // MVP sem tabela de laboratório: notas clínicas assinadas funcionam como relatório final.
    const values: unknown[] = [actor.org_id, patientId];
    const where: string[] = ['n.org_id = $1', 'e.patient_id = $2', "n.status = 'signed'"];
    if (range) {
      values.push(range.start, range.end);
      where.push(`n.signed_at >= $${values.length - 1} AND n.signed_at < $${values.length}`);
    }
    values.push(limit, skip);
    const r = await this.db.query<any>(
      `SELECT n.*, e.patient_id AS patient_id, count(*) OVER() AS total
         FROM clinical_notes n
         JOIN encounters e ON e.id = n.encounter_id AND e.org_id = n.org_id
        WHERE ${where.join(' AND ')} ORDER BY n.signed_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    const resources = r.rows.map(toFhirDiagnosticReport);
    const total = Number(r.rows[0]?.total ?? 0);
    await audit(this.db, actor, 'fhir.search', 'DiagnosticReport', patientId, { count: total });
    return buildSearchSetBundle(resources, total, selfUrl(`${FHIR_PATH}/DiagnosticReport`, {
      patient: patientId, date: str(q.date),
      _count: String(limit), _offset: skip ? String(skip) : undefined,
    }));
  }

  @Get('DocumentReference')
  async searchDocumentReference(@Req() req: R, @Query() q: QueryParams = {}) {
    const actor = req.actor;
    requireRole(actor, CLINICAL_ROLES);
    const patientId = parsePatientParam(q.patient);
    const limit = parseCount(q._count);
    const skip = parseOffset(q._offset);
    const range = parseDateRange(q.date);
    const values: unknown[] = [actor.org_id, patientId];
    const where: string[] = ['org_id = $1', 'patient_id = $2'];
    const type = tokenValue(q.type);
    if (type) { values.push(type); where.push(`doc_type = $${values.length}`); }
    if (range) {
      values.push(range.start, range.end);
      where.push(`created_at >= $${values.length - 1} AND created_at < $${values.length}`);
    }
    values.push(limit, skip);
    const r = await this.db.query<any>(
      `SELECT *, count(*) OVER() AS total FROM clinical_documents
        WHERE ${where.join(' AND ')} ORDER BY created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    const resources = r.rows.map(toFhirDocumentReference);
    const total = Number(r.rows[0]?.total ?? 0);
    await audit(this.db, actor, 'fhir.search', 'DocumentReference', patientId, { count: total });
    return buildSearchSetBundle(resources, total, selfUrl(`${FHIR_PATH}/DocumentReference`, {
      patient: patientId, type: str(q.type), date: str(q.date),
      _count: String(limit), _offset: skip ? String(skip) : undefined,
    }));
  }
}

/**
 * SMART espera /.well-known/smart-configuration na RAIZ do servidor; o prefixo
 * fhir/R4 do FhirExtraController não permite caminho absoluto, por isso este
 * controller extra (mesmo payload, rotear no main.ts junto com FhirExtraController).
 */
@Controller('.well-known')
export class SmartWellKnownController {
  @Public()
  @Get('smart-configuration')
  smartConfiguration() {
    return buildSmartConfiguration();
  }
}
