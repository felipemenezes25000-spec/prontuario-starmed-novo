import { useEffect, useState, type FormEvent } from 'react';
import { Activity, BedDouble, CheckCircle2, ClipboardList, FileSignature, HeartPulse, Plus, ShieldCheck, Video, X } from 'lucide-react';
import { api, type Patient, type Session } from '../api';

/**
 * Páginas das frentes novas da API (teleconsulta, hospitalar, templates,
 * métricas/admin, LGPD). Cada componente gerencia seu próprio carregamento e
 * reusa as classes do design system do App (panel, list-line, small-pill…).
 */

type Alert = (text: string, kind?: 'success' | 'error' | 'info') => void;

function Empty({ icon: Icon, title, text }: { icon: typeof Activity; title: string; text: string }) {
  return <div className="empty-state"><Icon size={32}/><h2>{title}</h2><p>{text}</p></div>;
}

// ---------------------------------------------------------------- Teleconsulta
type TeleRoom = { id: string; status: string; recording_consent: boolean | null; created_at: string; lastSeq?: number };

export function TeleconsultPage({ session, alert }: { session: Session; alert: Alert }) {
  const token = session.accessToken;
  const isStaff = session.user.role === 'doctor' || session.user.role === 'nurse' || session.user.role === 'admin';
  const [encounterId, setEncounterId] = useState('');
  const [invite, setInvite] = useState<{ inviteCode: string; id: string } | null>(null);
  const [roomId, setRoomId] = useState('');
  const [consent, setConsent] = useState('true');
  const [room, setRoom] = useState<TeleRoom | null>(null);
  const [busy, setBusy] = useState(false);

  async function createRoom(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api<{ id: string; inviteCode: string; status: string }>('/teleconsult/rooms', token, 'POST', { encounterId });
      setInvite({ inviteCode: r.inviteCode, id: r.id });
      setRoomId(r.id);
      alert('Sala criada. Envie o código de convite ao paciente por canal seguro.', 'success');
    } catch (err) { alert((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  async function saveConsent(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api(`/teleconsult/rooms/${roomId}/consent`, token, 'POST', { recordingConsent: consent === 'true' });
      alert('Consentimento de gravação registrado.', 'success');
    } catch (err) { alert((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  async function loadRoom() {
    setBusy(true);
    try { setRoom(await api<TeleRoom>(`/teleconsult/rooms/${roomId}`, token)); }
    catch (err) { alert((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  return <section>
    <div className="page-heading"><div><span className="eyebrow">TELEMEDICINA</span><h1>Teleconsulta</h1>
      <p>Salas WebRTC com consentimento explícito de gravação e convite single-use do paciente.</p></div></div>
    {!isStaff ? <div className="panel"><Empty icon={Video} title="Área da equipe assistencial" text="Criação de salas é restrita a médicos, enfermagem e administradores."/></div> :
      <div className="content-grid">
        <div className="panel"><div className="panel-title"><h2>Nova sala</h2><Video size={19}/></div>
          <form className="stack gap-4" onSubmit={createRoom}>
            <label>Atendimento (UUID)<input required value={encounterId} onChange={e => setEncounterId(e.target.value)} placeholder="UUID do atendimento (consulte /encounters)"/></label>
            <button className="primary-button" disabled={busy} type="submit"><Plus size={16}/> Criar sala e convite</button>
          </form>
          {invite && <div className="clinical-chip" style={{ marginTop: 12 }}>
            <strong>Convite: {invite.inviteCode}</strong>
            <small>Sala {invite.id.slice(0, 8)} • válido por 6h • uso único. Envie por canal seguro (não é exibido de novo).</small>
          </div>}
          <p className="muted footnote">A mídia é peer-to-peer no navegador; o StarMed gerencia apenas sala, consentimento e sinalização.</p>
        </div>
        <div className="panel"><div className="panel-title"><h2>Consentimento de gravação</h2><ShieldCheck size={19}/></div>
          <form className="stack gap-3" onSubmit={saveConsent}>
            <label>Sala (UUID)<input required value={roomId} onChange={e => setRoomId(e.target.value)} placeholder="UUID da sala"/></label>
            <label>Consentimento<select value={consent} onChange={e => setConsent(e.target.value)}><option value="true">Aceito (pode gravar)</option><option value="false">Recusado (sem gravação)</option></select></label>
            <button className="secondary-button" disabled={busy} type="submit"><ShieldCheck size={15}/> Registrar consentimento</button>
          </form>
          <p className="muted footnote">Entrar na sala exige consentimento registrado (aceito OU recusado — nunca em aberto).</p>
        </div>
        <div className="panel"><div className="panel-title"><h2>Status da sala</h2><Activity size={19}/></div>
          <button className="secondary-button" disabled={busy || !roomId} onClick={() => void loadRoom()}>Consultar status</button>
          {room && <div className="clinical-chip" style={{ marginTop: 12 }}>
            <strong>{room.status === 'waiting' ? 'Aguardando entrada' : room.status === 'open' ? 'Em atendimento' : 'Encerrada'}</strong>
            <small>Consentimento: {room.recording_consent === null ? 'não registrado' : room.recording_consent ? 'aceito' : 'recusado'} • últimos sinais: {room.lastSeq ?? 0}</small>
          </div>}
        </div>
      </div>}
  </section>;
}

// ---------------------------------------------------------------- Hospitalar
type Bed = { id: string; label: string; status: string; ward_code: string };
type Order = { id: string; order_type: string; description: string; status: string; priority: string; ordered_at: string };

export function HospitalPage({ session, alert }: { session: Session; alert: Alert }) {
  const token = session.accessToken;
  const canWrite = ['admin', 'doctor', 'nurse'].includes(session.user.role);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [metrics, setMetrics] = useState<{ total: number; occupied: number; available: number; occupancyRate: number } | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [ward, setWard] = useState({ code: '', name: '' });
  const [orderForm, setOrderForm] = useState({ patientId: '', orderType: 'lab', description: '', priority: 'routine' });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [b, m, o] = await Promise.all([
        api<Bed[]>('/hospital/beds', token),
        api<typeof metrics>('/hospital/metrics/beds', token),
        api<Order[]>('/hospital/orders', token).catch(() => [] as Order[])
      ]);
      setBeds(b); setMetrics(m); setOrders(o);
    } catch (err) { alert((err as Error).message, 'error'); }
  };
  useEffect(() => { void load(); }, []);

  async function createWard(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const w = await api<{ id: string }>('/hospital/wards', token, 'POST', ward);
      const labels = prompt('Leitos (um por linha):', '01\n02\n03');
      if (labels) {
        await api(`/hospital/wards/${w.id}/beds`, token, 'POST', { labels: labels.split('\n').map(s => s.trim()).filter(Boolean) });
        alert('Ala e leitos criados.', 'success');
      }
      setWard({ code: '', name: '' });
      await load();
    } catch (err) { alert((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  async function createOrder(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api('/hospital/orders', token, 'POST', orderForm);
      alert('Pedido diagnóstico criado (lab/imaging).', 'success');
      setOrderForm({ patientId: '', orderType: 'lab', description: '', priority: 'routine' });
      await load();
    } catch (err) { alert((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  const bedColor = (s: string) => s === 'occupied' ? 'clinical-high' : 'small-pill';
  return <section>
    <div className="page-heading"><div><span className="eyebrow">HOSPITALAR</span><h1>Leitos e pedidos</h1>
      <p>Inventário de leitos com controle de dupla ocupação, admissões (ADT) e pedidos LIS/PACS.</p></div></div>
    <div className="stat-grid">
      <div className="stat-card"><BedDouble size={20}/><span>Leitos totais</span><strong>{metrics?.total ?? '—'}</strong><small>Inventário da organização</small></div>
      <div className="stat-card"><Activity size={20}/><span>Ocupação</span><strong>{metrics ? `${Math.round(metrics.occupancyRate * 100)}%` : '—'}</strong><small>{metrics?.occupied ?? '—'} ocupado(s)</small></div>
      <div className="stat-card"><ClipboardList size={20}/><span>Pedidos diagnósticos</span><strong>{orders.length}</strong><small>Lab e imagem</small></div>
    </div>
    <div className="content-grid">
      <div className="panel"><div className="panel-title"><h2>Leitos</h2><BedDouble size={19}/></div>
        {beds.length === 0 ? <Empty icon={BedDouble} title="Nenhum leito" text="Crie uma ala e cadastre os leitos ao lado."/> :
          beds.map(b => <div className="list-line" key={b.id}><div className="list-icon"><BedDouble size={18}/></div>
            <div><strong>{b.ward_code} • {b.label}</strong><small>{b.status === 'occupied' ? 'Ocupado' : b.status === 'available' ? 'Disponível' : b.status === 'cleaning' ? 'Limpeza' : 'Manutenção'}</small></div>
            <span className={bedColor(b.status)}>{b.status}</span></div>)}
      </div>
      {canWrite && <div className="panel"><div className="panel-title"><h2>Nova ala</h2><Plus size={19}/></div>
        <form className="stack gap-3" onSubmit={createWard}>
          <label>Código<input required value={ward.code} onChange={e => setWard({ ...ward, code: e.target.value })} placeholder="Ex.: UTI-1"/></label>
          <label>Nome<input required value={ward.name} onChange={e => setWard({ ...ward, name: e.target.value })} placeholder="Unidade de Internação 1"/></label>
          <button className="secondary-button" disabled={busy} type="submit"><Plus size={15}/> Criar ala e leitos</button>
        </form>
      </div>}
      {canWrite && <div className="panel"><div className="panel-title"><h2>Novo pedido diagnóstico</h2><Plus size={19}/></div>
        <form className="stack gap-3" onSubmit={createOrder}>
          <label>Paciente (UUID)<input required value={orderForm.patientId} onChange={e => setOrderForm({ ...orderForm, patientId: e.target.value })}/></label>
          <label>Tipo<select value={orderForm.orderType} onChange={e => setOrderForm({ ...orderForm, orderType: e.target.value })}><option value="lab">Laboratório</option><option value="imaging">Imagem (PACS)</option></select></label>
          <label>Descrição<input required minLength={3} value={orderForm.description} onChange={e => setOrderForm({ ...orderForm, description: e.target.value })} placeholder="Ex.: Hemograma completo"/></label>
          <label>Prioridade<select value={orderForm.priority} onChange={e => setOrderForm({ ...orderForm, priority: e.target.value })}><option value="routine">Rotina</option><option value="urgent">Urgente</option></select></label>
          <button className="primary-button" disabled={busy} type="submit"><Plus size={15}/> Registrar pedido</button>
        </form>
      </div>}
      <div className="panel"><div className="panel-title"><h2>Pedidos recentes</h2><ClipboardList size={19}/></div>
        {orders.length === 0 ? <p className="muted empty-state">Nenhum pedido registrado.</p> :
          orders.slice(0, 12).map(o => <div className="list-line" key={o.id}><div className="list-icon"><ClipboardList size={18}/></div>
            <div><strong>{o.description}</strong><small>{o.order_type === 'lab' ? 'Lab' : 'Imagem'} • {new Date(o.ordered_at).toLocaleDateString('pt-BR')}</small></div>
            <span className="small-pill">{o.status}</span></div>)}
      </div>
    </div>
  </section>;
}

// ---------------------------------------------------------------- Templates
type Template = { id: string; code: string; name: string; specialty: string; version: number; status: string };

export function TemplatesPage({ session, alert }: { session: Session; alert: Alert }) {
  const token = session.accessToken;
  const [templates, setTemplates] = useState<Template[]>([]);
  const [form, setForm] = useState({ code: '', name: '', specialty: 'general' });
  const [busy, setBusy] = useState(false);
  const load = () => api<Template[]>('/product/templates', token).then(setTemplates).catch(e => alert(e.message, 'error'));
  useEffect(() => { void load(); }, []);

  async function createTemplate(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api('/product/templates', token, 'POST', {
        ...form,
        sections: { evolucao: { label: 'Evolução', required: true, maxLength: 5000 } }
      });
      alert('Template criado como rascunho.', 'success');
      setForm({ code: '', name: '', specialty: 'general' });
      await load();
    } catch (err) { alert((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  async function publish(id: string) {
    try { await api(`/product/templates/${id}/publish`, token, 'PUT'); alert('Template publicado.', 'success'); await load(); }
    catch (err) { alert((err as Error).message, 'error'); }
  }
  const canManage = session.user.role === 'admin' || session.user.role === 'doctor';
  return <section>
    <div className="page-heading"><div><span className="eyebrow">PRODUTO</span><h1>Templates clínicos</h1>
      <p>Estruturas de prontuário versionadas por especialidade (rascunho → publicado).</p></div></div>
    <div className="content-grid">
      <div className="panel"><div className="panel-title"><h2>Templates</h2><FileSignature size={19}/></div>
        {templates.length === 0 ? <Empty icon={FileSignature} title="Nenhum template" text="Crie o primeiro template ao lado."/> :
          templates.map(t => <div className="list-line" key={t.id}><div className="list-icon"><FileSignature size={18}/></div>
            <div><strong>{t.name}</strong><small>{t.code} • {t.specialty} • v{t.version}</small></div>
            {t.status === 'draft' && canManage
              ? <button className="secondary-button" onClick={() => void publish(t.id)}>Publicar</button>
              : <span className={'small-pill ' + (t.status === 'published' ? 'pill-signed' : '')}>{t.status === 'published' ? 'Publicado' : 'Rascunho'}</span>}
          </div>)}
      </div>
      {canManage && <div className="panel"><div className="panel-title"><h2>Novo template</h2><Plus size={19}/></div>
        <form className="stack gap-3" onSubmit={createTemplate}>
          <label>Código<input required value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="evolucao-cardio"/></label>
          <label>Nome<input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Evolução Cardiológica"/></label>
          <label>Especialidade<select value={form.specialty} onChange={e => setForm({ ...form, specialty: e.target.value })}>
            <option value="general">Geral</option><option value="cardiology">Cardiologia</option><option value="orthopedics">Ortopedia</option>
            <option value="pediatrics">Pediatria</option><option value="neurology">Neurologia</option><option value="psychiatry">Psiquiatria</option></select></label>
          <button className="primary-button" disabled={busy} type="submit"><Plus size={15}/> Criar rascunho</button>
        </form>
      </div>}
    </div>
  </section>;
}

// ---------------------------------------------------------------- Métricas / Admin
export function MetricsPage({ session, alert }: { session: Session; alert: Alert }) {
  const token = session.accessToken;
  const isAdmin = session.user.role === 'admin';
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [matrix, setMatrix] = useState<Record<string, string[]> | null>(null);
  const [settings, setSettings] = useState<{ ai_enabled: boolean; require_mfa_for_admins: boolean; teleconsult_default_minutes: number } | null>(null);

  useEffect(() => {
    api<Record<string, unknown>>('/product/metrics/summary', token).then(setSummary).catch(e => alert(e.message, 'error'));
    if (isAdmin) {
      api<Record<string, string[]>>('/product/admin/rbac/matrix', token).then(setMatrix).catch(() => setMatrix(null));
      api<typeof settings>('/product/admin/settings', token).then(setSettings).catch(() => setSettings(null));
    }
  }, []);

  async function toggleSetting(key: 'ai_enabled' | 'require_mfa_for_admins') {
    if (!settings) return;
    try {
      const updated = await api<typeof settings>('/product/admin/settings', token, 'PATCH', {
        [key === 'ai_enabled' ? 'aiEnabled' : 'requireMfaForAdmins']: !settings[key]
      });
      setSettings(updated); alert('Ajuste salvo.', 'success');
    } catch (err) { alert((err as Error).message, 'error'); }
  }
  const enc = summary?.encounters as Record<string, unknown> | undefined;
  const mfa = summary?.mfaAdoption as { enabled: number; total: number } | undefined;
  return <section>
    <div className="page-heading"><div><span className="eyebrow">OBSERVABILIDADE</span><h1>Métricas e administração</h1>
      <p>Indicadores da organização, matriz de permissões e ajustes.</p></div></div>
    <div className="stat-grid">
      <div className="stat-card"><Activity size={20}/><span>Atendimentos</span><strong>{enc ? String(enc.total) : '—'}</strong><small>{enc ? `${enc.finished} concluído(s)` : 'carregando'}</small></div>
      <div className="stat-card"><HeartPulse size={20}/><span>Pacientes</span><strong>{summary ? String(summary.patientsTotal) : '—'}</strong><small>Cadastros da organização</small></div>
      <div className="stat-card"><ShieldCheck size={20}/><span>Adoção de MFA</span><strong>{mfa ? `${mfa.enabled}/${mfa.total}` : '—'}</strong><small>Usuários com segundo fator</small></div>
    </div>
    <div className="content-grid">
      {isAdmin && settings && <div className="panel"><div className="panel-title"><h2>Ajustes</h2><ShieldCheck size={19}/></div>
        <div className="list-line"><div><strong>IA habilitada</strong><small>Provedor precisa estar configurado no servidor</small></div>
          <button className="secondary-button" onClick={() => void toggleSetting('ai_enabled')}>{settings.ai_enabled ? 'Desativar' : 'Ativar'}</button></div>
        <div className="list-line"><div><strong>MFA obrigatório p/ admins</strong><small>Exigência de segundo fator no login</small></div>
          <button className="secondary-button" onClick={() => void toggleSetting('require_mfa_for_admins')}>{settings.require_mfa_for_admins ? 'Desativar' : 'Ativar'}</button></div>
        <div className="list-line"><div><strong>Teleconsulta padrão</strong><small>{settings.teleconsult_default_minutes} minutos</small></div></div>
      </div>}
      {isAdmin && matrix && <div className="panel"><div className="panel-title"><h2>Matriz RBAC</h2><ShieldCheck size={19}/></div>
        {Object.entries(matrix).map(([role, perms]) => <div className="clinical-chip" key={role}><strong>{role}</strong><small>{perms.length} permissões</small></div>)}
        <p className="muted footnote">Matriz completa em GET /product/admin/rbac/matrix; validada por teste (toda permissão coberta, todo papel ativo).</p>
      </div>}
    </div>
  </section>;
}

// ---------------------------------------------------------------- LGPD
type LgpdRequest = { id: string; kind: string; status: string; due_at: string; created_at: string };

export function LgpdPage({ session, patients, alert }: { session: Session; patients: Patient[]; alert: Alert }) {
  const token = session.accessToken;
  const [requests, setRequests] = useState<LgpdRequest[]>([]);
  const [form, setForm] = useState({ patientId: '', kind: 'access' });
  const [consentForm, setConsentForm] = useState({ patientId: '', purpose: 'research', granted: 'false' });
  const [busy, setBusy] = useState(false);
  const load = () => api<LgpdRequest[]>('/lgpd/requests', token).then(setRequests).catch(e => alert(e.message, 'error'));
  useEffect(() => { void load(); }, []);

  async function createRequest(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api('/lgpd/requests', token, 'POST', form);
      alert('Pedido de titular registrado (prazo legal rastreado).', 'success');
      setForm({ patientId: '', kind: 'access' });
      await load();
    } catch (err) { alert((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  async function recordConsent(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api('/lgpd/consents', token, 'POST', { ...consentForm, granted: consentForm.granted === 'true' });
      alert('Consentimento registrado (opt-in versionado).', 'success');
    } catch (err) { alert((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  const kindLabel: Record<string, string> = {
    access: 'Acesso', portability: 'Portabilidade', correction: 'Correção',
    deletion: 'Exclusão', anonymization: 'Anonimização', consent_revocation: 'Revogação de consentimento'
  };
  return <section>
    <div className="page-heading"><div><span className="eyebrow">LGPD / ANPD</span><h1>Direitos do titular</h1>
      <p>Pedidos com prazo rastreado (até 15 dias), consentimento opt-in e trilha auditável.</p></div></div>
    <div className="content-grid">
      <div className="panel"><div className="panel-title"><h2>Pedidos</h2><FileSignature size={19}/></div>
        {requests.length === 0 ? <Empty icon={FileSignature} title="Nenhum pedido" text="Registre o primeiro pedido ao lado."/> :
          requests.map(r => <div className="list-line" key={r.id}><div className="list-icon"><FileSignature size={18}/></div>
            <div><strong>{kindLabel[r.kind] ?? r.kind}</strong><small>vence {new Date(r.due_at).toLocaleDateString('pt-BR')}</small></div>
            <span className={'small-pill ' + (r.status === 'completed' ? 'pill-signed' : '')}>{r.status === 'completed' ? 'Atendido' : r.status === 'refused' ? 'Recusado' : 'Pendente'}</span></div>)}
      </div>
      <div className="panel"><div className="panel-title"><h2>Novo pedido</h2><Plus size={19}/></div>
        <form className="stack gap-3" onSubmit={createRequest}>
          <label>Paciente<select required value={form.patientId} onChange={e => setForm({ ...form, patientId: e.target.value })}><option value="">Selecione</option>{patients.map(p => <option key={p.id} value={p.id}>{p.fullName}</option>)}</select></label>
          <label>Direito exercido<select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
            <option value="access">Acesso (cópia dos dados)</option><option value="portability">Portabilidade</option>
            <option value="correction">Correção</option><option value="deletion">Exclusão</option>
            <option value="anonymization">Anonimização</option><option value="consent_revocation">Revogação de consentimento</option></select></label>
          <button className="primary-button" disabled={busy} type="submit"><Plus size={15}/> Registrar pedido</button>
        </form>
        <p className="muted footnote">Exclusão de prontuário com documentos assinados é recusada com fundamento no art. 16/I (obrigação legal) — a resposta é auditada.</p>
      </div>
      <div className="panel"><div className="panel-title"><h2>Consentimento</h2><ShieldCheck size={19}/></div>
        <form className="stack gap-3" onSubmit={recordConsent}>
          <label>Paciente<select required value={consentForm.patientId} onChange={e => setConsentForm({ ...consentForm, patientId: e.target.value })}><option value="">Selecione</option>{patients.map(p => <option key={p.id} value={p.id}>{p.fullName}</option>)}</select></label>
          <label>Finalidade<select value={consentForm.purpose} onChange={e => setConsentForm({ ...consentForm, purpose: e.target.value })}>
            <option value="treatment">Tratamento</option><option value="research">Pesquisa</option>
            <option value="marketing">Marketing</option><option value="ai_training">Treinamento de IA</option>
            <option value="third_party_sharing">Compartilhamento com terceiros</option></select></label>
          <label>Decisão<select value={consentForm.granted} onChange={e => setConsentForm({ ...consentForm, granted: e.target.value })}><option value="true">Concedido</option><option value="false">Revogado</option></select></label>
          <button className="secondary-button" disabled={busy} type="submit"><ShieldCheck size={15}/> Registrar</button>
        </form>
      </div>
    </div>
  </section>;
}

export const FrontIcons = { Video, BedDouble, FileSignature, ClipboardList, ShieldCheck, X, CheckCircle2 };
