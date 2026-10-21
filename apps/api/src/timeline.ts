import { BadRequestException, Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, requireCareContext, requireRole } from './security';

// ---------------------------------------------------------------------------
// Prontuário 360° — linha do tempo unificada (ST-P1-001) + leitura de
// documentos e versões (ST-P1-003).
//
// Decisões clínicas/de segurança:
//  * Toda leitura exige requireRole(['doctor','nurse']) + contexto de cuidado
//    (requireCareContext, break-glass auditado) + audit com requestId — o
//    prontuário unificado NÃO pode ser porta lateral para furar o P0-05.
//  * Uma ÚNICA query com UNION ALL (7 ramos) — não 7 round-trips; paginação e
//    filtro de tipos/série temporal aplicados no wrapper, com limit ≤ 200.
//  * `summary` é curto e SEM conteúdo clínico longo: notas não vazam o JSONB
//    (só versão/status), alergias não vazam texto livre de reação, receitas
//    mostram apenas campos estruturados curtos (dose/via/frequência).
//  * `meta` é honesto: prescription expõe o signature_status real
//    ('none'|'attested'|'pades'), exam expõe priority/critical/status e
//    document expõe sha256 + nº de versões da tabela append-only (022).
// ---------------------------------------------------------------------------

type ReqWithActor = { actor: Actor; headers?: Record<string, unknown> };
const breakGlassOf = (req: ReqWithActor) => req.headers?.['x-break-glass-reason'];

/** Garante que o paciente existe na ORG do ator (404 sem vazar existence
 *  cross-tenant) — mesmo padrão de clinical-history.ts. */
export async function ensurePatient(db: Db, patientId: string, orgId: string) {
  const p = await db.query('SELECT 1 FROM patients WHERE id=$1 AND org_id=$2', [patientId, orgId]);
  if (!p.rowCount) throw new NotFoundException('Paciente não encontrado');
}

export const TIMELINE_KINDS = ['encounter', 'note', 'prescription', 'allergy', 'problem', 'exam', 'document'] as const;
export type TimelineKind = typeof TIMELINE_KINDS[number];

/** Converte o query param `types` (csv) no conjunto de ramos a exibir.
 *  Pura (determinística, sem I/O) e testável: vazio/ausente => todos os
 *  tipos; item desconhecido => BadRequestException 400 sem PHI (lançada
 *  DENTRO do transform do zod, o parse() do domain a propaga como 400).
 *  Deduplica preservando a ordem canônica. */
export function parseTimelineTypes(raw: string | undefined): TimelineKind[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const wanted = new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const unknown = [...wanted].filter(k => !(TIMELINE_KINDS as readonly string[]).includes(k));
  if (unknown.length)
    throw new BadRequestException(
      'Tipos de linha do tempo inválidos: ' + unknown.join(',') +
      '. Use encounter,note,prescription,allergy,problem,exam,document.');
  return TIMELINE_KINDS.filter(k => wanted.has(k));
}

export type TimelineRow = {
  kind: string;
  id: string;
  at: string | Date;
  status: string | null;
  author: string | null;
  title: string | null;
  summary: string | null;
  meta: Record<string, unknown> | null;
};
export type TimelineItem = {
  kind: TimelineKind;
  id: string;
  at: string;
  status: string | null;
  author: string | null;
  title: string;
  summary: string | null;
  meta: Record<string, unknown>;
};

/** Mapeia uma linha da UNION para o item normalizado `{kind,id,at,status,
 *  author,title,summary,meta}`. Pura: sem banco, sem I/O. Falha fechada se o
 *  banco devolver kind fora do contrato (drift de schema vira 500, não item
 *  silenciosamente errado no prontuário). */
export function toTimelineItem(row: TimelineRow): TimelineItem {
  const kind = row.kind as TimelineKind;
  if (!(TIMELINE_KINDS as readonly string[]).includes(kind))
    throw new Error('kind de linha do tempo desconhecido');
  return {
    kind,
    id: row.id,
    at: row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString(),
    status: row.status ?? null,
    author: row.author ?? null,
    title: (row.title ?? '').slice(0, 160),
    summary: row.summary ?? null,
    meta: row.meta ?? {}
  };
}

const kindEnum = z.enum(['encounter', 'note', 'prescription', 'allergy', 'problem', 'exam', 'document']);
const isoLike = z.string().min(4).max(40).refine(v => !Number.isNaN(Date.parse(v)), 'Data inválida (use ISO 8601)');
const timelineQuerySchema = z.object({
  types: z.string().max(300).optional()
    .transform(parseTimelineTypes)
    .pipe(z.array(kindEnum).min(1).max(7).optional()),
  since: isoLike.optional(),
  until: isoLike.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
}).strict();

// Uma query só: 7 ramos UNION ALL + wrapper de filtro/ordenação/limite.
// Colunas normalizadas idênticas em todos os ramos (kind,id,at,status,author,title,summary,meta).
const TIMELINE_SQL = `
SELECT kind, id, at, status, author, title, summary, meta FROM (
  SELECT 'encounter'::text AS kind, e.id::text AS id, e.started_at AS at, e.status::text AS status,
         u.display_name AS author,
         left(e.specialty || ' · ' || e.type, 160) AS title,
         left(nullif(btrim(e.reason_for_visit), ''), 160) AS summary,
         jsonb_build_object('encounterType', e.type) AS meta
    FROM encounters e
    LEFT JOIN users u ON u.id = e.doctor_id AND u.org_id = e.org_id
   WHERE e.org_id = $1 AND e.patient_id = $2
  UNION ALL
  -- Nota: NUNCA o content JSONB na timeline (resumo curto; o conteúdo fica no
  -- endpoint dedicado de nota com sua própria autorização).
  SELECT 'note'::text, n.id::text, COALESCE(n.signed_at, n.updated_at), n.status::text,
         u.display_name,
         left(n.template_id, 160),
         ('Nota clínica v' || n.version),
         jsonb_build_object('version', n.version, 'encounterId', n.encounter_id::text)
    FROM clinical_notes n
    JOIN encounters e ON e.id = n.encounter_id AND e.org_id = n.org_id
    LEFT JOIN users u ON u.id = n.author_id AND u.org_id = n.org_id
   WHERE n.org_id = $1 AND e.patient_id = $2
  UNION ALL
  SELECT 'prescription'::text, p.id::text, p.created_at, p.status::text,
         u.display_name,
         left(p.medication_name, 160),
         left(nullif(btrim(concat_ws(' · ', p.dose, p.route, p.frequency)), ''), 160),
         jsonb_build_object('signatureStatus', COALESCE(p.signature_status, 'none'))
    FROM prescriptions p
    JOIN encounters e ON e.id = p.encounter_id AND e.org_id = p.org_id
    LEFT JOIN users u ON u.id = p.prescriber_id AND u.org_id = p.org_id
   WHERE p.org_id = $1 AND e.patient_id = $2
  UNION ALL
  -- Alergia: sem texto livre de reação no resumo (campo não estruturado); a
  -- criticidade/status estruturado vai em summary/meta.
  SELECT 'allergy'::text, a.id::text, a.recorded_at, a.clinical_status::text,
         u.display_name,
         left(a.substance, 160),
         ('Alergia registrada · criticidade ' || a.criticality),
         jsonb_build_object('criticality', a.criticality, 'clinicalStatus', a.clinical_status, 'verificationStatus', a.verification_status)
    FROM patient_allergies a
    LEFT JOIN users u ON u.id = a.recorded_by AND u.org_id = a.org_id
   WHERE a.org_id = $1 AND a.patient_id = $2
  UNION ALL
  SELECT 'problem'::text, c.id::text, c.recorded_at, c.clinical_status::text,
         u.display_name,
         left(c.display, 160),
         ('Problema · verificação ' || c.verification_status),
         jsonb_build_object('code', c.code, 'codeSystem', c.code_system, 'onsetDate', c.onset_date, 'verificationStatus', c.verification_status)
    FROM patient_conditions c
    LEFT JOIN users u ON u.id = c.recorded_by AND u.org_id = c.org_id
   WHERE c.org_id = $1 AND c.patient_id = $2
  UNION ALL
  SELECT 'exam'::text, d.id::text, d.ordered_at, d.status::text,
         u.display_name,
         left(d.description, 160),
         (d.order_type || ' · ' || d.priority),
         jsonb_build_object('priority', d.priority, 'critical', d.critical, 'status', d.status)
    FROM diagnostic_orders d
    LEFT JOIN users u ON u.id = d.requester_id AND u.org_id = d.org_id
   WHERE d.org_id = $1 AND d.patient_id = $2
  UNION ALL
  -- Documento não tem estado de fluxo no schema: status honesto NULL (nada de
  -- inventar 'active'). versions = linhas da tabela append-only do 022.
  SELECT 'document'::text, cd.id::text, cd.created_at, NULL::text,
         u.display_name,
         left(cd.doc_type, 160),
         NULL::text,
         jsonb_build_object('sha256', cd.sha256,
           'versions', (SELECT count(*) FROM document_versions dv WHERE dv.org_id = cd.org_id AND dv.document_id = cd.id))
    FROM clinical_documents cd
    LEFT JOIN users u ON u.id = cd.created_by AND u.org_id = cd.org_id
   WHERE cd.org_id = $1 AND cd.patient_id = $2
) t
WHERE t.kind = ANY($3::text[])
  AND ($4::timestamptz IS NULL OR t.at >= $4::timestamptz)
  AND ($5::timestamptz IS NULL OR t.at <= $5::timestamptz)
ORDER BY t.at DESC
LIMIT $6::int`;

@Controller('patients/:patientId/timeline')
export class TimelineController {
  constructor(private db: Db) {}
  @Get()
  async list(@Req() req: ReqWithActor, @Param('patientId') rawId: string, @Query() rawQuery: Record<string, unknown> = {}) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    const id = parse(uuid, rawId);
    await ensurePatient(this.db, id, actor.org_id);
    await requireCareContext(this.db, actor, id, breakGlassOf(req));
    const q = parse(timelineQuerySchema, rawQuery);
    const kinds = q.types ?? [...TIMELINE_KINDS];
    const rows = await this.db.query(TIMELINE_SQL, [
      actor.org_id, id, kinds,
      q.since ? new Date(q.since).toISOString() : null,
      q.until ? new Date(q.until).toISOString() : null,
      q.limit
    ]);
    await audit(this.db, actor, 'patient.timeline.read', 'patient', id, { types: kinds, count: rows.rowCount });
    return rows.rows.map((r: TimelineRow) => toTimelineItem(r));
  }
}

// ------------------------------------------------------ documentos + versões --
// ST-P1-003: a lista mostra sha256 e nº de versões; as versões vêm da tabela
// append-only `document_versions` (migração 022, gatilho automático) — a
// aplicação só LÊ; nunca UPDATE/DELETE (imutabilidade garantida no banco).

@Controller('patients/:patientId/documents')
export class DocumentsController {
  constructor(private db: Db) {}

  @Get()
  async list(@Req() req: ReqWithActor, @Param('patientId') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    const id = parse(uuid, rawId);
    await ensurePatient(this.db, id, actor.org_id);
    await requireCareContext(this.db, actor, id, breakGlassOf(req));
    const rows = await this.db.query(
      `SELECT cd.id, cd.doc_type, cd.sha256, cd.mime_type, cd.created_at,
              (SELECT count(*) FROM document_versions dv WHERE dv.org_id = cd.org_id AND dv.document_id = cd.id)::int AS versions
         FROM clinical_documents cd
        WHERE cd.org_id = $1 AND cd.patient_id = $2
        ORDER BY cd.created_at DESC
        LIMIT 200`, [actor.org_id, id]);
    await audit(this.db, actor, 'patient.documents.read', 'patient', id, { count: rows.rowCount });
    return rows.rows;
  }

  @Get(':documentId/versions')
  async versions(@Req() req: ReqWithActor, @Param('patientId') rawId: string, @Param('documentId') rawDocId: string) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    const id = parse(uuid, rawId), docId = parse(uuid, rawDocId);
    await ensurePatient(this.db, id, actor.org_id);
    await requireCareContext(this.db, actor, id, breakGlassOf(req));
    // O documento precisa pertencer ao paciente do path E à org (404 cruzado
    // sem vazar existence de outro paciente/tenant).
    const doc = await this.db.query(
      'SELECT 1 FROM clinical_documents WHERE id=$1 AND org_id=$2 AND patient_id=$3', [docId, actor.org_id, id]);
    if (!doc.rowCount) throw new NotFoundException('Documento não encontrado');
    const rows = await this.db.query(
      `SELECT version, sha256, mime_type, change_kind, created_at
         FROM document_versions
        WHERE org_id = $1 AND document_id = $2
        ORDER BY version ASC`, [actor.org_id, docId]);
    await audit(this.db, actor, 'patient.document.versions.read', 'patient', id, { documentId: docId, count: rows.rowCount });
    return {
      documentId: docId,
      versions: rows.rows,
      // Honestidade: só v1 significa "conteúdo nunca re-embarcado desde o
      // versionamento (022)", NÃO "prova de imutabilidade desde o início".
      note: rows.rowCount === 1
        ? 'Somente a versão 1 registrada: o conteúdo não foi re-embarcado desde a ativação do versionamento (migração 022).'
        : null
    };
  }
}
