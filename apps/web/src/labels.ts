/**
 * Rótulos em português para códigos internos que vinham crus na tela
 * (avaliação de UX 2026-10-23, H2). A API continua devolvendo os códigos;
 * a tradução é só de apresentação.
 */
import { specialties, type Specialty } from './specialties';

const ENCOUNTER_TYPE: Record<string, string> = {
  consultation: 'Consulta', follow_up: 'Retorno', teleconsultation: 'Teleconsulta', emergency: 'Urgência',
};
const DOC_TYPE: Record<string, string> = {
  prescription: 'Receita (PDF)', exam_result: 'Resultado de exame (PDF)', attestation: 'Atestado', clinical_note: 'Evolução', report: 'Relatório',
};
const APPT_STATUS: Record<string, string> = {
  scheduled: 'Agendado', checked_in: 'Chegou', completed: 'Concluído', cancelled: 'Cancelado', no_show: 'Faltou',
};

export const encounterTypeLabel = (t: string) => ENCOUNTER_TYPE[t] ?? t;
export const appointmentStatusLabel = (s: string) => APPT_STATUS[s] ?? s;
export const specialtyLabel = (s: string) => specialties[s as Specialty]?.name ?? s;
export const docTypeLabel = (d: string) => DOC_TYPE[d] ?? d;

/** Título da linha do tempo: "orthopedics · consultation" → "Ortopedia · Consulta";
 *  "general" (template da nota) → "Clínica geral"; "prescription" → "Receita (PDF)". */
export function timelineTitle(kind: string, title: string): string {
  if (kind === 'document') return docTypeLabel(title);
  return title.split(' · ').map(part => specialties[part as Specialty]?.name ?? ENCOUNTER_TYPE[part] ?? part).join(' · ');
}

/** "1958-04-12" → "12/04/1958" (aceita Date/ISO com hora). */
export function dateBR(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const iso = v instanceof Date ? v.toISOString() : String(v);
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/** Idade em anos completos (data civil local). */
export function ageYears(birth: string | Date | null | undefined, today = new Date()): number | null {
  if (!birth) return null;
  const [y, m, d] = (birth instanceof Date ? birth.toISOString() : String(birth)).slice(0, 10).split('-').map(Number);
  if (!y) return null;
  const ty = today.getFullYear(), tm = today.getMonth() + 1, td = today.getDate();
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}
