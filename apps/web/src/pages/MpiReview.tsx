/**
 * Revisão de possíveis duplicidades (MPI) no prontuário 360°.
 * GET /patients/:id/duplicates → candidatas (exatas + probabilísticas, só sugestão).
 * POST /patients/merge {keepPatientId, mergedPatientId, reason} → merge auditado,
 * sem DELETE (o cadastro fundido fica com merged_into_id). Unir prontuários
 * errados mistura alergias e medicações de duas pessoas: a UI exige escolher
 * quem fica, justificar (≥20 caracteres) e confirmar a conferência de identidade.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, type Patient, type Session } from '../api';

type Alert = (text: string, kind?: 'success' | 'error' | 'info') => void;
type Candidate = {
  patient: { id: string; fullName: string; birthDate: string; externalId: string | null };
  reason: 'same-name-birthdate' | 'same-cpf' | 'same-cns' | 'probabilistic';
  score?: number; classification?: 'definite' | 'probable' | 'possible'; features?: Record<string, number>;
};

const REASON_TEXT: Record<Candidate['reason'], string> = {
  'same-name-birthdate': 'Mesmo nome e mesma data de nascimento',
  'same-cpf': 'Mesmo CPF', 'same-cns': 'Mesmo CNS',
  probabilistic: 'Semelhança de identidade (cálculo probabilístico)',
};
const CLASS_TEXT: Record<string, string> = { definite: 'Mesma pessoa (documento)', probable: 'Provável', possible: 'Possível' };
const FEATURE_TEXT: Record<string, string> = { nome: 'nome', nascimento: 'nascimento', sexo: 'sexo', telefone: 'telefone', cpf_igual: 'CPF', cns_igual: 'CNS' };
const fmt = (d: string) => String(d).slice(0, 10).split('-').reverse().join('/');

export function MpiReview({ session, alert, patient, onMerged }: {
  session: Session; alert: Alert; patient: Patient; onMerged: (keptId: string) => void;
}) {
  const token = session.accessToken;
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [keep, setKeep] = useState<'current' | 'other'>('current');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    setError(''); setItems(null);
    try { setItems(await api<Candidate[]>('/patients/' + patient.id + '/duplicates', token)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Falha ao carregar.'); setItems([]); }
  }
  useEffect(() => { setSelected(null); void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [patient.id, token]);

  async function merge(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const keepId = keep === 'current' ? patient.id : selected.patient.id;
    const mergedId = keep === 'current' ? selected.patient.id : patient.id;
    setBusy(true);
    try {
      await api('/patients/merge', token, 'POST', { keepPatientId: keepId, mergedPatientId: mergedId, reason: reason.trim() });
      alert('Cadastros unidos. O histórico foi movido e o cadastro fundido ficou registrado (sem exclusão).', 'success');
      setSelected(null); setReason(''); setConfirmed(false);
      onMerged(keepId);
    } catch (err) { alert(err instanceof Error ? err.message : 'Falha ao unir cadastros.', 'error'); }
    finally { setBusy(false); }
  }

  if (items === null) return <div className="panel"><p role="status" className="muted">Procurando possíveis duplicidades…</p></div>;
  return <section className="panel" aria-labelledby="mpi-title">
    <div className="panel-title"><h2 id="mpi-title">Possíveis duplicidades</h2></div>
    <p className="field-hint">Sugestões para revisão humana. Nada é unido automaticamente; documentos (CPF/CNS) diferentes nunca aparecem aqui.</p>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!error && items.length === 0 && <div className="empty-state">Nenhuma possível duplicidade encontrada para este cadastro.</div>}
    <ul className="mpi-list">
      {items.map(c => <li key={c.patient.id} className="mpi-item">
        <div>
          <strong>{c.patient.fullName}</strong> — nascimento {fmt(c.patient.birthDate)}
          <div className="field-hint">{REASON_TEXT[c.reason]}{c.classification ? ` · ${CLASS_TEXT[c.classification] ?? c.classification}` : ''}{c.score != null ? ` · pontuação ${c.score}` : ''}</div>
          {c.features && <div className="field-hint">Coincidências: {Object.entries(c.features).filter(([, w]) => w > 0).map(([k]) => FEATURE_TEXT[k] ?? k).join(', ') || 'nenhuma'}</div>}
        </div>
        <button type="button" className="secondary-button" onClick={() => { setSelected(c); setKeep('current'); setReason(''); setConfirmed(false); }}>Revisar e unir</button>
      </li>)}
    </ul>
    {selected && <form className="mpi-merge stack gap-4" onSubmit={merge} aria-label="Unir cadastros">
      <fieldset>
        <legend>Qual cadastro permanece?</legend>
        <label><input type="radio" name="keep" checked={keep === 'current'} onChange={() => setKeep('current')} /> Este ({patient.fullName}, {fmt(patient.birthDate)})</label>
        <label><input type="radio" name="keep" checked={keep === 'other'} onChange={() => setKeep('other')} /> O outro ({selected.patient.fullName}, {fmt(selected.patient.birthDate)})</label>
      </fieldset>
      <label>Justificativa (mínimo 20 caracteres)
        <textarea rows={2} value={reason} maxLength={500} onChange={e => setReason(e.target.value)} required minLength={20} />
      </label>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Conferi documento, nascimento e filiação com o paciente ou responsável: são a mesma pessoa.</label>
      <div className="row gap-2">
        <button className="primary-button" type="submit" disabled={busy || !confirmed || reason.trim().length < 20}>{busy ? 'Unindo…' : 'Unir cadastros'}</button>
        <button className="secondary-button" type="button" onClick={() => setSelected(null)}>Cancelar</button>
      </div>
    </form>}
  </section>;
}
