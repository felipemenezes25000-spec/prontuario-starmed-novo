import { Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, Put, Query, Req, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, requireRole } from './security';

/** Camada de produto: templates clínicos, importador CSV, RBAC, ajustes e métricas. */

type ReqWithActor = { actor: Actor };

const sectionSchema = z.object({
  label: z.string().trim().min(2).max(120),
  required: z.boolean(),
  maxLength: z.number().int().min(100).max(20000)
}).strict();
const templateSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9-]{3,60}$/, 'code deve ser minúsculas/hífen'),
  name: z.string().trim().min(2).max(120),
  specialty: z.enum(['general', 'cardiology', 'orthopedics', 'pediatrics', 'neurology', 'psychiatry']).default('general'),
  sections: z.record(sectionSchema).refine((s) => Object.keys(s).length <= 30 && Object.keys(s).every((k) => /^[a-z_]{2,60}$/.test(k)), 'chaves de seção inválidas'),
  publish: z.boolean().default(false)
}).strict();
const importSchema = z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().default(true), filename: z.string().trim().max(200).default('import.csv') }).strict();
const settingsSchema = z.object({
  aiEnabled: z.boolean().optional(),
  requireMfaForAdmins: z.boolean().optional(),
  teleconsultDefaultMinutes: z.number().int().min(5).max(120).optional()
}).strict();

export type PatientCsvRow = { externalId: string; fullName: string; birthDate: string; administrativeGender: string; phone?: string };
export type PatientCsvResult = { total: number; valid: PatientCsvRow[]; invalid: Array<{ line: number; reason: string }> };

const CSV_HEADERS = ['external_id', 'full_name', 'birth_date', 'administrative_gender', 'phone'];
const GENDERS = new Set(['male', 'female', 'other', 'unknown']);

/** Parser CSV de pacientes (puro): vírgula simples, aspas duplas com escape "". */
export function parsePatientCsv(csv: string): PatientCsvResult {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { total: 0, valid: [], invalid: [{ line: 1, reason: 'arquivo vazio' }] };
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  for (const required of CSV_HEADERS.slice(0, 4))
    if (!header.includes(required)) return { total: 0, valid: [], invalid: [{ line: 1, reason: `coluna obrigatória ausente: ${required}` }] };
  const idx = (name: string) => header.indexOf(name);
  const valid: PatientCsvRow[] = [];
  const invalid: Array<{ line: number; reason: string }> = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim()) ?? [];
    const line = i + 1;
    const row = {
      externalId: (cells[idx('external_id')] ?? '').trim(),
      fullName: (cells[idx('full_name')] ?? '').trim(),
      birthDate: (cells[idx('birth_date')] ?? '').trim(),
      administrativeGender: (cells[idx('administrative_gender')] ?? '').trim().toLowerCase(),
      phone: idx('phone') >= 0 ? (cells[idx('phone')] ?? '').trim() || undefined : undefined
    };
    let reason: string | null = null;
    if (!row.externalId) reason = 'external_id vazio';
    else if (row.fullName.length < 2 || row.fullName.length > 255) reason = 'full_name fora de 2..255';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(row.birthDate)) reason = 'birth_date deve ser YYYY-MM-DD';
    else {
      const parsed = Date.parse(row.birthDate);
      if (!Number.isFinite(parsed) || parsed < Date.parse('1900-01-01') || parsed > Date.now() + 86400_000) reason = 'birth_date fora de faixa';
      else if (!GENDERS.has(row.administrativeGender)) reason = 'administrative_gender inválido';
      else if (seen.has(row.externalId)) reason = 'external_id duplicado no arquivo';
    }
    if (reason) invalid.push({ line, reason });
    else { seen.add(row.externalId); valid.push(row); }
  }
  return { total: lines.length - 1, valid, invalid };
}

/** Matriz RBAC por permissão (pura, testável). */
export const PERMISSIONS = [
  'patients.read', 'patients.write', 'encounters.write', 'notes.sign', 'documents.sign',
  'prescriptions.write', 'templates.manage', 'imports.run', 'settings.manage', 'metrics.read',
  'teleconsult.start', 'portal.invite', 'hospital.admit', 'ai.review', 'fhir.read', 'interop.send'
] as const;
export type Permission = typeof PERMISSIONS[number];
export const RBAC_MATRIX: Record<Actor['role'], Permission[]> = {
  admin: [...PERMISSIONS],
  doctor: ['patients.read', 'patients.write', 'encounters.write', 'notes.sign', 'documents.sign', 'prescriptions.write', 'templates.manage', 'metrics.read', 'teleconsult.start', 'portal.invite', 'hospital.admit', 'ai.review', 'fhir.read', 'interop.send'],
  nurse: ['patients.read', 'encounters.write', 'metrics.read', 'teleconsult.start', 'hospital.admit', 'ai.review', 'fhir.read'],
  reception: ['patients.read', 'portal.invite', 'metrics.read', 'teleconsult.start', 'fhir.read']
};
export function validateRbacMatrix(matrix: Record<string, Permission[]>): { missingPermissions: string[]; emptyRoles: string[] } {
  const covered = new Set<string>();
  const emptyRoles: string[] = [];
  for (const [role, perms] of Object.entries(matrix)) {
    if (perms.length === 0) emptyRoles.push(role);
    for (const p of perms) covered.add(p);
  }
  return { missingPermissions: PERMISSIONS.filter((p) => !covered.has(p)), emptyRoles };
}

@Controller('product')
export class ProductController {
  constructor(private db: Db) {}

  @Post('templates')
  async createTemplate(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const body = parse(templateSchema, raw);
    const last = await this.db.query<any>(
      'SELECT COALESCE(MAX(version),0) AS version FROM clinical_templates WHERE org_id=$1 AND code=$2', [actor.org_id, body.code]);
    const version = Number(last.rows[0].version) + 1;
    const row = await this.db.query<any>(
      `INSERT INTO clinical_templates(org_id,code,name,specialty,sections,version,status,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,code,name,specialty,version,status`,
      [actor.org_id, body.code, body.name, body.specialty, JSON.stringify(body.sections), version, body.publish ? 'published' : 'draft', actor.id]);
    await audit(this.db, actor, 'product.template.created', 'clinical_template', row.rows[0].id);
    return row.rows[0];
  }

  @Get('templates')
  async listTemplates(@Req() req: ReqWithActor, @Query('specialty') specialty?: string, @Query('status') status?: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const filters = ['org_id=$1'];
    const params: unknown[] = [actor.org_id];
    if (specialty) { params.push(specialty); filters.push(`specialty=$${params.length}`); }
    if (status) { params.push(status); filters.push(`status=$${params.length}`); }
    const rows = await this.db.query(
      `SELECT id,code,name,specialty,version,status,updated_at FROM clinical_templates WHERE ${filters.join(' AND ')}
       ORDER BY code, version DESC LIMIT 200`, params);
    return rows.rows;
  }

  @Get('templates/:id')
  async getTemplate(@Req() req: ReqWithActor, @Param('id') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const id = parse(uuid, rawId);
    const row = await this.db.query('SELECT id,code,name,specialty,sections,version,status FROM clinical_templates WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
    if (!row.rowCount) throw new NotFoundException('Template não encontrado');
    return row.rows[0];
  }

  @Put('templates/:id/publish')
  async publishTemplate(@Req() req: ReqWithActor, @Param('id') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['admin']);
    const id = parse(uuid, rawId);
    const row = await this.db.query(
      'UPDATE clinical_templates SET status=\'published\', updated_at=now() WHERE id=$1 AND org_id=$2 AND status=\'draft\' RETURNING id,status',
      [id, actor.org_id]);
    if (!row.rowCount) throw new ConflictException('Template inexistente ou já publicado');
    await audit(this.db, actor, 'product.template.published', 'clinical_template', id);
    return row.rows[0];
  }

  @Post('imports/patients')
  async importPatients(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin']);
    const body = parse(importSchema, raw);
    const parsed = parsePatientCsv(body.csv);
    const run = await this.db.query<any>(
      'INSERT INTO import_runs(org_id,kind,filename,dry_run,total_rows,valid_rows,invalid_rows,errors,created_by,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) RETURNING id,status,total_rows,valid_rows,invalid_rows',
      [actor.org_id, 'patients', body.filename, body.dryRun, parsed.total, parsed.valid.length, parsed.invalid.length, JSON.stringify(parsed.invalid.slice(0, 100)), actor.id]);
    if (!body.dryRun && parsed.invalid.length > 0) {
      await this.db.query('UPDATE import_runs SET status=\'failed\' WHERE id=$1', [run.rows[0].id]);
      throw new UnprocessableEntityException({ message: 'Importação real exige CSV sem linhas inválidas (tudo-ou-nada)', errors: parsed.invalid.slice(0, 20) });
    }
    let imported = 0;
    if (!body.dryRun && parsed.valid.length > 0) {
      await this.db.tx(async c => {
        for (const row of parsed.valid) {
          await c.query(
            `INSERT INTO patients(org_id,external_id,full_name,birth_date,administrative_gender,phone)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT (org_id,external_id) DO UPDATE SET full_name=EXCLUDED.full_name, birth_date=EXCLUDED.birth_date,
               administrative_gender=EXCLUDED.administrative_gender, phone=EXCLUDED.phone, updated_at=now()`,
            [actor.org_id, row.externalId, row.fullName, row.birthDate, row.administrativeGender, row.phone ?? null]);
          imported++;
        }
      });
    }
    await audit(this.db, actor, 'product.import.patients', 'import_run', run.rows[0].id, { dryRun: body.dryRun, imported });
    return { ...run.rows[0], imported, dryRun: body.dryRun };
  }

  @Get('admin/rbac/matrix')
  async rbacMatrix(@Req() req: ReqWithActor) {
    const actor = req.actor;
    requireRole(actor, ['admin']);
    return RBAC_MATRIX;
  }

  @Patch('admin/settings')
  async updateSettings(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin']);
    const body = parse(settingsSchema, raw);
    const row = await this.db.query<any>(
      `INSERT INTO org_settings(org_id, ai_enabled, require_mfa_for_admins, teleconsult_default_minutes, updated_at)
       VALUES($1, COALESCE($2, FALSE), COALESCE($3, FALSE), COALESCE($4, 30), now())
       ON CONFLICT (org_id) DO UPDATE SET
         ai_enabled=COALESCE($2, org_settings.ai_enabled),
         require_mfa_for_admins=COALESCE($3, org_settings.require_mfa_for_admins),
         teleconsult_default_minutes=COALESCE($4, org_settings.teleconsult_default_minutes),
         updated_at=now()
       RETURNING ai_enabled, require_mfa_for_admins, teleconsult_default_minutes, updated_at`,
      [actor.org_id, body.aiEnabled ?? null, body.requireMfaForAdmins ?? null, body.teleconsultDefaultMinutes ?? null]);
    await audit(this.db, actor, 'product.settings.updated', 'organization', actor.org_id, body as Record<string, unknown>);
    return row.rows[0];
  }

  @Get('admin/settings')
  async getSettings(@Req() req: ReqWithActor) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const row = await this.db.query('SELECT ai_enabled, require_mfa_for_admins, teleconsult_default_minutes, updated_at FROM org_settings WHERE org_id=$1', [actor.org_id]);
    return row.rows[0] ?? { ai_enabled: false, require_mfa_for_admins: false, teleconsult_default_minutes: 30, updated_at: null };
  }

  @Get('metrics/summary')
  async summary(@Req() req: ReqWithActor) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const encounters = await this.db.query<any>(
      'SELECT count(*) AS total, count(*) FILTER (WHERE status=\'finished\') AS finished FROM encounters WHERE org_id=$1', [actor.org_id]);
    const byStatus = await this.db.query<any>('SELECT status, count(*) AS n FROM encounters WHERE org_id=$1 GROUP BY status', [actor.org_id]);
    const bySpecialty = await this.db.query<any>('SELECT specialty, count(*) AS n FROM encounters WHERE org_id=$1 GROUP BY specialty', [actor.org_id]);
    const signed = await this.db.query<any>(
      "SELECT count(*) AS n FROM clinical_notes WHERE org_id=$1 AND status='signed' AND signed_at > now() - interval '30 days'", [actor.org_id]);
    const patients = await this.db.query<any>('SELECT count(*) AS n FROM patients WHERE org_id=$1', [actor.org_id]);
    const mfa = await this.db.query<any>(
      'SELECT count(*) FILTER (WHERE mfa_enabled) AS enabled, count(*) AS total FROM users WHERE org_id=$1 AND active=true', [actor.org_id]);
    return {
      encounters: {
        total: Number(encounters.rows[0].total),
        finished: Number(encounters.rows[0].finished),
        byStatus: Object.fromEntries(byStatus.rows.map((r: any) => [r.status, Number(r.n)])),
        bySpecialty: Object.fromEntries(bySpecialty.rows.map((r: any) => [r.specialty, Number(r.n)]))
      },
      prescriptionsSigned30d: Number(signed.rows[0].n),
      patientsTotal: Number(patients.rows[0].n),
      mfaAdoption: { enabled: Number(mfa.rows[0].enabled), total: Number(mfa.rows[0].total) }
    };
  }
}
