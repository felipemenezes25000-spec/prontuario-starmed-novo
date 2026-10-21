import { Controller, Get, Param, Req } from '@nestjs/common';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, requireCareContext, requireRole } from './security';
import { evaluatePrescriptionSafety } from './prescriptions';
import type { ActivePrescriptionInput, AllergyInput, SafetyAlert } from './prescriptions';
import { ensurePatient } from './timeline';

// ---------------------------------------------------------------------------
// Prontuário 360° — painel de medicações ativas + segurança medicamentosa
// (ST-P1-002).
//
// Decisões clínicas/de segurança:
//  * "Ativas" = prescriptions.status='signed' via join de encounters do
//    paciente. Rascunho não é terapia vigente; CANCELADA sai da lista ativa
//    mas permanece no histórico (nunca DELETE — rastro cancelado é clínico).
//  * allergyState:'none_recorded' quando NÃO há LINHAS de alergia registradas.
//    Isto NÃO é "paciente sem alergias" — é "nada registrado no sistema".
//    Inferir alergia negativa a partir de ausência de registro é erro clássico
//    de prontuário; por isso o estado nomeia o REGISTRO, não a condição.
//  * Os alerts reutilizam o MESMO motor puro de prescriptions.ts
//    (evaluatePrescriptionSafety): níveis info | review_required | block
//    (alergia crítica = block sem override), sem inventar base farmacológica.
//  * Toda leitura: requireRole(['doctor','nurse']) + requireCareContext
//    (break-glass auditado) + audit com requestId.
// ---------------------------------------------------------------------------

type ReqWithActor = { actor: Actor; headers?: Record<string, unknown> };
const breakGlassOf = (req: ReqWithActor) => req.headers?.['x-break-glass-reason'];

export type AllergyState = 'recorded' | 'none_recorded';

/** Deriva o estado de registro de alergias a partir das linhas retornadas.
 *  Pura e testável: vazio => 'none_recorded' (nada REGISTRADO — nunca afirmar
 *  "sem alergias"); com linhas => 'recorded'. */
export function deriveAllergyState(allergies: unknown[]): AllergyState {
  return allergies.length > 0 ? 'recorded' : 'none_recorded';
}

export type AllergyItem = { substance: string; criticality: string; clinicalStatus: string; verificationStatus: string };
/** Linha de patient_allergies → item camelCase da resposta. Pura. */
export function toAllergyItem(r: { substance: string; criticality: string; clinical_status: string; verification_status: string }): AllergyItem {
  return {
    substance: r.substance,
    criticality: r.criticality,
    clinicalStatus: r.clinical_status,
    verificationStatus: r.verification_status
  };
}

export type MedicationItem = {
  id: string; medicationName: string; dose: string | null; frequency: string | null;
  route: string | null; status: string; signatureStatus: string; prescribedAt: string;
};
/** Linha de prescriptions → item camelCase da resposta. Pura. */
export function toMedicationItem(r: {
  id: string; medication_name: string; dose: string | null; frequency: string | null;
  route: string | null; status: string; signature_status: string;
  created_at: string | Date;
}): MedicationItem {
  return {
    id: r.id,
    medicationName: r.medication_name,
    dose: r.dose ?? null,
    frequency: r.frequency ?? null,
    route: r.route ?? null,
    status: r.status,
    signatureStatus: r.signature_status,
    prescribedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)
  };
}

/** Alertas do painel: os códigos do motor de prescrição + `dose_per_kg`
 *  (informativo de pediatria, sem faixa licenciada). */
export type MedicationAlert = Omit<SafetyAlert, 'code'> & {
  code: SafetyAlert['code'] | 'dose_per_kg';
  medicationId: string | null; medicationName: string | null;
};

/** Peso do paciente a partir de `patients.social_determinants` (JSONB livre).
 *  Aceita número ou string numérica; qualquer outro formato => null (sem peso,
 *  sem alerta de dose — nunca inventar dado clínico). Pura e testável. */
export function readWeightKg(social: unknown): number | null {
  if (social && typeof social === 'object' && !Array.isArray(social)) {
    const raw = (social as Record<string, unknown>).weightKg;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0 && n < 1000) return n;
  }
  return null;
}

/** Dose por peso (Pediatria) — INFORMATIVO e aritmético puro (ST-P1-002/cenário
 *  pediatria): dose em mg ÷ peso em kg = mg/kg. SEM faixa de referência: regra
 *  de dose máxima/mínima exige base farmacológica LICENCIADA (pendência externa
 *  nomeada — ADR-0003). Só `mg` vira conversão; outras unidades não ganham
 *  alerta adivinhado. Pura e testável. */
export function weightBasedDoseAlert(input: {
  medicationId: string; medicationName: string;
  doseValue: number | null; doseUnit: string | null;
  weightKg: number | null;
}): MedicationAlert | null {
  const { doseValue, doseUnit, weightKg } = input;
  if (!weightKg || !(weightKg > 0) || !doseValue || !(doseValue > 0)) return null;
  if (!doseUnit || !/^mg$/i.test(doseUnit.trim())) return null;
  const perKg = doseValue / weightKg;
  return {
    level: 'info', code: 'dose_per_kg',
    message: `Dose por peso: ${perKg.toFixed(2)} mg/kg (${doseValue} mg / ${weightKg} kg) — INFORMATIVO: sem faixa de referência nesta versão (base farmacológica licenciada é pendência externa); confirme a posologia antes de prescrever.`,
    medicationId: input.medicationId, medicationName: input.medicationName
  };
}

/** Gera os alerts do painel reutilizando o motor puro de prescriptions.ts.
 *  Pura, testável sem banco. Regras:
 *  - Cada medicação é avaliada contra TODAS as alergias ativas e contra as
 *    OUTRAS terapias ativas (a medicação NÃO conta consigo mesma — duplicidade
 *    terapêutica só existe entre duas linhas distintas);
 *  - 'no_allergy_record' é alerta do PACIENTE (não da medicação): emite UMA
 *    vez, com medicationId null, para não poluir o painel com N cópias. */
export function buildSafetyAlerts(
  activeMedications: Array<{ id: string; medication_name: string }>,
  allergies: AllergyInput[]
): MedicationAlert[] {
  const alerts: MedicationAlert[] = [];
  if (allergies.length === 0)
    alerts.push({
      level: 'info', code: 'no_allergy_record',
      message: 'Paciente sem alergias registradas; confirme a anamnese antes de assinar.',
      medicationId: null, medicationName: null
    });
  const all: ActivePrescriptionInput[] = activeMedications.map(m => ({ id: m.id, medication_name: m.medication_name }));
  for (const m of activeMedications) {
    const peers = all.filter(p => p.id !== m.id);
    for (const a of evaluatePrescriptionSafety({ medicationName: m.medication_name, allergies, activePrescriptions: peers })) {
      // 'no_allergy_record' é do PACIENTE: já emitido acima uma única vez — o
      // motor o repete por medicação (allergies=[]), então filtramos aqui.
      if (a.code === 'no_allergy_record') continue;
      alerts.push({ ...a, medicationId: m.id, medicationName: m.medication_name });
    }
  }
  return alerts;
}

@Controller('patients/:patientId/medications')
export class MedicationsController {
  constructor(private db: Db) {}

  @Get()
  async list(@Req() req: ReqWithActor, @Param('patientId') rawId: string) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    const id = parse(uuid, rawId);
    await ensurePatient(this.db, id, actor.org_id);
    await requireCareContext(this.db, actor, id, breakGlassOf(req));

    const [allergyRows, medRows, patientRow] = await Promise.all([
      this.db.query(
        `SELECT substance, criticality, clinical_status, verification_status
           FROM patient_allergies
          WHERE org_id = $1 AND patient_id = $2
          ORDER BY recorded_at DESC LIMIT 200`, [actor.org_id, id]),
      // Ativas = assinadas (draft não é terapia vigente; cancelled sai daqui e
      // permanece no histórico). Sem DELETE em lugar nenhum.
      this.db.query(
        `SELECT p.id, p.medication_name, p.dose, p.dose_value, p.dose_unit, p.frequency, p.route, p.status, p.signature_status, p.created_at
           FROM prescriptions p
           JOIN encounters e ON e.id = p.encounter_id AND e.org_id = p.org_id
          WHERE p.org_id = $1 AND e.patient_id = $2 AND p.status = 'signed'
          ORDER BY p.created_at DESC LIMIT 200`, [actor.org_id, id]),
      // Peso (pediatria): social_determinants.weightKg — ausente => sem alerta.
      this.db.query('SELECT social_determinants FROM patients WHERE id=$1 AND org_id=$2', [id, actor.org_id])
    ]);

    const allergies = allergyRows.rows.map(toAllergyItem);
    const activeMedications = medRows.rows.map(toMedicationItem);
    // O motor de segurança lê LINHAS brutas (clinical_status snake_case): passar
    // os itens camelCase faria o filtro de alergia ativa falhar em silêncio.
    const alerts = buildSafetyAlerts(medRows.rows, allergyRows.rows);
    // Dose por peso (informativo, aritmético): uma linha por medicação com dose
    // em mg quando o paciente tem peso registrado.
    const weightKg = readWeightKg(patientRow.rows[0]?.social_determinants);
    for (const m of medRows.rows) {
      const info = weightBasedDoseAlert({
        medicationId: m.id, medicationName: m.medication_name,
        doseValue: m.dose_value === null || m.dose_value === undefined ? null : Number(m.dose_value),
        doseUnit: m.dose_unit ?? null, weightKg
      });
      if (info) alerts.push(info);
    }

    await audit(this.db, actor, 'patient.medications.read', 'patient', id, {
      allergies: allergies.length,
      activeMedications: activeMedications.length,
      blocks: alerts.filter(a => a.level === 'block').length,
      reviewRequired: alerts.filter(a => a.level === 'review_required').length
    });

    return {
      allergyState: deriveAllergyState(allergyRows.rows),
      allergies,
      activeMedications,
      alerts
    };
  }
}
