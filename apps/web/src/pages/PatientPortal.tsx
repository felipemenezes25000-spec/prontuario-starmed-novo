import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, CalendarDays, CheckCircle2, ClipboardList, FileSignature, HeartPulse, LockKeyhole, LogOut, Plus, ShieldCheck, WifiOff, X } from 'lucide-react';
import { ApiError } from '../api';

/**
 * Área do paciente (portal do paciente, D8 / ST-P1-008) — SEGREGADA da UI de
 * equipe. Sessão própria em sessionStorage ('starmed:portal-session'), nunca
 * misturada com a Session clínica da equipe. Contratos (apps/api/src/portal.ts
 * e PatientLgpdController em apps/api/src/lgpd.ts):
 *   POST /portal/activate             {inviteCode,email,password} → {activated,accessToken}
 *   POST /portal/login                {email,password}            → {accessToken,patient:{id}}
 *   GET  /portal/appointments                                     → consultas do próprio paciente
 *   GET  /portal/documents                                        → documentos assinados do próprio paciente
 *   POST /portal/appointment-requests {preferredSpecialty,preferredPeriod,notes?}
 *   POST /portal/me/lgpd/requests     {kind,channel,deadlineDays}
 *   GET  /portal/me/consents          → [{purpose,granted,created_at}]
 *   POST /portal/me/consents          {purpose,granted}
 * As chamadas usam um fetch próprio (portalCall): NÃO disparam
 * EVENT_SESSION_EXPIRED, que é exclusivo da sessão clínica da equipe. Um 401/403
 * do token do portal volta ao login do portal com aviso não-técnico. Nada de
 * dados pessoais em query string/URL: token no header e parâmetros no corpo.
 * Documentos NÃO viram links: são listados só com o token — nada é acessível
 * por posse de URL.
 */

// Mesmo host de apps/web/src/api.ts (o helper api() é da sessão da equipe e
// dispara o evento de expiração clínica — por isso o fetch próprio aqui).
const base=(import.meta.env.VITE_API_URL||'http://localhost:3001').replace(/\/$/,'');
const SESSION_KEY='starmed:portal-session';
const NETWORK='Não foi possível conectar ao StarMed. Tente novamente.';
const OFFLINE='Você está sem conexão. Verifique sua internet e tente novamente.';

type PortalSession={accessToken:string};
type PortalAppointment={id:string;scheduled_at:string;duration_minutes:number;status:string;kind:string;practitioner:string};
type PortalDocument={id:string;template_id:string;signed_at:string|null;version:number};
type Consent={purpose:string;granted:boolean;created_at:string};
type PortalLgpdRequest={id:string;kind:string;status:string;due_at:string};
type AppointmentRequest={id:string;status:string;created_at:string};

/** Fetch do portal: igual ao api() da equipe, mas sem disparar o evento de sessão clínica. */
async function portalCall<T>(path:string,token:string|null,method='GET',body?:unknown):Promise<T>{
  const response=await fetch(base+path,{
    method,cache:'no-store',headers:{
      'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})
    },
    body:body===undefined?undefined:JSON.stringify(body)
  });
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new ApiError(response.status,typeof data?.message==='string'?data.message:JSON.stringify(data?.message||'Falha na API'));
  return data as T;
}

function loadStoredSession():PortalSession|null{
  try{
    const raw=window.sessionStorage.getItem(SESSION_KEY);
    if(!raw)return null;
    const parsed=JSON.parse(raw) as PortalSession;
    return typeof parsed.accessToken==='string'&&parsed.accessToken?parsed:null;
  }catch{return null;}
}
function saveStoredSession(s:PortalSession){try{window.sessionStorage.setItem(SESSION_KEY,JSON.stringify(s));}catch{/* armazenamento indisponível: a sessão vive só em memória */}}
function clearStoredSession(){try{window.sessionStorage.removeItem(SESSION_KEY);}catch{/* sem armazenamento: nada a limpar */}}

const SPECIALTIES=[{value:'general',label:'Clínica geral'},{value:'cardiology',label:'Cardiologia'},{value:'orthopedics',label:'Ortopedia'},{value:'pediatrics',label:'Pediatria'},{value:'neurology',label:'Neurologia'},{value:'psychiatry',label:'Psiquiatria'}];
const PERIODS=[{value:'morning',label:'Manhã'},{value:'afternoon',label:'Tarde'},{value:'any',label:'Qualquer horário'}];
const LGPD_KINDS=[
  {value:'access',label:'Acesso aos meus dados'},{value:'portability',label:'Copiar meus dados (portabilidade)'},
  {value:'correction',label:'Corrigir meus dados'},{value:'deletion',label:'Excluir meus dados'},
  {value:'anonymization',label:'Anonimizar meus dados'},{value:'consent_revocation',label:'Revogar consentimentos'}
];
const PURPOSES=[
  {value:'treatment',label:'Cuidado e tratamento'},{value:'research',label:'Pesquisa em saúde'},
  {value:'marketing',label:'Comunicações promocionais'},{value:'ai_training',label:'Treinamento de inteligência artificial'},
  {value:'third_party_sharing',label:'Compartilhamento com parceiros'}
];
const APPOINTMENT_STATUS:Record<string,string>={scheduled:'Agendada',confirmed:'Confirmada',completed:'Concluída',done:'Concluída',cancelled:'Cancelada',canceled:'Cancelada',no_show:'Não compareceu'};
const APPOINTMENT_KIND:Record<string,string>={consultation:'Consulta',teleconsultation:'Teleconsulta',procedure:'Procedimento',exam:'Exame'};
const REQUEST_STATUS:Record<string,string>={requested:'Recebida',in_progress:'Em análise',completed:'Concluída',refused:'Recusada'};

const fmt=(v:string)=>new Date(v).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'});
const fmtDay=(v:string)=>new Date(v).toLocaleDateString('pt-BR',{dateStyle:'long'});
const protocol=(id:string)=>id.slice(0,8);

/** Erros do login/ativação em linguagem amigável (nada técnico para o público leigo). */
function authErrorText(e:unknown,mode:'login'|'activate'):string{
  if(e instanceof ApiError){
    if(e.status===401)return mode==='login'?'E-mail ou senha não reconhecidos. Confira os dados e tente novamente.'
      :'O código do convite é inválido ou já foi usado. Peça um novo à clínica.';
    if(e.status===400)return mode==='login'?'Confira o e-mail e a senha digitados.'
      :'Confira o código do convite, o e-mail e a senha (mínimo de 12 caracteres).';
    if(e.status>=500)return 'O StarMed está instável no momento. Tente novamente em instantes.';
    return 'Não foi possível concluir agora. Tente novamente.';
  }
  return navigator.onLine?NETWORK:OFFLINE;
}
/** Erros das seções autenticadas — mensagens simples, sem detalhes técnicos. */
function sectionErrorText(e:unknown):string{
  if(e instanceof ApiError)return e.status>=500?'O StarMed está instável no momento. Tente novamente em instantes.'
    :'Não foi possível concluir agora. Tente novamente em instantes.';
  return navigator.onLine?NETWORK:OFFLINE;
}
/** 401/403 com token do portal → a sessão do paciente não vale mais: sai do painel. */
function portalAuthFailed(e:unknown,onAuthFail:()=>void):boolean{
  if(e instanceof ApiError&&(e.status===401||e.status===403)){onAuthFail();return true;}
  return false;
}

function InlineError({text}:{text:string}){
  return <div className="inline-error" role="alert"><AlertCircle size={16}/>{text}</div>;
}

/* -------------------------------------------------------------------------
 * Tela pública: ativação de convite + login do paciente (POST /portal/*).
 * ---------------------------------------------------------------------- */
function PortalAuth({onAuthenticated,notice,onBack}:{onAuthenticated:(s:PortalSession)=>void;notice?:string;onBack?:()=>void}){
  const [mode,setMode]=useState<'login'|'activate'>('login');
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[inviteCode,setInviteCode]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const loginFirstRef=useRef<HTMLInputElement>(null),activateFirstRef=useRef<HTMLInputElement>(null);
  // Troca de aba move o foco ao primeiro campo da aba escolhida (teclado/leitor de tela).
  const firstRun=useRef(true);
  useEffect(()=>{
    if(firstRun.current){firstRun.current=false;return;}
    const id=window.setTimeout(()=>{(mode==='login'?loginFirstRef:activateFirstRef).current?.focus();},0);
    return ()=>window.clearTimeout(id);
  },[mode]);
  // Aviso de sessão encerrada (logout/expiração) → foco no formulário de login.
  useEffect(()=>{
    if(!notice)return;
    const id=window.setTimeout(()=>loginFirstRef.current?.focus(),0);
    return ()=>window.clearTimeout(id);
  },[notice]);
  async function submitLogin(e:FormEvent){
    e.preventDefault();setBusy(true);setError('');
    try{
      const r=await portalCall<{accessToken?:string}>('/portal/login',null,'POST',{email,password});
      if(r.accessToken)onAuthenticated({accessToken:r.accessToken});
      else setError('Não foi possível entrar agora. Tente novamente.');
    }catch(err){setError(authErrorText(err,'login'));}
    finally{setBusy(false);}
  }
  async function submitActivate(e:FormEvent){
    e.preventDefault();setBusy(true);setError('');
    try{
      const r=await portalCall<{activated?:boolean;accessToken?:string}>('/portal/activate',null,'POST',{inviteCode,email,password});
      if(r.activated&&r.accessToken)onAuthenticated({accessToken:r.accessToken});
      else setError('Não foi possível concluir a ativação. Tente novamente.');
    }catch(err){setError(authErrorText(err,'activate'));}
    finally{setBusy(false);}
  }
  return <div className="login-layout">
    <div className="login-illustration">
      <div className="brand-row"><div className="brand-mark"><HeartPulse size={22} strokeWidth={2.5}/></div><span>StarMed</span></div>
      <div className="intro-copy"><span className="eyebrow-light">ÁREA DO PACIENTE</span>
        <h1>Seu cuidado,<br/>na palma da mão.</h1>
        <p>Consulte suas consultas, acompanhe seus documentos e cuide da sua privacidade com segurança.</p></div>
      <div className="login-foot"><ShieldCheck size={19}/> Seus dados de saúde são tratados com privacidade (LGPD)</div>
    </div>
    <div className="login-form-shell"><div className="login-panel">
      <div className="small-icon">{mode==='login'?<LockKeyhole size={23}/>:<ClipboardList size={23}/>}</div>
      <h2>{mode==='login'?'Entre na sua área':'Ative seu acesso'}</h2>
      <p>{mode==='login'?'Use o e-mail e a senha que você criou com o convite da clínica.':'Use o código de convite recebido da clínica para criar seu acesso.'}</p>
      {notice&&<div className="notice info" role="status"><AlertCircle size={17}/><span>{notice}</span></div>}
      <div className="mfa-modes" role="group" aria-label="Escolha como acessar sua área">
        <button type="button" className={'mode-button'+(mode==='login'?' active':'')} aria-pressed={mode==='login'} onClick={()=>{setMode('login');setError('');}}>Entrar</button>
        <button type="button" className={'mode-button'+(mode==='activate'?' active':'')} aria-pressed={mode==='activate'} onClick={()=>{setMode('activate');setError('');}}>Ativar convite</button>
      </div>
      {mode==='login'?<form onSubmit={submitLogin} className="stack gap-4 mt-8">
        <label>E-mail<input ref={loginFirstRef} required type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} placeholder="voce@email.com"/></label>
        <label>Senha<input required type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Sua senha"/></label>
        {error&&<InlineError text={error}/>}
        <button disabled={busy} className="primary-button" type="submit">{busy?'Entrando…':'Entrar na minha área'}</button>
      </form>:<form onSubmit={submitActivate} className="stack gap-4 mt-8">
        <label>Código de convite<input ref={activateFirstRef} required value={inviteCode} maxLength={64} spellCheck={false} autoComplete="off"
          onChange={e=>setInviteCode(e.target.value.toUpperCase())} placeholder="Cole o código recebido da clínica"/></label>
        <label>E-mail<input required type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} placeholder="voce@email.com"/></label>
        <label>Nova senha (mínimo de 12 caracteres)<input required type="password" minLength={12} autoComplete="new-password" value={password}
          onChange={e=>setPassword(e.target.value)} placeholder="Crie uma senha segura"/></label>
        {error&&<InlineError text={error}/>}
        <button disabled={busy} className="primary-button" type="submit">{busy?'Ativando…':'Ativar e entrar'}</button>
      </form>}
      {onBack&&<button type="button" className="text-button mfa-back" onClick={onBack}>Acesso da equipe (profissionais)</button>}
      <p className="security-note">Ambiente inicial de desenvolvimento. Não insira dados reais antes da homologação de segurança e privacidade.</p>
    </div></div>
  </div>;
}

/* -------------------------------------------------------------------------
 * Painel autenticado — consultas do próprio paciente.
 * ---------------------------------------------------------------------- */
function AppointmentsPanel({token,onAuthFail}:{token:string;onAuthFail:()=>void}){
  const [items,setItems]=useState<PortalAppointment[]|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  async function load(){
    setLoading(true);setError('');
    try{
      const rows=await portalCall<PortalAppointment[]>('/portal/appointments',token);
      const now=Date.now();
      const future=rows.filter(a=>new Date(a.scheduled_at).getTime()>=now).sort((x,y)=>new Date(x.scheduled_at).getTime()-new Date(y.scheduled_at).getTime());
      const past=rows.filter(a=>new Date(a.scheduled_at).getTime()<now).sort((x,y)=>new Date(y.scheduled_at).getTime()-new Date(x.scheduled_at).getTime());
      setItems([...future,...past]);
    }catch(e){
      if(portalAuthFailed(e,onAuthFail))return;
      setItems(null);setError(sectionErrorText(e));
    }finally{setLoading(false);}
  }
  useEffect(()=>{void load();},[]);
  return <div className="panel">
    <div className="panel-title"><h2>Minhas consultas</h2>{items&&<span className="small-pill">{items.length} {items.length===1?'consulta':'consultas'}</span>}</div>
    {loading&&<p className="muted" role="status">Carregando suas consultas…</p>}
    {!loading&&error&&<div className="stack gap-3"><InlineError text={error}/>
      <div><button type="button" className="secondary-button" onClick={()=>void load()}>Tentar novamente</button></div></div>}
    {!loading&&!error&&(items?.length===0)&&<p className="muted empty-state">Você ainda não tem consultas agendadas.</p>}
    {!loading&&!error&&(items?.length??0)>0&&<div>
      {items!.map(a=><div className="list-line" key={a.id}>
        <div className="list-icon"><CalendarDays size={18}/></div>
        <div><strong>{a.practitioner||'Profissional da clínica'}</strong>
          <small>{fmt(a.scheduled_at)} • {APPOINTMENT_KIND[a.kind]||a.kind} • {a.duration_minutes} min</small></div>
        <span className="small-pill">{APPOINTMENT_STATUS[a.status]||a.status}</span>
      </div>)}
    </div>}
  </div>;
}

/* -------------------------------------------------------------------------
 * Painel autenticado — pedir um novo agendamento (POST /portal/appointment-requests).
 * ---------------------------------------------------------------------- */
function RequestAppointmentPanel({token,onAuthFail}:{token:string;onAuthFail:()=>void}){
  const [form,setForm]=useState({specialty:'general',period:'any',notes:''});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [done,setDone]=useState('');
  async function submit(e:FormEvent){
    e.preventDefault();setBusy(true);setError('');setDone('');
    try{
      const created=await portalCall<AppointmentRequest>('/portal/appointment-requests',token,'POST',
        {preferredSpecialty:form.specialty,preferredPeriod:form.period,notes:form.notes.trim()||undefined});
      setDone('Pedido enviado! Protocolo '+protocol(created.id)+'. A clínica vai analisar e entrar em contato.');
      setForm({specialty:'general',period:'any',notes:''});
    }catch(err){
      if(portalAuthFailed(err,onAuthFail))return;
      setError(sectionErrorText(err));
    }finally{setBusy(false);}
  }
  return <div className="panel">
    <div className="panel-title"><h2>Pedir agendamento</h2><Plus size={19}/></div>
    <p className="muted">Conte quando você prefere ser atendido. A equipe confirma o horário depois.</p>
    {done&&<div className="notice success" role="status"><CheckCircle2 size={17}/><span>{done}</span>
      <button aria-label="Fechar aviso" onClick={()=>setDone('')}><X size={17}/></button></div>}
    <form className="stack gap-4" onSubmit={submit}>
      <label>Especialidade desejada<select value={form.specialty} onChange={e=>setForm({...form,specialty:e.target.value})}>
        {SPECIALTIES.map(s=><option key={s.value} value={s.value}>{s.label}</option>)}</select></label>
      <label>Período preferido<select value={form.period} onChange={e=>setForm({...form,period:e.target.value})}>
        {PERIODS.map(p=><option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
      <label>Orientações para a clínica (opcional)<textarea maxLength={1000} rows={3} value={form.notes}
        onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Ex.: prefiro depois das 14h"/></label>
      {error&&<InlineError text={error}/>}
      <div className="action-row">
        <button type="submit" className="primary-button" disabled={busy}><Plus size={16}/>{busy?'Enviando…':'Enviar pedido'}</button>
      </div>
    </form>
  </div>;
}

/* -------------------------------------------------------------------------
 * Painel autenticado — documentos assinados (GET /portal/documents).
 * Listagem apenas com o token; sem links: nada é acessível por posse de URL.
 * ---------------------------------------------------------------------- */
function DocumentsPanel({token,onAuthFail}:{token:string;onAuthFail:()=>void}){
  const [items,setItems]=useState<PortalDocument[]|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  async function load(){
    setLoading(true);setError('');
    try{setItems(await portalCall<PortalDocument[]>('/portal/documents',token));}
    catch(e){
      if(portalAuthFailed(e,onAuthFail))return;
      setItems(null);setError(sectionErrorText(e));
    }finally{setLoading(false);}
  }
  useEffect(()=>{void load();},[]);
  // template_id pode ser um identificador técnico; só mostro texto quando é legível.
  const title=(t:string)=>/^[0-9a-f-]{8,}$/i.test(t)?'Documento assinado':(t||'Documento assinado');
  return <div className="panel">
    <div className="panel-title"><h2>Meus documentos</h2>{items&&<span className="small-pill">{items.length} {items.length===1?'documento':'documentos'}</span>}</div>
    {loading&&<p className="muted" role="status">Carregando seus documentos…</p>}
    {!loading&&error&&<div className="stack gap-3"><InlineError text={error}/>
      <div><button type="button" className="secondary-button" onClick={()=>void load()}>Tentar novamente</button></div></div>}
    {!loading&&!error&&(items?.length===0)&&<p className="muted empty-state">Nenhum documento disponível por enquanto.</p>}
    {!loading&&!error&&(items?.length??0)>0&&<div>
      {items!.map(d=><div className="list-line" key={d.id}>
        <div className="list-icon"><FileSignature size={18}/></div>
        <div><strong>{title(d.template_id)}</strong><small>{d.signed_at?'Assinado em '+fmtDay(d.signed_at):'Documento assinado'}</small></div>
        <span className="small-pill">versão {d.version}</span>
      </div>)}
    </div>}
    <p className="muted footnote"><strong>Recurso indisponível:</strong> a abertura do conteúdo dos documentos ainda não existe nesta versão do portal — fale com a clínica para receber uma cópia.</p>
  </div>;
}

/* -------------------------------------------------------------------------
 * Painel autenticado — solicitações LGPD (POST /portal/me/lgpd/requests).
 * ---------------------------------------------------------------------- */
function LgpdRequestsPanel({token,onAuthFail}:{token:string;onAuthFail:()=>void}){
  const [kind,setKind]=useState('access');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [created,setCreated]=useState<PortalLgpdRequest[]>([]);
  async function submit(e:FormEvent){
    e.preventDefault();setBusy(true);setError('');
    try{
      const r=await portalCall<PortalLgpdRequest>('/portal/me/lgpd/requests',token,'POST',{kind,channel:'portal'});
      setCreated(prev=>[r,...prev]);
    }catch(err){
      if(portalAuthFailed(err,onAuthFail))return;
      setError(sectionErrorText(err));
    }finally{setBusy(false);}
  }
  return <div className="panel">
    <div className="panel-title"><h2>Solicitações de privacidade</h2><ShieldCheck size={19}/></div>
    <p className="muted">Você pode pedir acesso, correção ou exclusão dos seus dados. A clínica responde dentro do prazo da lei.</p>
    <div className="notice info" role="status"><AlertCircle size={17}/><span><strong>Recurso indisponível:</strong> ainda não é possível consultar o histórico das suas solicitações pelo portal.</span></div>
    {created.length>0&&<div>
      <span className="eyebrow">FEITAS AGORA (NESTA SESSÃO)</span>
      <div>{created.map(r=><div className="list-line" key={r.id}>
        <div className="list-icon"><ClipboardList size={18}/></div>
        <div><strong>{(LGPD_KINDS.find(k=>k.value===r.kind)||{label:r.kind}).label}</strong>
          <small>Protocolo {protocol(r.id)} • resposta até {fmt(r.due_at)}</small></div>
        <span className="small-pill">{REQUEST_STATUS[r.status]||r.status}</span>
      </div>)}</div>
    </div>}
    <form className="stack gap-4" onSubmit={submit}>
      <label>O que você deseja fazer<select value={kind} onChange={e=>setKind(e.target.value)}>
        {LGPD_KINDS.map(k=><option key={k.value} value={k.value}>{k.label}</option>)}</select></label>
      {error&&<InlineError text={error}/>}
      <div className="action-row">
        <button type="submit" className="primary-button" disabled={busy}><ShieldCheck size={16}/>{busy?'Enviando…':'Enviar solicitação'}</button>
      </div>
    </form>
  </div>;
}

/* -------------------------------------------------------------------------
 * Painel autenticado — consentimentos (GET/POST /portal/me/consents).
 * ---------------------------------------------------------------------- */
function ConsentsPanel({token,onAuthFail}:{token:string;onAuthFail:()=>void}){
  const [items,setItems]=useState<Consent[]|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [saving,setSaving]=useState('');
  async function load(){
    setLoading(true);setError('');
    try{setItems(await portalCall<Consent[]>('/portal/me/consents',token));}
    catch(e){
      if(portalAuthFailed(e,onAuthFail))return;
      setItems(null);setError(sectionErrorText(e));
    }finally{setLoading(false);}
  }
  useEffect(()=>{void load();},[]);
  async function toggle(purpose:string,granted:boolean){
    setSaving(purpose);setError('');
    try{
      const updated=await portalCall<Consent>('/portal/me/consents',token,'POST',{purpose,granted});
      setItems(prev=>{
        const list=prev??[];
        const row:Consent={purpose,granted,created_at:updated.created_at};
        const index=list.findIndex(c=>c.purpose===purpose);
        if(index<0)return [...list,row];
        const copy=[...list];copy[index]=row;return copy;
      });
    }catch(e){
      if(portalAuthFailed(e,onAuthFail))return;
      setError(sectionErrorText(e));
    }finally{setSaving('');}
  }
  const byPurpose=new Map<string,Consent>((items??[]).map(c=>[c.purpose,c] as [string,Consent]));
  return <div className="panel">
    <div className="panel-title"><h2>Meus consentimentos</h2><ShieldCheck size={19}/></div>
    <p className="muted">Escolha como os seus dados podem ser usados. Você pode mudar de ideia quando quiser.</p>
    {loading&&<p className="muted" role="status">Carregando suas preferências…</p>}
    {!loading&&error&&<div className="stack gap-3"><InlineError text={error}/>
      <div><button type="button" className="secondary-button" onClick={()=>void load()}>Tentar novamente</button></div></div>}
    {!loading&&!error&&items!==null&&items.length===0&&<p className="muted">Você ainda não registrou nenhuma preferência. Escolha abaixo.</p>}
    {!loading&&!error&&<div>
      {PURPOSES.map(p=>{
        const row=byPurpose.get(p.value);
        const granted=!!row?.granted;
        return <div className="list-line portal-consent" key={p.value}>
          <div className="list-icon"><ShieldCheck size={18}/></div>
          <div><strong>{p.label}</strong><small>{row?'Registrado em '+fmtDay(row.created_at):'Ainda não registrado'}</small></div>
          <div className="portal-consent-actions">
            <span className="small-pill">{row?(granted?'Permitido':'Não permitido'):'Sem registro'}</span>
            <button type="button" className="secondary-button" disabled={saving===p.value} onClick={()=>void toggle(p.value,!granted)}>
              {saving===p.value?'Salvando…':granted?'Revogar':'Permitir'}</button>
          </div>
        </div>;
      })}
    </div>}
  </div>;
}

/* -------------------------------------------------------------------------
 * Raiz do portal: sessão própria (sessionStorage) + composição dos painéis.
 * ---------------------------------------------------------------------- */
export function PatientPortalPage({onBack}:{onBack?:()=>void}){
  const [session,setSession]=useState<PortalSession|null>(()=>loadStoredSession());
  const [notice,setNotice]=useState('');
  const [online,setOnline]=useState(()=>typeof navigator==='undefined'||navigator.onLine);
  useEffect(()=>{
    const on=()=>setOnline(true),off=()=>setOnline(false);
    window.addEventListener('online',on);window.addEventListener('offline',off);
    return ()=>{window.removeEventListener('online',on);window.removeEventListener('offline',off);};
  },[]);
  function authenticate(s:PortalSession){saveStoredSession(s);setSession(s);setNotice('');}
  /** Logout: limpa APENAS a sessão do paciente (a sessão da equipe não existe aqui). */
  function logout(){clearStoredSession();setSession(null);setNotice('');}
  /** 401/403 do token do portal: volta ao login do portal com aviso não-técnico. */
  function sessionExpired(){clearStoredSession();setSession(null);setNotice('Sua sessão foi encerrada por segurança. Entre novamente para continuar.');}
  if(!session)return <PortalAuth onAuthenticated={authenticate} notice={notice||undefined} onBack={onBack}/>;
  return <PortalHome session={session} online={online} onLogout={logout} onAuthFail={sessionExpired} onBack={onBack}/>;
}

function PortalHome({session,online,onLogout,onAuthFail,onBack}:{session:PortalSession;online:boolean;onLogout:()=>void;onAuthFail:()=>void;onBack?:()=>void}){
  const headingRef=useRef<HTMLHeadingElement>(null);
  // Foco no título ao entrar no painel (leitor de tela/navegação por teclado).
  useEffect(()=>{const id=window.setTimeout(()=>headingRef.current?.focus(),0);return ()=>window.clearTimeout(id);},[]);
  const token=session.accessToken;
  return <div className="workspace">
    <header className="topbar">
      <div className="breadcrumb"><span>StarMed</span><span className="slash">/</span><strong>Área do paciente</strong></div>
      <div className="topbar-right">
        <span className={'status-dot '+(online?'':'offline')}/>{online?'Conectado':'Sem conexão'}
        {onBack&&<button type="button" className="text-button" onClick={onBack}>Acesso da equipe</button>}
        <button type="button" className="secondary-button" onClick={onLogout}><LogOut size={15}/> Sair</button>
      </div>
    </header>
    <main className="content">
      <div className="page-heading"><div><span className="eyebrow">ÁREA DO PACIENTE</span>
        <h1 tabIndex={-1} ref={headingRef}>Sua saúde em um só lugar</h1>
        <p>Consulte suas consultas, seus documentos e cuide da sua privacidade.</p></div></div>
      {!online&&<div className="notice error" role="status"><WifiOff size={17}/><span>Você está sem conexão. As informações podem estar desatualizadas.</span></div>}
      <div className="stack gap-5">
        <AppointmentsPanel token={token} onAuthFail={onAuthFail}/>
        <RequestAppointmentPanel token={token} onAuthFail={onAuthFail}/>
        <DocumentsPanel token={token} onAuthFail={onAuthFail}/>
        <div className="content-grid">
          <LgpdRequestsPanel token={token} onAuthFail={onAuthFail}/>
          <ConsentsPanel token={token} onAuthFail={onAuthFail}/>
        </div>
      </div>
    </main>
  </div>;
}
