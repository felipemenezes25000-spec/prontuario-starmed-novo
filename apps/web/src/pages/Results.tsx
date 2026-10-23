import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, Download, FileText, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import { api, ApiError, EVENT_SESSION_EXPIRED, type Session } from '../api';

/**
 * P1/ST-P1-005 (parte web) — EXAMES E RESULTADOS: a jornada do pedido
 * diagnóstico na UI de equipe, integrada a apps/api/src/hospital.ts e
 * apps/api/src/orders.ts:
 *   GET   /hospital/orders?status=&critical=&priority=   → lista (ciclo 023)
 *   GET   /hospital/orders/critical/pending               → críticos sem ack
 *   POST  /hospital/orders/:id/critical-ack               → reconhecimento (J1 #12)
 *   PATCH /hospital/orders/:id/status                     → transição do ciclo
 *         {status, critical?, resultValue?, resultReference?, resultUnits?, communicatedTo?}
 *   POST  /hospital/orders/:id/result-document            → gera PDF do resultado
 *   GET   /hospital/orders/:id/result-document            → download BLOB c/ Bearer
 *   POST  /hospital/orders/:id/lis-dispatch {channel}     → LIS/PACS (nasce desligado)
 * HONESTIDADE: crítico sem reconhecimento aparece como "NÃO reconhecido"; a
 * integração LIS/PACS mostra A MENSAGEM DO SERVIDOR (409 "desligada" sem
 * LIS_URL/PACS_URL) — nunca afirmamos "conectado" sem prova do servidor.
 * 401: o helper api() dispara EVENT_SESSION_EXPIRED e o App volta ao login —
 * aqui só paramos de renderizar. Sem PHI em console (nada é logado).
 * Somente classes CSS existentes (panel, list-line, small-pill, …).
 */

type Alert = (text: string, kind?: 'success' | 'error' | 'info') => void;

const apiBase = (import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '');

type DiagnosticOrder = {
  id: string; patient_id?: string; order_type: 'lab' | 'imaging'; loinc_code: string | null;
  description: string; status: string; priority: 'routine' | 'urgent';
  result_summary: string | null; pacs_url: string | null;
  critical: boolean; critical_ack_by?: string | null; critical_ack_at: string | null;
  result_value: string | null; result_reference: string | null; result_units: string | null;
  preliminary_at: string | null; final_at: string | null;
  reviewed_by?: string | null; reviewed_at: string | null;
  communicated_at: string | null; communicated_to: string | null;
  result_document_id: string | null;
  ordered_at: string; updated_at: string;
};
type CriticalPending = {
  id: string; order_type: string; loinc_code: string | null; description: string;
  status: string; priority: string; result_summary: string | null;
  critical_ack_at: string | null; ordered_at: string; updated_at: string;
};

/** Mesma máquina do backend (orders.ts) — a UI só oferece o que o servidor aceita. */
const NEXT: Record<string, string[]> = {
  ordered: ['accepted', 'in_progress', 'cancelled'],
  accepted: ['collected', 'cancelled'],
  collected: ['preliminary', 'cancelled'],
  preliminary: ['final', 'cancelled'],
  final: ['reviewed'],
  reviewed: ['communicated'],
  communicated: [],
  in_progress: ['completed', 'collected', 'cancelled'],
  completed: [], cancelled: []
};
const ALL_STATUSES = Object.keys(NEXT);
/** Etapas que pedem resultado estruturado na tela. */
const RESULT_STEPS = ['preliminary', 'final'];
const RESULT_READY = ['preliminary', 'final', 'reviewed', 'communicated'];

const STATUS_LABEL: Record<string, string> = {
  ordered: 'Pedido', accepted: 'Aceito', collected: 'Coletado', preliminary: 'Preliminar',
  final: 'Final', reviewed: 'Revisado', communicated: 'Comunicado',
  in_progress: 'Em andamento', completed: 'Concluído', cancelled: 'Cancelado'
};
const statusLabel = (status: string) => STATUS_LABEL[status] ?? status;
const fmt = (iso?: string | null) => iso ? new Date(iso).toLocaleString('pt-BR') : '—';

export function ResultsPage({ session, alert }: { session: Session; alert: Alert }) {
  const token = session.accessToken;
  const role = session.user.role;
  const canAck = role === 'doctor' || role === 'nurse';
  const canResult = canAck;               // doctor|nurse (contrato do backend)
  const canDispatch = role !== 'reception';

  const [orders, setOrders] = useState<DiagnosticOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [onlyCritical, setOnlyCritical] = useState(false);

  const [criticalPending, setCriticalPending] = useState<CriticalPending[]>([]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [docBusyId, setDocBusyId] = useState<string | null>(null);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [dispatchBusyId, setDispatchBusyId] = useState<string | null>(null);

  // Editor contextual da etapa (resultado estruturado / comunicado).
  const [editor, setEditor] = useState<{ id: string; step: string } | null>(null);
  const [form, setForm] = useState({ resultValue: '', resultReference: '', resultUnits: '', communicatedTo: '' });

  // Último desfecho da integração LIS/PACS — SEMPRE a mensagem vinda do servidor.
  const [integration, setIntegration] = useState<{ text: string; kind: 'info' | 'error' | 'success' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (priorityFilter) params.set('priority', priorityFilter);
      if (onlyCritical) params.set('critical', 'true');
      const query = params.toString();
      const rows = await api<DiagnosticOrder[]>('/hospital/orders' + (query ? '?' + query : ''), token);
      setOrders(Array.isArray(rows) ? rows : []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // App trata a sessão
      setLoadError('Não foi possível carregar os pedidos diagnósticos. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter, priorityFilter, onlyCritical]);

  const loadCritical = useCallback(async () => {
    try {
      const rows = await api<CriticalPending[]>('/hospital/orders/critical/pending', token);
      setCriticalPending(Array.isArray(rows) ? rows : []);
    } catch { /* bloco opcional: falha aqui não derruba a tela */ }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadCritical(); }, [loadCritical]);

  function message(e: unknown, fallback: string): string {
    if (e instanceof ApiError) return e.message || fallback;
    return fallback;
  }

  async function transition(order: DiagnosticOrder, to: string, payload: Record<string, unknown>) {
    if (busyId) return;
    setBusyId(order.id);
    try {
      const updated = await api<DiagnosticOrder>('/hospital/orders/' + order.id + '/status', token, 'PATCH', { status: to, ...payload });
      setOrders(list => list.map(o => o.id === order.id ? { ...o, ...updated } : o));
      setEditor(null);
      alert('Status atualizado para "' + statusLabel(to) + '".', 'success');
      void loadCritical();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      alert(message(e, 'Não foi possível atualizar o status do pedido.'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  function nextAction(order: DiagnosticOrder, to: string) {
    if (RESULT_STEPS.includes(to) || to === 'communicated') {
      setEditor({ id: order.id, step: to });
      setForm({
        resultValue: order.result_value ?? '', resultReference: order.result_reference ?? '',
        resultUnits: order.result_units ?? '', communicatedTo: order.communicated_to ?? ''
      });
      return;
    }
    void transition(order, to, {});
  }

  function confirmEditor(e: FormEvent) {
    e.preventDefault();
    if (!editor) return;
    const order = orders.find(o => o.id === editor.id);
    if (!order) return;
    if (editor.step === 'communicated') {
      void transition(order, editor.step, { communicatedTo: form.communicatedTo.trim() });
      return;
    }
    const payload: Record<string, unknown> = { resultValue: form.resultValue.trim() };
    if (form.resultReference.trim()) payload.resultReference = form.resultReference.trim();
    if (form.resultUnits.trim()) payload.resultUnits = form.resultUnits.trim();
    void transition(order, editor.step, payload);
  }

  async function acknowledge(order: CriticalPending) {
    if (busyId) return;
    setBusyId(order.id);
    try {
      await api('/hospital/orders/' + order.id + '/critical-ack', token, 'POST', {});
      alert('Recebimento do resultado crítico reconhecido e auditado.', 'success');
      void loadCritical();
      void load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      alert(message(e, 'Não foi possível registrar o reconhecimento.'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function generateDocument(order: DiagnosticOrder) {
    if (docBusyId) return;
    setDocBusyId(order.id);
    try {
      const created = await api<{ documentId: string; sha256: string; note?: string }>(
        '/hospital/orders/' + order.id + '/result-document', token, 'POST', {});
      setOrders(list => list.map(o => o.id === order.id ? { ...o, result_document_id: created.documentId } : o));
      alert(created.note || 'PDF do resultado gerado e versionado.', 'success');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      alert(message(e, 'Não foi possível gerar o PDF do resultado.'), 'error');
    } finally {
      setDocBusyId(null);
    }
  }

  /** Download BLOB com Bearer (nunca link público). Erros honestos do servidor:
   *  404 = PDF ainda não gerado; 500 = documento corrompido (hash divergente). */
  async function downloadDocument(order: DiagnosticOrder) {
    if (downloadId) return;
    setDownloadId(order.id);
    try {
      const response = await fetch(apiBase + '/hospital/orders/' + order.id + '/result-document', {
        method: 'GET', cache: 'no-store', headers: { Authorization: 'Bearer ' + token }
      });
      if (response.status === 401) { window.dispatchEvent(new Event(EVENT_SESSION_EXPIRED)); return; }
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        const text = data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
          ? (data as { message: string }).message : 'Falha ao baixar o PDF do resultado.';
        alert(text, 'error');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'resultado-' + order.id.slice(0, 8) + '.pdf';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert('Falha de rede ao baixar o PDF do resultado.', 'error');
    } finally {
      setDownloadId(null);
    }
  }

  /** Despacho LIS/PACS: a UI mostra a mensagem EXATA do servidor — se ele diz
   *  "desligada", mostramos "desligada" (nunca afirmamos conexão sem prova). */
  async function dispatch(order: DiagnosticOrder, channel: 'lis' | 'pacs') {
    if (dispatchBusyId) return;
    setDispatchBusyId(order.id);
    try {
      const result = await api<{ status: string; sandbox: boolean }>(
        '/hospital/orders/' + order.id + '/lis-dispatch', token, 'POST', { channel });
      setIntegration({
        text: `Canal ${channel.toUpperCase()}: item enfileirado e enviado — status "${result.status}"` +
          (result.sandbox ? ' (modo sandbox: resposta simulada, nenhum byte na rede).' : '.'),
        kind: 'success'
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setIntegration({ text: message(e, `Falha ao despachar para ${channel.toUpperCase()}.`), kind: 'error' });
    } finally {
      setDispatchBusyId(null);
    }
  }

  return (
    <div>
      {/* 3) Críticos pendentes de reconhecimento — tela de maior risco (J1 #12). */}
      {criticalPending.length > 0 && canAck && <div className="panel">
        <div className="panel-title"><h2><ShieldAlert size={18}/> Resultados críticos SEM reconhecimento</h2>
          <span className="small-pill">{criticalPending.length}</span></div>
        <p className="muted footnote">Notificação não conta como comunicação: o reconhecimento explícito abaixo é auditado com profissional, horário e correlação.</p>
        {criticalPending.map(order => <div className="list-line" key={order.id}>
          <FileText size={16}/>
          <span><strong>{order.description}</strong> · {order.order_type === 'imaging' ? 'Imagem' : 'Laboratório'} · {order.priority === 'urgent' ? 'urgente' : 'rotina'}<br/>
            <small className="muted">Status {statusLabel(order.status)} · {order.loinc_code ? 'LOINC ' + order.loinc_code + ' · ' : ''}Pedido em {fmt(order.ordered_at)}</small></span>
          <span className="small-pill">NÃO reconhecido</span>
          <button type="button" className="primary-button" disabled={busyId === order.id} onClick={() => void acknowledge(order)}>
            <ShieldAlert size={15}/> {busyId === order.id ? 'Registrando…' : 'Reconhecer (ack)'}
          </button>
        </div>)}
      </div>}

      <div className="panel">
        <div className="panel-title"><h2>Exames e resultados</h2>
          <button type="button" className="secondary-button" onClick={() => void load()}><RefreshCw size={15}/> Atualizar</button></div>
        <p className="muted footnote">Ciclo do pedido: pedido → aceito → coletado → preliminar → final → revisado → comunicado (cancelável antes do final). Resultado crítico exige reconhecimento antes de comunicar.</p>

        {/* 1) Filtros */}
        <div className="list-line">
          <select className="search-field" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filtrar por status">
            <option value="">Todos os status</option>
            {ALL_STATUSES.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </select>
          <select className="search-field" value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)} aria-label="Filtrar por prioridade">
            <option value="">Todas as prioridades</option>
            <option value="routine">Rotina</option>
            <option value="urgent">Urgente</option>
          </select>
          <label className="muted" htmlFor="res-only-critical"><input id="res-only-critical" type="checkbox" checked={onlyCritical} onChange={(e) => setOnlyCritical(e.target.checked)} /> só críticos</label>
        </div>

        {loading && <p className="muted" role="status">Carregando…</p>}
        {loadError && <div className="inline-error" role="alert"><AlertCircle size={16}/>{loadError}</div>}
        {!loading && !loadError && orders.length === 0 &&
          <div className="empty-state"><FileText size={28}/><p>Nenhum pedido diagnóstico.</p></div>}

        {/* 2) Lista + ações contextuais por transição */}
        {orders.map(order => <div key={order.id}>
          <div className="list-line">
            <FileText size={16}/>
            <span><strong>{order.description}</strong> · {order.order_type === 'imaging' ? 'Imagem' : 'Laboratório'} · {order.loinc_code ? 'LOINC ' + order.loinc_code : 'sem LOINC'}<br/>
              <small className="muted">{order.priority === 'urgent' ? 'Urgente' : 'Rotina'} · pedido em {fmt(order.ordered_at)}
                {order.result_value ? ' · resultado: ' + order.result_value + (order.result_units ? ' ' + order.result_units : '') : ''}</small></span>
            <span className="small-pill">{statusLabel(order.status)}</span>
            {order.critical && <span className="small-pill">{order.critical_ack_at ? 'crítico · reconhecido' : 'CRÍTICO · NÃO reconhecido'}</span>}
            {(NEXT[order.status] ?? []).map(to => <button key={to} type="button"
              className={to === 'cancelled' ? 'text-button' : 'secondary-button'}
              disabled={busyId === order.id} onClick={() => nextAction(order, to)}>
              {RESULT_STEPS.includes(to) ? 'Registrar ' + statusLabel(to).toLowerCase() : statusLabel(to)}
            </button>)}
            {canResult && RESULT_READY.includes(order.status) && <>
              <button type="button" className="secondary-button" disabled={docBusyId === order.id} onClick={() => void generateDocument(order)}>
                <FileText size={15}/> {docBusyId === order.id ? 'Gerando…' : (order.result_document_id ? 'Gerar PDF novamente' : 'Gerar PDF do resultado')}
              </button>
              <button type="button" className="secondary-button" disabled={downloadId === order.id} onClick={() => void downloadDocument(order)}>
                <Download size={15}/> {downloadId === order.id ? 'Baixando…' : 'Baixar PDF'}
              </button>
            </>}
            {canDispatch && <button type="button" className="secondary-button" disabled={dispatchBusyId === order.id} onClick={() => void dispatch(order, order.order_type === 'imaging' ? 'pacs' : 'lis')}>
              <Send size={15}/> Enviar para {order.order_type === 'imaging' ? 'PACS' : 'LIS'}
            </button>}
          </div>

          {editor && editor.id === order.id && <form className="list-line" onSubmit={confirmEditor}>
            {RESULT_STEPS.includes(editor.step) && <>
              <input className="search-field" placeholder="Valor do resultado (obrigatório)" value={form.resultValue}
                onChange={e => setForm(f => ({ ...f, resultValue: e.target.value }))} required/>
              <input className="search-field" placeholder="Valores de referência" value={form.resultReference}
                onChange={e => setForm(f => ({ ...f, resultReference: e.target.value }))}/>
              <input className="search-field" placeholder="Unidades" value={form.resultUnits}
                onChange={e => setForm(f => ({ ...f, resultUnits: e.target.value }))}/>
            </>}
            {editor.step === 'communicated' && <>
              <input className="search-field" placeholder="Como e para quem comunicado (ex.: Dra. Ana por telefone)"
                value={form.communicatedTo} onChange={e => setForm(f => ({ ...f, communicatedTo: e.target.value }))} required/>
              {order.critical && !order.critical_ack_at &&
                <p className="inline-error" role="alert"><AlertCircle size={16}/>Este resultado crítico ainda não foi reconhecido: comunique som depois do ack.</p>}
            </>}
            <button type="submit" className="primary-button" disabled={busyId === order.id}>
              {busyId === order.id ? 'Salvando…' : 'Confirmar ' + statusLabel(editor.step).toLowerCase()}
            </button>
            <button type="button" className="text-button" onClick={() => setEditor(null)}>Descartar</button>
          </form>}
        </div>)}
      </div>

      {/* 5) Integração LIS/PACS — estado honesto, sempre com a resposta do servidor. */}
      <div className="panel">
        <div className="panel-title"><h2>Integração com laboratório e imagem</h2></div>
        <p className="muted footnote">Desligada neste ambiente: nenhum pedido é enviado ao laboratório ou ao PACS até a integração ser configurada e homologada.</p>
        {integration && <p className={integration.kind === 'error' ? 'inline-error' : 'notice'} role={integration.kind === 'error' ? 'alert' : 'status'}>
          {integration.kind === 'error' && <AlertCircle size={16}/>}{integration.text}</p>}
        {!integration && <p className="muted">Nenhum despacho realizado nesta sessão — o estado "conectado" só é exibido com a confirmação do servidor.</p>}
      </div>
    </div>
  );
}
