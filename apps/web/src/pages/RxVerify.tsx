/**
 * Página PÚBLICA de verificação da receita (/verificar/:token) — sem login.
 * Etapa 1 (sem código): autenticidade e situação, sem medicamento.
 * Etapa 2 (código impresso no PDF): dados para dispensação.
 * API: GET /rx-verify/:token · POST /rx-verify/:token/details {code}.
 */
import { useEffect, useState, type FormEvent } from 'react';

const base = (import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '');

type PublicView = {
  status: 'valid' | 'cancelled' | 'expired' | 'not_issued';
  kindLabel: string; issuedAt: string | null; validUntil: string | null;
  signatureLevel: 'pades' | 'attested' | 'none';
  prescriber: { name: string | null; councilNumber: string | null; councilState: string | null };
  patientInitials: string; documentSha256: string | null; note: string;
};
type Details = {
  status: PublicView['status']; kindLabel: string; issuedAt: string | null; validUntil: string | null;
  patient: { name: string; cpfMasked: string | null };
  medication: { name: string; concentration: string | null; form: string | null; dose: string | null; route: string;
    frequency: string; duration: string; quantity: number | null; instructions: string };
};

const STATUS_TEXT: Record<PublicView['status'], string> = {
  valid: 'Receita emitida e dentro da validade',
  cancelled: 'Receita CANCELADA pelo emissor — não dispensar',
  expired: 'Receita VENCIDA — não dispensar',
  not_issued: 'Receita não emitida',
};
const SIGNATURE_TEXT: Record<PublicView['signatureLevel'], string> = {
  pades: 'Assinatura digital PAdES (ICP-Brasil) registrada — confirme no validador oficial do ITI',
  attested: 'Atestada pelo emissor (PDF com hash registrado); sem assinatura digital ICP-Brasil',
  none: 'Sem assinatura registrada',
};
const fmtDate = (v: string | null) => (v ? new Date(v.length === 10 ? v + 'T12:00:00' : v).toLocaleDateString('pt-BR') : '—');

export function RxVerifyPage({ token }: { token: string }) {
  const [view, setView] = useState<PublicView | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [details, setDetails] = useState<Details | null>(null);
  const [codeError, setCodeError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${base}/rx-verify/${encodeURIComponent(token)}`)
      .then(async r => {
        if (r.status === 404) throw new Error('Receita não encontrada. Confira o endereço ou o QR code.');
        if (r.status === 429) throw new Error('Muitas consultas seguidas. Aguarde alguns minutos.');
        if (!r.ok) throw new Error('Não foi possível consultar agora. Tente novamente.');
        setView(await r.json());
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Falha de conexão.'));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setCodeError('');
    try {
      const r = await fetch(`${base}/rx-verify/${encodeURIComponent(token)}/details`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      });
      if (r.status === 401) throw new Error('Código inválido. Após 5 tentativas erradas a consulta fica bloqueada por 30 minutos.');
      if (r.status === 429) throw new Error('Muitas consultas seguidas. Aguarde alguns minutos.');
      if (!r.ok) throw new Error('Não foi possível consultar agora.');
      setDetails(await r.json());
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : 'Falha de conexão.');
    } finally { setBusy(false); }
  }

  return (
    <main className="rxv-page" aria-labelledby="rxv-title">
      <h1 id="rxv-title">Verificação de receita</h1>
      {!view && !error && <p role="status">Consultando…</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {view && <section aria-label="Autenticidade">
        <p className={`rxv-status rxv-${view.status}`} role="status"><strong>{STATUS_TEXT[view.status]}</strong></p>
        <dl className="rxv-dl">
          <div><dt>Tipo</dt><dd>{view.kindLabel}</dd></div>
          <div><dt>Emitida em</dt><dd>{fmtDate(view.issuedAt)}</dd></div>
          {view.validUntil && <div><dt>Válida até</dt><dd>{fmtDate(view.validUntil)}</dd></div>}
          <div><dt>Prescritor</dt><dd>{view.prescriber.name ?? '—'}{view.prescriber.councilNumber ? ` — CRM ${view.prescriber.councilNumber}/${view.prescriber.councilState}` : ''}</dd></div>
          <div><dt>Paciente</dt><dd>{view.patientInitials || '—'}</dd></div>
          <div><dt>Assinatura</dt><dd>{SIGNATURE_TEXT[view.signatureLevel]}</dd></div>
          {view.documentSha256 && <div><dt>SHA-256 do PDF</dt><dd className="rxv-hash">{view.documentSha256}</dd></div>}
        </dl>
        <p className="field-hint">{view.note}</p>
      </section>}
      {view && !details && <form className="rxv-form" onSubmit={submit}>
        <label>Código de verificação impresso na receita
          <input value={code} onChange={e => setCode(e.target.value)} autoComplete="off" placeholder="XXXX-XXXX"
            maxLength={20} aria-invalid={!!codeError} aria-describedby="rxv-code-err" required />
        </label>
        <small id="rxv-code-err" className={codeError ? 'field-error' : 'field-hint'} role={codeError ? 'alert' : undefined}>
          {codeError || 'Com o código, a farmácia vê o medicamento para conferir a dispensação.'}
        </small>
        <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Conferindo…' : 'Ver dados para dispensação'}</button>
      </form>}
      {details && <section aria-label="Dados para dispensação">
        <h2>Dados para dispensação</h2>
        <dl className="rxv-dl">
          <div><dt>Paciente</dt><dd>{details.patient.name}{details.patient.cpfMasked ? ` — CPF ${details.patient.cpfMasked}` : ''}</dd></div>
          <div><dt>Medicamento</dt><dd>{details.medication.name}{details.medication.concentration ? ` ${details.medication.concentration}` : ''}</dd></div>
          <div><dt>Dose / via</dt><dd>{details.medication.dose ?? '—'} · {details.medication.route}</dd></div>
          <div><dt>Posologia</dt><dd>{details.medication.frequency} por {details.medication.duration}</dd></div>
          <div><dt>Quantidade</dt><dd>{details.medication.quantity ?? '—'}</dd></div>
          <div><dt>Orientações</dt><dd>{details.medication.instructions}</dd></div>
        </dl>
      </section>}
    </main>
  );
}
