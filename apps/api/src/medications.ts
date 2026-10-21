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

export type MedicationAlert = SafetyAlert & { medicationId: string | null; medicationName: string | null };

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

    const [allergyRows, medRows] = await Promise.all([
      this.db.query(
        `SELECT substance, criticality, clinical_status, verification_status
           FROM patient_allergies
          WHERE org_id = $1 AND patient_id = $2
          ORDER BY recorded_at DESC LIMIT 200`, [actor.org_id, id]),
      // Ativas = assinadas (draft não é terapia vigente; cancelled sai daqui e
      // permanece no histórico). Sem DELETE em lugar nenhum.
      this.db.query(
        `SELECT p.id, p.medication_name, p.dose, p.frequency, p.route, p.status, p.signature_status, p.created_at
           FROM prescriptions p
           JOIN encounters e ON e.id = p.encounter_id AND e.org_id = p.org_id
          WHERE p.org_id = $1 AND e.patient_id = $2 AND p.status = 'signed'
          ORDER BY p.created_at DESC LIMIT 200`, [actor.org_id, id])
    ]);

    const allergies = allergyRows.rows.map(toAllergyItem);
    const activeMedications = medRows.rows.map(toMedicationItem);
    // O motor de segurança lê LINHAS brutas (clinical_status snake_case): passar
    // os itens camelCase faria o filtro de alergia ativa falhar em silêncio.
    const alerts = buildSafetyAlerts(medRows.rows, allergyRows.rows);

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
