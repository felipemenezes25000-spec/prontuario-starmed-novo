import { compareIdentity, MPI_RULE_VERSION, normalizeMpiName, type MpiPerson, type MpiScore } from './mpi-matcher';
import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, requireRole } from './security';
import { ensurePatient } from './timeline';

// ---------------------------------------------------------------------------
// Prontuário 360° — MPI/dedup: candidatas a duplicata + merge rastreável
// (ST-P1-002/003). Contrato de schema: database/022_record360_mpi.sql.
//
// Decisões clínicas/de segurança:
//  * Merge NUNCA apaga linha de paciente nem histórico (CFM/LGPD: o registro
//    perdedor fica em `patients` com `merged_into_id` — rastro legível).
//  * Corrente única: rejeita merge se QUALQUER um dos dois já participou de
//    patient_merges (qualquer lado) ou já tem merged_into_id — nada de compor
//    cadeias A←B←C (aí a dedup perde o sentido e o rastro vira labirinto).
//  * Transação fail-closed: cada movimento de tabela filha em try/catch
//    próprio; QUALQUER violação aborta com rollback citando a tabela — nunca
//    skip silencioso de histórico "problemático".
//  * Operação de administração de dados (não leitura clínica): roles
//    ['admin','doctor'] + audit em tudo; sem requireCareContext (não é
//    acesso a conteúdo clínico — é reorganização de cadastro auditada).
// ---------------------------------------------------------------------------

type ReqWithActor = { actor: Actor; headers?: Record<string, unknown> };

/** Normalização canônica de nome para dedup MPI: minúsculas, trim e colapso
 *  de espaços (Maria   → maria). Pura e testável — é a ÚNICA autoridade de
 *  comparação; o SQL só faz o filtro grosseiro por data de nascimento. */
export function normalizePatientName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function scoreFields(s: MpiScore | undefined) {
  return s ? { score: s.score, classification: s.classification, features: s.features, ruleVersion: MPI_RULE_VERSION } : {};
}

export type DuplicatePatient = { id: string; fullName: string; birthDate: string; externalId: string | null };
export type DuplicatePair = { patient: DuplicatePatient; reason: 'same-name-birthdate' };

/** Pareamento puro das candidatas MPI: mesmo nome normalizado E mesma data de
 *  nascimento, excluindo o próprio paciente índice e limitando a 50 pares. */
export function pairDuplicateCandidates(
  index: { id: string; fullName: string; birthDate: string },
  pool: DuplicatePatient[]
): DuplicatePair[] {
  const indexName = normalizePatientName(index.fullName);
  const pairs: DuplicatePair[] = [];
  for (const c of pool) {
    if (c.id === index.id) continue;
    if (c.birthDate !== index.birthDate) continue;
    if (normalizePatientName(c.fullName) !== indexName) continue;
    pairs.push({ patient: c, reason: 'same-name-birthdate' });
    if (pairs.length >= 50) break;
  }
  return pairs;
}

/** Monta o JSONB `moved_counts` de patient_merges: só tabelas com linhas
 *  efetivamente movidas entram (JSON limpo e honesto — zero ≠ movido).
 *  Pura e testável. */
export function buildMovedCounts(moved: Array<{ table: string; count: number }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of moved) if (m.count > 0) counts[m.table] = m.count;
  return counts;
}

/** Tabelas filhas com coluna `patient_id` que o merge MOVE para o mantido
 *  (nomes literais desta constante — nunca input do usuário — interpolados no
 *  SQL). Excluídas de propósito, com motivo:
 *  - prescriptions / clinical_notes / billing / teleconsult_rooms /
 *    document_signatures / teleconsult_signals / clinical_note_addenda:
 *    referenciam o paciente VIA encounters (ou suas derivações) — sobem com o
 *    encontro movido; UPDATE direto seria redundante ou indevido;
 *  - lgpd_consents: APPEND-ONLY (gatilho forbid_audit_change, 013) — UPDATE é
 *    fisicamente rejeitado pelo banco; as linhas permanecem sob o registro
 *    perdedor (que NUNCA é apagado) e o rastro merge→keep cobre a leitura;
 *  - crm_outbox: não tem patient_id (destinatário fica em `recipient`). */
export const MOVABLE_PATIENT_TABLES = [
  'appointments',
  'encounters',
  'clinical_documents',
  'patient_allergies',
  'patient_conditions',
  'hospital_admissions',
  'diagnostic_orders',
  'antimicrobial_344',
  'portal_accounts',
  'portal_invites',
  'appointment_requests',
  'teleconsult_invites',
  'ai_suggestions',
  'lgpd_requests'
] as const;

/** date do node-postgres vira string 'YYYY-MM-DD' por padrão; defensivo para
 *  não comparar objeto Date contra string no pareamento puro. */
const birthDateText = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

const mergeSchema = z.object({
  keepPatientId: uuid,
  mergedPatientId: uuid,
  // Mesmo limite do CHECK do banco (20..500) — o motivo é a justificativa
  // clínico-administrativa do merge e precisa ser frases, não "ok".
  reason: z.string().trim().min(20).max(500)
}).strict();

@Controller('patients/:patientId/duplicates')
export class MpiCandidatesController {
  constructor(private db: Db) {}

  /** Candidatas a duplicata do paciente índice: MESMA org, ainda não fundidos,
   *  mesmo nome normalizado + mesma data de nascimento. */
  @Get()
  async candidates(@Req() req: ReqWithActor, @Param('patientId') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const id = parse(uuid, rawId);
    await ensurePatient(this.db, id, actor.org_id);
    const index = await this.db.query(
      'SELECT full_name, birth_date, administrative_gender, phone, cpf, cns FROM patients WHERE id=$1 AND org_id=$2', [id, actor.org_id]);
    if (!index.rowCount) throw new NotFoundException('Paciente não encontrado');
    const idx = index.rows[0];
    // Filtro grosseiro no banco (nascimento igual reduz o conjunto a dezenas);
    // a decisão final de igualdade de nome é do normalizePatientName puro,
    // para o critério ser testável e idêntico em teste e produção.
    const pool = await this.db.query(
      `SELECT id, full_name AS "fullName", birth_date AS "birthDate", external_id AS "externalId"
         FROM patients
        WHERE org_id = $1 AND id <> $2 AND merged_into_id IS NULL AND birth_date = $3
        LIMIT 500`, [actor.org_id, id, idx.birth_date]);
    const pairs = pairDuplicateCandidates(
      { id, fullName: String(idx.full_name), birthDate: birthDateText(idx.birth_date) },
      pool.rows.map((r: DuplicatePatient & { birthDate: string | Date }) =>
        ({ id: r.id, fullName: String(r.fullName), birthDate: birthDateText(r.birthDate), externalId: r.externalId ?? null })));
    // Lote 5 (porte do StarMedMpiMatcher): além do critério EXATO acima, pares
    // probabilísticos para revisão humana. Bloco = mesmo ano de nascimento OU
    // mesmo prefixo de 3 letras do 1º nome OU mesmo CPF/CNS; nunca une ninguém.
    const indexPerson: MpiPerson = { id, name: String(idx.full_name), birthDate: birthDateText(idx.birth_date),
      sex: idx.administrative_gender ?? null, phone: idx.phone ?? null, cpf: idx.cpf ?? null, cns: idx.cns ?? null };
    const prefix = normalizeMpiName(indexPerson.name).split(' ')[0]?.slice(0, 3) ?? '';
    const block = await this.db.query(
      `SELECT id, full_name, birth_date, administrative_gender, phone, cpf, cns, external_id
         FROM patients
        WHERE org_id = $1 AND id <> $2 AND merged_into_id IS NULL
          AND (extract(year FROM birth_date) = extract(year FROM $3::date)
               OR ($4 <> '' AND lower(full_name) LIKE $4 || '%')
               OR ($5::text IS NOT NULL AND cpf = $5) OR ($6::text IS NOT NULL AND cns = $6))
        LIMIT 500`, [actor.org_id, id, indexPerson.birthDate, prefix, indexPerson.cpf, indexPerson.cns]);
    const exactIds = new Set(pairs.map(p => p.patient.id));
    const scored = block.rows.map((r: any) => {
      const other: MpiPerson = { id: r.id, name: String(r.full_name), birthDate: birthDateText(r.birth_date),
        sex: r.administrative_gender ?? null, phone: r.phone ?? null, cpf: r.cpf ?? null, cns: r.cns ?? null };
      return { r, other, s: compareIdentity(indexPerson, other) };
    });
    const byId = new Map(scored.map(x => [x.r.id, x.s]));
    const enrichedExact = pairs.map(p => ({ ...p, ...scoreFields(byId.get(p.patient.id)) }));
    const probabilistic = scored
      .filter(x => !exactIds.has(x.r.id) && !x.s.hardConflict && x.s.classification !== 'non_match')
      .sort((a, b) => b.s.score - a.s.score).slice(0, 50)
      .map(x => ({
        patient: { id: x.r.id, fullName: String(x.r.full_name), birthDate: birthDateText(x.r.birth_date), externalId: x.r.external_id ?? null },
        reason: x.s.features.cpf_igual ? 'same-cpf' : x.s.features.cns_igual ? 'same-cns' : 'probabilistic',
        ...scoreFields(x.s),
      }));
    const result = [...enrichedExact, ...probabilistic];
    await audit(this.db, actor, 'mpi.candidates.read', 'patient', id, { candidates: result.length, ruleVersion: MPI_RULE_VERSION });
    return result;
  }
}

@Controller('patients/merge')
export class PatientMergeController {
  constructor(private db: Db) {}

  /** Merge transacional fail-closed: valida corrente única, move todas as
   *  tabelas filhas, marca merged_into_id, registra patient_merges e audita —
   *  tudo numa única transação; qualquer falha desfaz TUDO. */
  @Post()
  async merge(@Req() req: ReqWithActor, @Body() raw: unknown) {
    const actor = req.actor;
    requireRole(actor, ['admin', 'doctor']);
    const b = parse(mergeSchema, raw);
    return this.db.tx(async c => {
      const both = await c.query(
        'SELECT id, merged_into_id FROM patients WHERE org_id=$1 AND id = ANY($2::uuid[])',
        [actor.org_id, [b.keepPatientId, b.mergedPatientId]]);
      const keep = both.rows.find((r: { id: string }) => r.id === b.keepPatientId);
      const loser = both.rows.find((r: { id: string }) => r.id === b.mergedPatientId);
      if (!keep || !loser) throw new NotFoundException('Paciente (a manter ou a fundir) não encontrado nesta organização');
      if (b.keepPatientId === b.mergedPatientId)
        throw new BadRequestException('keepPatientId e mergedPatientId devem ser pacientes distintos');
      // Corrente única: NENHUM dos dois pode já ter aparecido em patient_merges
      // (como mantido OU como fundido) nem ter merged_into_id preenchido.
      const involved = await c.query(
        `SELECT 1 FROM patient_merges
          WHERE org_id = $1 AND (keep_patient_id = ANY($2::uuid[]) OR merged_patient_id = ANY($2::uuid[]))
          LIMIT 1`, [actor.org_id, [b.keepPatientId, b.mergedPatientId]]);
      if (involved.rowCount || keep.merged_into_id || loser.merged_into_id)
        throw new ConflictException(
          'Merge recusado: um dos pacientes já participou de um merge anterior ou já foi fundido. ' +
          'Corrente única — não é possível re-fundir nem compor cadeias de merges.');

      // Movimento das filhas: cada tabela em try/catch próprio para citar
      // exatamente qual restrição barrou (ex.: portal_accounts UNIQUE(org_id,
      // patient_id) quando ambos têm conta). Falha => rollback geral (nada de
      // skip silencioso: histórico parcialmente movido é pior que merge recusado).
      const moved: Array<{ table: string; count: number }> = [];
      for (const table of MOVABLE_PATIENT_TABLES) {
        try {
          const r = await c.query(
            `UPDATE ${table} SET patient_id = $1 WHERE patient_id = $2 AND org_id = $3`,
            [b.keepPatientId, b.mergedPatientId, actor.org_id]);
          moved.push({ table, count: r.rowCount ?? 0 });
        } catch {
          throw new ConflictException(
            `Merge abortado com rollback: mover histórico de "${table}" violou restrição única/integridade do banco. ` +
            'Nenhuma linha foi movida. Resolva o conflito (ex.: conta/registro duplicado nos dois pacientes) e tente novamente.');
        }
      }

      // Rastro legível: perdedor aponta para o mantido. NUNCA DELETE.
      const upd = await c.query(
        'UPDATE patients SET merged_into_id = $1, updated_at = now() WHERE id = $2 AND org_id = $3',
        [b.keepPatientId, b.mergedPatientId, actor.org_id]);
      if (!upd.rowCount) throw new NotFoundException('Paciente a fundir não encontrado');
      const movedCounts = buildMovedCounts(moved);
      const rec = await c.query(
        `INSERT INTO patient_merges(org_id, keep_patient_id, merged_patient_id, performed_by, merge_reason, moved_counts)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [actor.org_id, b.keepPatientId, b.mergedPatientId, actor.id, b.reason, JSON.stringify(movedCounts)]);
      await audit(c, actor, 'patient.merged', 'patient', b.keepPatientId, {
        mergedPatientId: b.mergedPatientId,
        mergeId: rec.rows[0].id,
        movedCounts
      });
      return { keepPatientId: b.keepPatientId, mergedPatientId: b.mergedPatientId, movedCounts };
    });
  }
}
