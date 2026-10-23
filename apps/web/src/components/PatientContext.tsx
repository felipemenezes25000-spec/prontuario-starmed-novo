/**
 * Contexto mínimo do paciente em TODA tela clínica (Plano Mestre V1 §7.1
 * "contexto primeiro"; avaliação de UX 2026-10-23, S1): idade, nascimento e
 * alergias ativas. Alergia crítica em vermelho; ausência de registro é dita
 * como tal — nunca "sem alergias" (H-04).
 */
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api, type Patient } from '../api';
import { ageYears, dateBR } from '../labels';

type Allergy = { id: string; substance: string; criticality: string; clinical_status?: string; clinicalStatus?: string };

export function PatientContext({ patient, token }: { patient: Patient; token: string }) {
  const [allergies, setAllergies] = useState<Allergy[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setAllergies(null); setFailed(false);
    api<Allergy[]>('/patients/' + patient.id + '/allergies', token)
      .then(r => { if (alive) setAllergies(r); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [patient.id, token]);

  const age = ageYears(patient.birthDate);
  const active = (allergies ?? []).filter(a => (a.clinical_status ?? a.clinicalStatus ?? 'active') === 'active');
  return <div className="patient-context">
    <p>{age !== null ? <strong>{age} anos</strong> : null}{age !== null ? ' · ' : ''}Nascimento: {dateBR(patient.birthDate)}</p>
    <div className="patient-allergies" aria-label="Alergias do paciente">
      {failed ? <span className="allergy-other" role="status">Alergias indisponíveis nesta tela — consulte o prontuário antes de prescrever</span>
        : allergies === null ? <span className="muted">Carregando alergias…</span>
        : active.length === 0 ? <span className="allergy-none">Nenhuma alergia registrada (não significa ausência)</span>
        : active.map(a => <span key={a.id} className={'allergy-chip ' + (a.criticality === 'high' ? 'allergy-high' : 'allergy-other')}>
            <AlertTriangle size={13} aria-hidden="true" /> Alergia: {a.substance}{a.criticality === 'high' ? ' (crítica)' : ''}
          </span>)}
    </div>
  </div>;
}
