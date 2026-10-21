import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, AlertCircle, ArrowRight, BedDouble, Building2, CalendarDays, CheckCircle2, ClipboardList, CloudUpload, FilePenLine, FileSignature, FlaskConical, HeartPulse, KeyRound, LayoutDashboard, LockKeyhole, LogOut, Pill, Plus, Search, ShieldCheck, Sparkles, Stethoscope, Users, Video, WifiOff, X } from 'lucide-react';
import { api, ApiError, EVENT_SESSION_EXPIRED, type LoginResponse, type Session, type User, type Patient, type Encounter, type ClinicalNote, type ClinicalAddendum, type PatientAllergy, type PatientProblem, type Doctor, type Appointment } from './api';
import { specialties, type Specialty } from './specialties';
import { pendingCount, queueDraft, syncDrafts } from './offline';
import { HospitalPage, TemplatesPage, MetricsPage, LgpdPage } from './pages/Fronts';
import { TeleconsultPage } from './pages/TeleconsultRoom';
import { TeleconsultPatient } from './pages/TeleconsultPatient';
import { SecurityPage } from './pages/Security';
import { PrescriptionsPage } from './pages/Prescriptions';
import { Record360Page } from './pages/Record360';
import { measureEvent } from './pages/perf-metrics';
import { ResultsPage } from './pages/Results';
import { PatientPortalPage } from './pages/PatientPortal';

type View='dashboard'|'patients'|'record'|'record360'|'prescriptions'|'agenda'|'team'|'assistant'|'teleconsult'|'hospital'|'results'|'templates'|'metrics'|'lgpd'|'security';
type Banner={text:string;kind:'success'|'error'|'info'};
type Draft={expectedVersion:number;operationId:string;templateId:string;sections:Record<string,string>};
const mkId=()=>crypto.randomUUID();
const fmt=(value:string)=>new Date(value).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'});
function IconMark(){return <div className="brand-mark"><HeartPulse size={22} strokeWidth={2.5}/></div>;}
/** Erros do login de credenciais em linguagem amigável (401 = dados não reconhecidos). */
function loginErrorText(e:unknown){
  if(e instanceof ApiError)
    return e.status===401?'E-mail ou senha não reconhecidos. Confira os dados e tente novamente.'
      :(e.message||'Não foi possível concluir o acesso. Tente novamente.');
  return 'Não foi possível conectar ao StarMed. Verifique sua conexão e tente novamente.';
}
/** Erros da etapa MFA (verify/recovery são públicos: 401 aqui é código/token de passo, não sessão). */
function mfaErrorText(e:unknown,mode:'totp'|'recovery'){
  if(e instanceof ApiError&&e.status===401)
    return mode==='recovery'?'Código de recuperação inválido ou já utilizado. Tente outro código ou volte ao início.'
      :'Código incorreto ou verificação expirada. Confira o aplicativo autenticador ou volte ao início.';
  if(e instanceof ApiError)return e.message||'Não foi possível concluir a verificação. Tente novamente.';
  return 'Não foi possível conectar ao StarMed. Verifique sua conexão e tente novamente.';
}
/** 409 de /auth/sso/start = SSO não configurado (ou provedor indisponível) → mensagem amigável. */
function ssoErrorText(e:unknown){
  if(e instanceof ApiError){
    if(e.status===409){
      const base=(e.message||'O acesso corporativo (SSO) não está disponível neste ambiente').replace(/[.\s]+$/,'');
      return base+'. Entre com seu e-mail e senha.';
    }
    return e.message||'Não foi possível iniciar o acesso corporativo. Tente novamente.';
  }
  return 'Não foi possível conectar ao StarMed. Verifique sua conexão e tente novamente.';
}
function Access({onLogin,notice,onPatientPortal}:{onLogin:(session:Session)=>void;notice?:string;onPatientPortal?:()=>void}){
  const [email,setEmail]=useState(''),[password,setPassword]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [stage,setStage]=useState<'credentials'|'mfa'>('credentials');
  const [mfaMode,setMfaMode]=useState<'totp'|'recovery'>('totp');
  const [mfaMethods,setMfaMethods]=useState<string[]>(['totp','recovery']);
  // Token de PASSO do MFA: existe apenas entre /auth/login e /auth/mfa/verify|recovery.
  // Ele NUNCA vira token de sessão: não entra em Session e nunca vai no header Authorization.
  const [mfaToken,setMfaToken]=useState('');
  const [code,setCode]=useState(''),[recoveryCode,setRecoveryCode]=useState('');
  const totpRef=useRef<HTMLInputElement>(null),recoveryRef=useRef<HTMLInputElement>(null);
  // Enter avança: cada etapa é um <form>; ao entrar na etapa MFA o foco vai ao campo de código.
  useEffect(()=>{
    if(stage!=='mfa')return;
    const id=window.setTimeout(()=>{(mfaMode==='totp'?totpRef:recoveryRef).current?.focus();},0);
    return ()=>window.clearTimeout(id);
  },[stage,mfaMode]);
  // Retorno do OIDC: /auth/sso/callback redireciona para /auth/callback#access_token=…&user=…
  useEffect(()=>{
    if(!window.location.pathname.endsWith('/auth/callback'))return;
    const raw=window.location.hash.replace(/^#/,'');
    window.history.replaceState({},'',window.location.pathname+window.location.search);
    if(!raw)return;
    const params=new URLSearchParams(raw);
    const accessToken=params.get('access_token');
    const userJson=params.get('user');
    if(accessToken&&userJson){
      try{onLogin({accessToken,user:JSON.parse(userJson) as User});return;}
      catch{/* mensagem amigável abaixo */}
    }
    // Motivos do provedor podem ser técnicos; o usuário vê uma mensagem amigável.
    setError('Não foi possível concluir o acesso por SSO. Entre com seu e-mail e senha ou contate o administrador.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  async function submit(e:FormEvent){
    e.preventDefault();setBusy(true);setError('');
    try{
      const res=await api<LoginResponse>('/auth/login',null,'POST',{email,password});
      if(res.mfaRequired&&res.mfaToken){
        // Sem accessToken aqui: o backend não emite sessão antes do segundo fator.
        setMfaToken(res.mfaToken);setMfaMethods(res.methods??['totp','recovery']);
        setMfaMode('totp');
        setCode('');setRecoveryCode('');setStage('mfa');
      }else if(res.accessToken&&res.user){
        onLogin({accessToken:res.accessToken,user:res.user});
      }else setError('Não foi possível concluir o acesso. Tente novamente.');
    }catch(e){setError(loginErrorText(e));}
    finally{setBusy(false);}
  }
  async function verifyMfa(e:FormEvent){
    e.preventDefault();if(!mfaToken)return;
    setBusy(true);setError('');
    try{
      const session=await api<Session>(mfaMode==='totp'?'/auth/mfa/verify':'/auth/mfa/recovery',null,'POST',
        mfaMode==='totp'?{mfaToken,code}:{mfaToken,recoveryCode:recoveryCode.trim()});
      if(session.accessToken&&session.user){
        setMfaToken('');setCode('');setRecoveryCode('');
        onLogin(session);
      }else setError('Não foi possível concluir o acesso. Tente novamente.');
    }catch(e){setError(mfaErrorText(e,mfaMode));}
    finally{setBusy(false);}
  }
  async function startSso(){
    setBusy(true);setError('');
    try{
      const r=await api<{authorizationUrl:string}>('/auth/sso/start',null);
      if(r.authorizationUrl)window.location.assign(r.authorizationUrl);
      else setError('Não foi possível iniciar o acesso corporativo. Tente novamente.');
    }catch(e){setError(ssoErrorText(e));}
    finally{setBusy(false);}
  }
  function backToCredentials(){
    setMfaToken('');setCode('');setRecoveryCode('');setError('');setStage('credentials');
  }
  return <div className="login-layout">
    <div className="login-illustration">
      <div className="brand-row"><IconMark/><span>StarMed</span></div>
      <div className="intro-copy"><span className="eyebrow-light">PRONTUÁRIO ELETRÔNICO</span>
        <h1>O cuidado é humano.<br/>A tecnologia acompanha.</h1>
        <p>Documentação clínica, fluxos inteligentes e o histórico do paciente em um só lugar.</p>
      </div>
      <div className="login-foot"><ShieldCheck size={19}/> Acesso restrito a profissionais autorizados</div>
    </div>
    <div className="login-form-shell"><div className="login-panel">
      <div className="small-icon">{stage==='mfa'?<ShieldCheck size={23}/>:<LockKeyhole size={23}/>}</div>
      {stage==='credentials'?<>
        <h2>Acesse seu ambiente</h2><p>Entre com as credenciais do StarMed.</p>
        {notice&&<div className="notice info" role="status"><AlertCircle size={17}/><span>{notice}</span></div>}
        <form onSubmit={submit} className="stack gap-4 mt-8">
          <label>E-mail institucional<input required type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} placeholder="voce@instituicao.com.br"/></label>
          <label>Senha<input required type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Sua senha"/></label>
          {error&&<div className="inline-error" role="alert"><AlertCircle size={16}/>{error}</div>}
          <button disabled={busy} className="primary-button" type="submit">{busy?'Autenticando…':'Entrar no sistema'} <ArrowRight size={18}/></button>
        </form>
        <div className="sso-divider"><span>ou</span></div>
        <div className="stack gap-3">
          <button type="button" className="sso-button" disabled={busy} onClick={()=>void startSso()}><Building2 size={17}/> Entrar com acesso corporativo (SSO)</button>
          {onPatientPortal&&<button type="button" className="sso-button" disabled={busy} onClick={onPatientPortal}><HeartPulse size={17}/> Área do paciente</button>}
        </div>
      </>:<>
        <h2>Confirme sua identidade</h2>
        <p>{mfaMode==='totp'?'Informe o código de 6 dígitos do seu aplicativo autenticador.':'Use um dos códigos de recuperação que você salvou ao ativar o MFA.'}</p>
        <div className="mfa-modes" role="group" aria-label="Método de verificação do segundo fator">
          <button type="button" className={'mode-button'+(mfaMode==='totp'?' active':'')} aria-pressed={mfaMode==='totp'} onClick={()=>{setMfaMode('totp');setError('');}}>Código do aplicativo</button>
          {mfaMethods.includes('recovery')&&<button type="button" className={'mode-button'+(mfaMode==='recovery'?' active':'')} aria-pressed={mfaMode==='recovery'} onClick={()=>{setMfaMode('recovery');setError('');}}>Código de recuperação</button>}
        </div>
        <form onSubmit={verifyMfa} className="stack gap-4 mt-8">
          {mfaMode==='totp'
            ?<label>Código de 6 dígitos<input ref={totpRef} required inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" className="code-input" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} placeholder="000000"/></label>
            :<label>Código de recuperação<input ref={recoveryRef} required minLength={8} maxLength={40} autoComplete="one-time-code" className="code-input" value={recoveryCode} onChange={e=>setRecoveryCode(e.target.value)} placeholder="XXXXX-XXXXX"/></label>}
          {error&&<div className="inline-error" role="alert"><AlertCircle size={16}/>{error}</div>}
          <button disabled={busy||(mfaMode==='totp'?code.length!==6:recoveryCode.trim().length<8)} className="primary-button" type="submit">
            {busy?'Verificando…':mfaMode==='totp'?'Verificar e entrar':'Entrar com código de recuperação'} <ArrowRight size={18}/></button>
        </form>
        <button type="button" className="text-button mfa-back" onClick={backToCredentials}>Voltar ao acesso com e-mail e senha</button>
      </>}
      <p className="security-note">Ambiente inicial de desenvolvimento. Não inserir dados reais de pacientes antes da homologação de segurança e privacidade.</p>
    </div></div>
  </div>;
}
function Nav({view,onView,role}:{view:View;onView:(v:View)=>void;role:string}){
  const items:{key:View;label:string;icon:typeof Activity;allowed:boolean}[]=[
    {key:'dashboard',label:'Visão geral',icon:LayoutDashboard,allowed:true},
    {key:'patients',label:'Pacientes',icon:Users,allowed:true},
    {key:'record',label:'Prontuário',icon:ClipboardList,allowed:role==='doctor'||role==='nurse'},
    {key:'record360',label:'Prontuário 360°',icon:Activity,allowed:role==='doctor'||role==='nurse'},
    {key:'prescriptions',label:'Prescrições',icon:Pill,allowed:role==='doctor'||role==='admin'},
    {key:'agenda',label:'Agenda',icon:CalendarDays,allowed:true},
    {key:'assistant',label:'Assistente de IA',icon:Sparkles,allowed:role==='doctor'},
    {key:'teleconsult',label:'Teleconsulta',icon:Video,allowed:role==='doctor'||role==='nurse'||role==='admin'},
    {key:'hospital',label:'Hospitalar',icon:BedDouble,allowed:role==='doctor'||role==='nurse'||role==='admin'},
    {key:'results',label:'Resultados',icon:FlaskConical,allowed:role==='doctor'||role==='nurse'||role==='admin'},
    {key:'templates',label:'Templates',icon:FileSignature,allowed:role==='doctor'||role==='admin'},
    {key:'metrics',label:'Métricas',icon:Activity,allowed:role==='doctor'||role==='admin'},
    {key:'lgpd',label:'LGPD',icon:ShieldCheck,allowed:true},
    {key:'security',label:'Segurança',icon:KeyRound,allowed:true},
    {key:'team',label:'Equipe',icon:Stethoscope,allowed:role==='admin'}
  ];
  return <nav className="sidebar-menu">{items.filter(x=>x.allowed).map(x=>{
    const Icon=x.icon;
    return <button key={x.key} className={'nav-item '+(view===x.key?'active':'')} onClick={()=>onView(x.key)}><Icon size={19}/>{x.label}</button>;
  })}</nav>;
}
export default function App(){
  const [session,setSession]=useState<Session|null>(null);
  const [view,setView]=useState<View>('dashboard');
  const [banner,setBanner]=useState<Banner|null>(null);
  const [patients,setPatients]=useState<Patient[]>([]);
  const [appointments,setAppointments]=useState<Appointment[]>([]);
  const [staff,setStaff]=useState<Doctor[]>([]);
  const [patientQuery,setPatientQuery]=useState('');
  const [patient,setPatient]=useState<Patient|null>(null);
  const [encounters,setEncounters]=useState<Encounter[]>([]);
  const [allergies,setAllergies]=useState<PatientAllergy[]>([]);
  const [problems,setProblems]=useState<PatientProblem[]>([]);
  const [allergyForm,setAllergyForm]=useState({substance:'',reaction:'',criticality:'unable-to-assess',verificationStatus:'unconfirmed'});
  const [problemForm,setProblemForm]=useState({display:'',codeSystem:'',code:'',verificationStatus:'provisional'});
  const [encounter,setEncounter]=useState<Encounter|null>(null);
  const [note,setNote]=useState<ClinicalNote|null>(null);
  const [addenda,setAddenda]=useState<ClinicalAddendum[]>([]);
  const [addendumReason,setAddendumReason]=useState('');
  const [addendumContent,setAddendumContent]=useState('');
  const [sections,setSections]=useState<Record<string,string>>({});
  const [specialty,setSpecialty]=useState<Specialty>('general');
  const [encounterType,setEncounterType]=useState('consultation');
  const [reason,setReason]=useState('');
  const [newPatient,setNewPatient]=useState({fullName:'',birthDate:'',administrativeGender:'unknown'});
  const [newStaff,setNewStaff]=useState({displayName:'',email:'',role:'doctor',password:''});
  const [appForm,setAppForm]=useState({patientId:'',practitionerId:'',scheduledAt:'',durationMinutes:30,kind:'consultation'});
  const [passphrase,setPassphrase]=useState('');
  const [pending,setPending]=useState(0);
  const [transcript,setTranscript]=useState('');
  const [aiResult,setAiResult]=useState<unknown>(null);
  const [loading,setLoading]=useState(false);
  const [serverReady,setServerReady]=useState(false);
  // P0-05 Break-glass: carregamento do prontuário pendente de motivo de emergência.
  // `breakGlass` guarda o loader original; o retry o reexecuta com X-Break-Glass-Reason.
  const [breakGlass,setBreakGlass]=useState<((headers:Record<string,string>)=>Promise<void>)|null>(null);
  const [breakGlassReason,setBreakGlassReason]=useState('');
  const [breakGlassError,setBreakGlassError]=useState('');
  // ST-P1-011 Agenda: id do compromisso com o campo de motivo de cancelamento aberto.
  const [cancelTarget,setCancelTarget]=useState('');
  const [cancelReason,setCancelReason]=useState('');
  const [apptBusy,setApptBusy]=useState('');
  // Aviso amigável exibido na tela de login (sessão encerrada, MFA desativado…)
  const [accessNotice,setAccessNotice]=useState('');
  // Entrada sem sessão staff: 'portal' abre a área do paciente (sessão própria, segregada da clínica).
  const [entryScreen,setEntryScreen]=useState<'staff'|'portal'>('staff');
  const token=session?.accessToken??null;
  const user=session?.user;
  const isDoctor=user?.role==='doctor';
  const hasUnsavedChanges=!!note && JSON.stringify(sections)!==JSON.stringify(note.content.sections);
  function alert(text:string,kind:Banner['kind']='info'){setBanner({text,kind});}
  // ── Break-glass (P0-05) ──────────────────────────────────────────────────────
  /**403 cuja mensagem cita "break-glass" = leitura de prontuário completo sem vínculo de
   *  cuidado; o backend exige o header X-Break-Glass-Reason (20..500 chars, auditado).
   *  Qualquer outro403 (papel, validação…) continua sendo erro comum. */
  function isBreakGlassError(e:unknown):e is ApiError{
    return e instanceof ApiError&&e.status===403&&/break-glass/i.test(e.message);
  }
  function resetBreakGlass(){setBreakGlass(null);setBreakGlassReason('');setBreakGlassError('');}
  /** Executa um carregamento do prontuário interceptando o403 de break-glass: nesse caso abre
   *  o painel guardando o loader original para o retry; demais erros são repassados ao chamador. */
  async function runRecordLoad(loader:(headers?:Record<string,string>)=>Promise<void>){
    try{await loader();}
    catch(e){
      if(isBreakGlassError(e)){setBreakGlassError('');setBreakGlassReason('');setBreakGlass(()=>loader);return;}
      throw e;
    }
  }
  /** Cancela o acesso: fecha o painel e registra o desfecho no banner. */
  function declineBreakGlass(){resetBreakGlass();alert('Acesso negado — sem vínculo de cuidado.','info');}
  /** Continua: refaz a chamada original com o header autorizador; sucesso => banner de auditoria. */
  async function confirmBreakGlass(){
    const loader=breakGlass;if(!loader)return;
    const reason=breakGlassReason.trim();
    if(reason.length<20){setBreakGlassError('Descreva o motivo do acesso com pelo menos 20 caracteres.');return;}
    if(reason.length>500){setBreakGlassError('Motivo acima do limite de 500 caracteres.');return;}
    try{
      await loader({'X-Break-Glass-Reason':reason});
      resetBreakGlass();
      alert('Acesso de emergência registrado na auditoria.','info');
    }catch(e){
      // Recusa repetida (ex.: motivo rejeitado): mantém o painel aberto com o erro inline.
      if(isBreakGlassError(e)){setBreakGlassError(e.message);return;}
      resetBreakGlass();
      alert((e as Error).message,'error');
    }
  }
  /** Limpa todo o estado clínico/local da sessão (usado em logout e sessão expirada). */
  function resetSessionState(){
    setBanner(null);setView('dashboard');
    setPatients([]);setAppointments([]);setStaff([]);setPatientQuery('');
    setPatient(null);setEncounters([]);setAllergies([]);setProblems([]);
    setAllergyForm({substance:'',reaction:'',criticality:'unable-to-assess',verificationStatus:'unconfirmed'});
    setProblemForm({display:'',codeSystem:'',code:'',verificationStatus:'provisional'});
    setEncounter(null);setNote(null);setAddenda([]);setAddendumReason('');setAddendumContent('');
    setSections({});setSpecialty('general');setEncounterType('consultation');setReason('');
    setNewPatient({fullName:'',birthDate:'',administrativeGender:'unknown'});
    setNewStaff({displayName:'',email:'',role:'doctor',password:''});
    setAppForm({patientId:'',practitionerId:'',scheduledAt:'',durationMinutes:30,kind:'consultation'});
    setPassphrase('');setPending(0);setTranscript('');setAiResult(null);setLoading(false);
    resetBreakGlass();setCancelTarget('');setCancelReason('');setApptBusy('');
  }
  /** Encerra a sessão local e volta ao login, com aviso não-técnico opcional. */
  function endSession(reason=''){resetSessionState();setSession(null);setAccessNotice(reason);}
  /** Entra na sessão limpando avisos/resíduos das telas anteriores. */
  function startSession(s:Session){setBanner(null);setAccessNotice('');setSession(s);setView('dashboard');}
  async function loadLists(current:Session){
    try {
      const [p,ap,us]=await Promise.all([
        api<Patient[]>('/patients',current.accessToken),
        api<Appointment[]>('/appointments',current.accessToken),
        api<Doctor[]>('/users',current.accessToken).catch(()=>[] as Doctor[])
      ]);
      setPatients(p);setAppointments(ap);setStaff(us);
    }catch(e){alert((e as Error).message,'error');}
  }
  useEffect(()=>{
    let disposed=false;
    const check=async()=>{
      try{
        const health=await api<{status:string}>('/health',null);
        if(!disposed)setServerReady(health.status==='ok');
      }catch{if(!disposed)setServerReady(false);}
    };
    const offline=()=>setServerReady(false);
    void check();
    const interval=window.setInterval(()=>void check(),30000);
    window.addEventListener('offline',offline);
    window.addEventListener('online',check);
    return ()=>{disposed=true;window.clearInterval(interval);window.removeEventListener('offline',offline);window.removeEventListener('online',check);};
  },[]);
  useEffect(()=>{if(session)void loadLists(session);},[session]);
  // 401 em endpoint chamado COM token de sessão → sessão inválida/expirada/revogada:
  // volta ao login com aviso não-técnico (o api() dispara o evento só nesse caso).
  useEffect(()=>{
    if(!session)return;
    const onExpired=()=>endSession('Sua sessão foi encerrada por segurança. Entre novamente para continuar.');
    window.addEventListener(EVENT_SESSION_EXPIRED,onExpired);
    return ()=>window.removeEventListener(EVENT_SESSION_EXPIRED,onExpired);
  },[session]);
  useEffect(()=>{
    if(user){void pendingCount(user.orgId,user.id).then(setPending).catch(()=>{});}
  },[user]);
  async function openPatient(p:Patient){
    if(!token)return;
    setPatient(p);setEncounter(null);setNote(null);setAddenda([]);setSections({});setView('record');
    resetBreakGlass();
    try {
      // GET /encounters?patientId=, /patients/:id/allergies e /patients/:id/problems são rotas
      // de carregamento sujeitas a403 break-glass: o loader é repetido com o header no retry.
      // Métrica 'open_record' (ST-P1-012): duração de abrir o prontuário, sem ids.
      await measureEvent(token,'open_record',()=>runRecordLoad(async headers=>{
        const [visits,allergyRecords,problemRecords]=await Promise.all([
          api<Encounter[]>('/encounters?patientId='+encodeURIComponent(p.id),token,'GET',undefined,headers),
          api<PatientAllergy[]>('/patients/'+p.id+'/allergies',token,'GET',undefined,headers),
          api<PatientProblem[]>('/patients/'+p.id+'/problems',token,'GET',undefined,headers)
        ]);
        setEncounters(visits);setAllergies(allergyRecords);setProblems(problemRecords);
      }));
    }catch(e){alert((e as Error).message,'error');}
  }
  async function openEncounter(e:Encounter){
    if(!token)return;
    setEncounter(e);setSpecialty((e.specialty in specialties?e.specialty:'general') as Specialty);
    resetBreakGlass();
    try {
      // GET /encounters/:id/notes é rota de carregamento sujeita a403 break-glass; roda antes
      // dos adendos para que a recusa de break-glass nunca seja mascarada por outra rejeição.
      await runRecordLoad(async headers=>{
        const current=await api<ClinicalNote|null>('/encounters/'+e.id+'/notes',token,'GET',undefined,headers);
        const history=await api<ClinicalAddendum[]>('/encounters/'+e.id+'/addenda',token,'GET',undefined,headers);
        setNote(current);setSections(current?.content?.sections??{});setAddenda(history);
        setAddendumReason('');setAddendumContent('');
      });
    } catch(err){alert((err as Error).message,'error');}
  }
  /** Seleciona o paciente para a tela de Prescrições SEM abandonar a view atual.
   *  Médico/enfermagem carregam o prontuário completo (openPatient); o admin não tem
   *  acesso aos endpoints de encontro/alergias, então só contextualiza o paciente. */
  async function selectPatientForPrescriptions(p:Patient){
    if(user?.role==='admin'){setPatient(p);setEncounter(null);setNote(null);setAddenda([]);setSections({});setEncounters([]);setAllergies([]);setProblems([]);return;}
    await openPatient(p);setView('prescriptions');
  }
  async function createPatient(e:FormEvent){
    e.preventDefault();if(!token||!session)return;
    setLoading(true);
    try {
      const created=await api<Patient>('/patients',token,'POST',newPatient);
      await loadLists(session);
      setNewPatient({fullName:'',birthDate:'',administrativeGender:'unknown'});
      alert('Paciente cadastrado.','success');
      if(isDoctor)await openPatient(created);
    }catch(err){alert((err as Error).message,'error');}finally{setLoading(false);}
  }
  async function createAllergy(e:FormEvent){
    e.preventDefault();
    if(!patient||!token)return;
    setLoading(true);
    try {
      // Métrica 'check_allergy' (ST-P1-012): registrar a alergia identificada.
      await measureEvent(token,'check_allergy',()=>api('/patients/'+patient.id+'/allergies',token,'POST',allergyForm));
      setAllergyForm({substance:'',reaction:'',criticality:'unable-to-assess',verificationStatus:'unconfirmed'});
      alert('Alergia documentada. Verifique o estado de confirmação.','success');
      // GET /patients/:id/allergies — rota de prontuário:403 break-glass abre o painel de emergência.
      await runRecordLoad(async headers=>{setAllergies(await api<PatientAllergy[]>('/patients/'+patient.id+'/allergies',token,'GET',undefined,headers));});
    }catch(err){alert((err as Error).message,'error');}finally{setLoading(false);}
  }
  async function createProblem(e:FormEvent){
    e.preventDefault();
    if(!patient||!token||!isDoctor)return;
    setLoading(true);
    try {
      const payload={display:problemForm.display,verificationStatus:problemForm.verificationStatus,
        ...(problemForm.code&&problemForm.codeSystem?{code:problemForm.code,codeSystem:problemForm.codeSystem}:{})};
      await api('/patients/'+patient.id+'/problems',token,'POST',payload);
      setProblemForm({display:'',codeSystem:'',code:'',verificationStatus:'provisional'});
      alert('Problema clínico documentado.','success');
      // GET /patients/:id/problems — rota de prontuário:403 break-glass abre o painel de emergência.
      await runRecordLoad(async headers=>{setProblems(await api<PatientProblem[]>('/patients/'+patient.id+'/problems',token,'GET',undefined,headers));});
    }catch(err){alert((err as Error).message,'error');}finally{setLoading(false);}
  }
  async function createEncounter(e:FormEvent){
    e.preventDefault();if(!token||!patient)return;
    try {
      const created=await api<Encounter>('/encounters',token,'POST',{patientId:patient.id,specialty,type:encounterType,reasonForVisit:reason});
      setEncounters(old=>[created,...old]);setReason('');await openEncounter(created);
      alert('Atendimento iniciado.','success');
    }catch(err){alert((err as Error).message,'error');}
  }
  function draftPayload():Draft{
    return {operationId:mkId(),templateId:encounter?.specialty||specialty,expectedVersion:note?.version??0,sections};
  }
  async function saveDraft(offline=false){
    if(!token||!encounter||!user)return;
    const b=draftPayload();setLoading(true);
    try {
      if(offline){
        await queueDraft(user.orgId,user.id,encounter.id,b,passphrase);
        setPending(await pendingCount(user.orgId,user.id));
        alert('Rascunho armazenado localmente com criptografia. Sincronize após reconexão.','success');
        return;
      }
      const saved=await api<ClinicalNote>('/encounters/'+encounter.id+'/notes/draft',token,'PUT',b);
      setNote(saved);alert('Evolução salva no servidor.','success');
    }catch(err){
      const message=(err as Error).message;
      alert(message,'error');
    }finally{setLoading(false);}
  }
  async function signNote(){
    if(!token||!encounter||!note||!isDoctor||hasUnsavedChanges)return;
    if(!window.confirm('Confirma a revisão clínica e atestação? Uma nota assinada torna-se imutável. Salve as alterações antes.'))return;
    setLoading(true);
    try {
      // Métrica 'sign_note' (ST-P1-012): concluir/atesta a evolução.
      const signed=await measureEvent(token,'sign_note',()=>api<ClinicalNote>('/encounters/'+encounter.id+'/notes/sign',token,'POST',{expectedVersion:note.version}));
      setNote(signed);setSections(signed.content.sections);alert('Nota atestada e bloqueada para edição. Esta ação não é assinatura digital ICP-Brasil.','success');
    }catch(err){alert((err as Error).message,'error');}finally{setLoading(false);}
  }
  async function appendAddendum(e:FormEvent){
    e.preventDefault();
    if(!token||!encounter||!user||!isDoctor||note?.status!=='signed')return;
    if(encounter.doctor_id!==user.id){alert('Somente o médico responsável pode criar adendos.','error');return;}
    if(!window.confirm('Confirma o adendo? Ele será atestado e não poderá ser alterado.'))return;
    setLoading(true);
    try {
      await api<ClinicalAddendum>('/encounters/'+encounter.id+'/addenda',token,'POST',{operationId:mkId(),reason:addendumReason,content:addendumContent});
      setAddenda(await api<ClinicalAddendum[]>('/encounters/'+encounter.id+'/addenda',token));
      setAddendumReason('');setAddendumContent('');
      alert('Adendo atestado e registrado sem modificar a evolução original.','success');
    }catch(err){alert((err as Error).message,'error');}
    finally{setLoading(false);}
  }
  async function syncNow(){
    if(!token||!user)return;
    setLoading(true);
    try {
      const result=await syncDrafts(user.orgId,user.id,passphrase,(id,payload)=>api<ClinicalNote>('/encounters/'+id+'/notes/draft',token,'PUT',payload));
      setPending(await pendingCount(user.orgId,user.id));
      if(encounter)await openEncounter(encounter);
      alert(result.sent+' rascunho(s) sincronizado(s); '+result.conflicts+' conflito(s). Conflitos exigem revisão manual.',result.conflicts?'error':'success');
    }catch(e){alert((e as Error).message,'error');}finally{setLoading(false);}
  }
  async function createAppointment(e:FormEvent){
    e.preventDefault();if(!token||!session)return;
    try {
      await api('/appointments',token,'POST',{patientId:appForm.patientId,practitionerId:appForm.practitionerId,scheduledAt:new Date(appForm.scheduledAt).toISOString(),durationMinutes:Number(appForm.durationMinutes),kind:appForm.kind});
      await loadLists(session);alert('Agendamento criado.','success');
    }catch(err){alert((err as Error).message,'error');}
  }
  /** ST-P1-011 — PATCH /appointments/:id/status {status,reason?} → {id,status,scheduled_at,kind}.
   *  Transições: scheduled→checked_in|cancelled|no_show; checked_in→completed|cancelled.
   *  403 (papel) /409 (transição inválida) /404 (inexistente) viram mensagens amigáveis. */
  async function updateAppointmentStatus(a:Appointment,status:'checked_in'|'completed'|'cancelled'|'no_show',reason?:string){
    if(!token||!session)return;
    setApptBusy(a.id);
    try{
      const updated=await api<{id:string;status:string;scheduled_at:string;kind:string}>(
        '/appointments/'+a.id+'/status',token,'PATCH',reason?{status,reason}:{status});
      setAppointments(list=>list.map(x=>x.id===a.id
        ?{...x,status:updated.status,scheduled_at:updated.scheduled_at,kind:updated.kind}
        :x));
      setCancelTarget('');setCancelReason('');
      const done={checked_in:'Check-in registrado.',completed:'Atendimento concluído.',
        cancelled:'Agendamento cancelado.',no_show:'Marcado como não compareceu.'} as const;
      alert(done[status],'success');
    }catch(err){
      const e=err as ApiError;
      if(e.status===403){
        alert('Seu papel não tem permissão para esta operação na agenda. Peça a um administrador ou a um profissional habilitado.','error');
      }else if(e.status===409){
        alert('Transição não permitida: este compromisso já mudou de situação. A lista foi atualizada — confira e tente novamente.','error');
        void loadLists(session);
      }else if(e.status===404){
        alert('Agendamento não encontrado: ele pode ter sido removido. A lista foi atualizada.','error');
        void loadLists(session);
      }else{
        alert((err as Error).message,'error');
      }
    }finally{setApptBusy('');}
  }
  async function createStaff(e:FormEvent){
    e.preventDefault();if(!token||!session)return;
    try{
      await api('/users',token,'POST',newStaff);
      setNewStaff({displayName:'',email:'',role:'doctor',password:''});await loadLists(session);
      alert('Profissional cadastrado.','success');
    }catch(err){alert((err as Error).message,'error');}
  }
  async function askAI(e:FormEvent){
    e.preventDefault();if(!token)return;
    setLoading(true);setAiResult(null);
    try{
      const response=await api<{suggestion:unknown;status:string}>('/ai/extract',token,'POST',{transcript});
      setAiResult(response.suggestion);alert('Sugestão recebida. Revise todos os campos antes de registrar.','info');
    }catch(err){alert((err as Error).message,'error');}finally{setLoading(false);}
  }
  // Área do paciente: rota/view SEM sessão staff — sessão própria em PatientPortalPage.
  // Rota PÚBLICA da teleconsulta do paciente: `#teleconsult=<roomId>` (link
  // compartilhado pela equipe — a entrada continua exigindo o convite
  // single-use; nada de sessão staff nesta tela).
  const teleconsultRoom = /^#teleconsult=([0-9a-fA-F-]{36})$/.exec(window.location.hash)?.[1];
  if(teleconsultRoom) return <TeleconsultPatient roomId={teleconsultRoom} alert={alert}/>;

  if(!session)return entryScreen==='portal'
    ? <PatientPortalPage onBack={()=>setEntryScreen('staff')}/>
    : <Access onLogin={startSession} notice={accessNotice||undefined} onPatientPortal={()=>setEntryScreen('portal')}/>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-row"><IconMark/><span>StarMed</span></div>
      <div className="sidebar-caption">AMBIENTE CLÍNICO</div>
      <Nav view={view} onView={setView} role={user!.role}/>
      <div className="sidebar-bottom">
        <div className="environment-note"><ShieldCheck size={17}/><span>MVP de desenvolvimento<br/>Não homologado para produção</span></div>
        <button className="logout-button" onClick={()=>endSession()}><LogOut size={17}/> Sair</button>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>StarMed</span><span className="slash">/</span><strong>{({dashboard:'Visão geral',record:'Prontuário',record360:'Prontuário 360°',prescriptions:'Prescrições',patients:'Pacientes',agenda:'Agenda',team:'Equipe',assistant:'Assistente de IA',teleconsult:'Teleconsulta',hospital:'Hospitalar',results:'Resultados',templates:'Templates',metrics:'Métricas',lgpd:'LGPD',security:'Segurança'} as const)[view]}</strong></div>
        <div className="topbar-right"><span className={'status-dot '+(serverReady?'':'offline')}/>{serverReady?'API disponível':'API indisponível'} <div className="avatar">{(user?.displayName||user?.email||'S').slice(0,1).toUpperCase()}</div></div>
      </header>
      <main className="content">
        {banner&&<div className={'notice '+banner.kind}><span>{banner.kind==='error'?<AlertCircle size={17}/>:<CheckCircle2 size={17}/>}</span><span>{banner.text}</span><button aria-label="Fechar aviso" onClick={()=>setBanner(null)}><X size={17}/></button></div>}
        {breakGlass&&<div className="panel break-glass-panel" role="dialog" aria-label="Acesso de emergência (break-glass)">
          <div className="panel-title"><h2>Acesso de emergência • break-glass</h2><LockKeyhole size={19}/></div>
          <p className="muted">Este prontuário foi bloqueado (403): você não tem vínculo de cuidado com o paciente. Informe o motivo do acesso para prosseguir — <strong>o motivo fica auditado no servidor.</strong></p>
          <label>Motivo do acesso (mín. 20 caracteres)
            <textarea rows={3} maxLength={500} value={breakGlassReason} onChange={e=>{setBreakGlassReason(e.target.value);setBreakGlassError('');}} placeholder="Ex.: acolhimento de urgência do paciente, sem vínculo prévio de cuidado"/>
          </label>
          <div className="break-glass-meta"><span className="small-pill">{breakGlassReason.trim().length} / 500</span><span className="muted">Mínimo 20 caracteres • fica auditado</span></div>
          {breakGlassError&&<div className="inline-error" role="alert"><AlertCircle size={16}/>{breakGlassError}</div>}
          <div className="action-row">
            <button className="secondary-button" onClick={declineBreakGlass}>Cancelar</button>
            <button className="primary-button" disabled={breakGlassReason.trim().length<20} onClick={()=>void confirmBreakGlass()}><LockKeyhole size={16}/> Continuar</button>
          </div>
        </div>}
        {view==='dashboard'&&<section>
          <div className="hero"><div><span className="eyebrow">PAINEL DE ATENDIMENTO</span><h1>Bom atendimento começa<br/>com informação clara.</h1><p>Bem-vindo ao StarMed. Acompanhe os registros da sua organização.</p><button className="hero-button" onClick={()=>setView('patients')}>Consultar pacientes <ArrowRight size={17}/></button></div><div className="hero-graphic"><div className="pulse-ring"><HeartPulse size={80} strokeWidth={1.2}/></div></div></div>
          <div className="stat-grid"><div className="stat-card"><Users size={20}/><span>Pacientes cadastrados</span><strong>{patients.length}</strong><small>Até 50 resultados na busca atual</small></div><div className="stat-card"><CalendarDays size={20}/><span>Agendamentos exibidos</span><strong>{appointments.length}</strong><small>Últimos 7 dias e futuros</small></div><div className="stat-card"><CloudUpload size={20}/><span>Rascunhos offline</span><strong>{pending}</strong><small>Armazenados neste navegador</small></div></div>
          <div className="dashboard-grid"><div className="panel"><div className="panel-title"><h2>Próximos agendamentos</h2><button className="text-button" onClick={()=>setView('agenda')}>Ver agenda <ArrowRight size={15}/></button></div>{appointments.length===0?<p className="muted empty-state">Nenhum agendamento encontrado.</p>:appointments.slice(0,4).map(a=><div className="list-line" key={a.id}><div className="list-icon"><CalendarDays size={18}/></div><div><strong>{a.patient_name}</strong><small>{fmt(a.scheduled_at)} • {a.kind}</small></div><span className="small-pill">{a.status}</span></div>)}</div>
          <div className="panel"><div className="panel-title"><h2>Fluxo clínico</h2></div><div className="flow-line"><div className="step-num">1</div><div><strong>Identifique o paciente</strong><p>Localize ou cadastre um registro.</p></div></div><div className="flow-line"><div className="step-num">2</div><div><strong>Inicie o atendimento</strong><p>Selecione a especialidade e registre a queixa.</p></div></div><div className="flow-line"><div className="step-num">3</div><div><strong>Revise e ateste</strong><p>Valide os achados e assine a evolução online.</p></div></div></div></div>
        </section>}
        {view==='patients'&&<section>
          <div className="page-heading"><div><span className="eyebrow">GESTÃO CLÍNICA</span><h1>Pacientes</h1><p>Pesquise e organize os cadastros da sua organização.</p></div></div>
          <div className="content-grid"><div className="panel"><div className="panel-title"><h2>Pacientes cadastrados</h2><span className="small-pill">{patients.length} encontrados</span></div>
            <div className="search-field"><Search size={17}/><input placeholder="Buscar por nome" value={patientQuery} onChange={e=>setPatientQuery(e.target.value)}/><button onClick={async()=>{if(token)setPatients(await api<Patient[]>('/patients?q='+encodeURIComponent(patientQuery),token));}}>Buscar</button></div>
            <div className="patient-list">{patients.length===0?<div className="empty-state">Nenhum paciente encontrado.</div>:patients.map(p=><button className="patient-row" key={p.id} onClick={()=>user?.role==='doctor'||user?.role==='nurse'?openPatient(p):alert('Prontuário clínico é restrito à equipe assistencial.','info')}><div className="patient-avatar">{p.fullName[0]?.toUpperCase()}</div><div><strong>{p.fullName}</strong><small>Nascimento: {String(p.birthDate).slice(0,10).split('-').reverse().join('/')}</small></div><ArrowRight size={16}/></button>)}</div>
          </div>
          <div className="panel"><div className="panel-title"><h2>Novo paciente</h2><Plus size={20}/></div><form className="stack gap-4" onSubmit={createPatient}>
            <label>Nome completo<input required minLength={2} value={newPatient.fullName} onChange={e=>setNewPatient({...newPatient,fullName:e.target.value})} placeholder="Nome do paciente"/></label>
            <label>Data de nascimento<input required type="date" value={newPatient.birthDate} onChange={e=>setNewPatient({...newPatient,birthDate:e.target.value})}/></label>
            <label>Gênero administrativo<select value={newPatient.administrativeGender} onChange={e=>setNewPatient({...newPatient,administrativeGender:e.target.value})}><option value="unknown">Não informado</option><option value="female">Feminino</option><option value="male">Masculino</option><option value="other">Outro</option></select></label>
            <button className="primary-button" disabled={loading||user?.role==='nurse'} type="submit"><Plus size={17}/> Criar cadastro</button>
          </form></div></div>
        </section>}
        {view==='record'&&<section>
          <div className="page-heading"><div><span className="eyebrow">DOCUMENTAÇÃO CLÍNICA</span><h1>Prontuário eletrônico</h1><p>Evoluções estruturadas por especialidade, com revisão médica.</p></div></div>
          {!patient?<div className="panel empty-state"><ClipboardList size={35}/><h2>Selecione um paciente</h2><p>Comece pela área de pacientes para abrir o prontuário.</p><button className="primary-button" onClick={()=>setView('patients')}>Ir para pacientes <ArrowRight size={16}/></button></div>:
          <><div className="patient-header"><div className="patient-avatar large">{patient.fullName.slice(0,1).toUpperCase()}</div><div><span className="eyebrow">PACIENTE EM ATENDIMENTO</span><h2>{patient.fullName}</h2><p>Nascimento: {String(patient.birthDate).slice(0,10)}</p></div><span className="small-pill">ID {patient.id.slice(0,8)}</span></div>
          <div className="record-grid"><div className="stack gap-5"><div className="panel"><div className="panel-title"><h2>Atendimentos</h2><span className="small-pill">{encounters.length}</span></div>
            {encounters.length===0?<p className="muted">Nenhum atendimento para este paciente.</p>:encounters.map(e=><button className={'encounter-row '+(encounter?.id===e.id?'selected':'')} onClick={()=>void openEncounter(e)} key={e.id}><div className="list-icon"><FilePenLine size={18}/></div><div><strong>{specialties[e.specialty as Specialty]?.name||e.specialty}</strong><small>{fmt(e.started_at)}</small></div><ArrowRight size={16}/></button>)}
            {(isDoctor||user?.role==='admin')&&patient&&<button type="button" className="text-button" onClick={()=>setView('prescriptions')}><Pill size={15}/> Prescrições do paciente</button>}
            {patient&&<button type="button" className="text-button" onClick={()=>setView('record360')}><Activity size={15}/> Visão 360° do prontuário</button>}
          </div>
          <div className="panel">
            <div className="panel-title"><h2>Resumo clínico</h2><ShieldCheck size={19}/></div>
            <div className="clinical-summary">
              <h3>Alergias registradas</h3>
              {allergies.length===0?<p className="muted">Não há registros. Isso não confirma ausência de alergias.</p>:
                allergies.map(x=><div className="clinical-chip" key={x.id}><strong>{x.substance}</strong>
                  {x.criticality==='high'&&<span className="clinical-high">Alta criticidade</span>}
                  <small>{x.reaction||'Reação não informada'} • {x.verification_status==='confirmed'?'Confirmada':'Não confirmada'}</small>
                </div>)}
              <details className="clinical-details"><summary>+ Registrar alergia</summary>
                <form className="stack gap-3" onSubmit={createAllergy}>
                  <label>Substância<input required minLength={2} maxLength={200} value={allergyForm.substance} onChange={e=>setAllergyForm({...allergyForm,substance:e.target.value})} placeholder="Ex.: medicamento, alimento"/></label>
                  <label>Reação observada ou relatada<input maxLength={1000} value={allergyForm.reaction} onChange={e=>setAllergyForm({...allergyForm,reaction:e.target.value})}/></label>
                  <label>Criticidade<select value={allergyForm.criticality} onChange={e=>setAllergyForm({...allergyForm,criticality:e.target.value})}><option value="unable-to-assess">Não avaliada</option><option value="low">Baixa</option><option value="high">Alta</option></select></label>
                  <label>Confirmação<select value={allergyForm.verificationStatus} onChange={e=>setAllergyForm({...allergyForm,verificationStatus:e.target.value})}><option value="unconfirmed">Não confirmada</option><option value="confirmed">Confirmada</option></select></label>
                  <button className="secondary-button" disabled={loading} type="submit"><Plus size={15}/> Registrar</button>
                </form>
              </details>
              <h3>Problemas de saúde</h3>
              {problems.length===0?<p className="muted">Nenhum problema cadastrado; consulte anamnese e registros anteriores.</p>:
                problems.map(x=><div className="clinical-chip" key={x.id}><strong>{x.display}</strong><small>{x.code?x.code+' • ':''}{x.verification_status==='confirmed'?'Confirmado':'Provisório'}</small></div>)}
              {isDoctor&&<details className="clinical-details"><summary>+ Registrar problema</summary>
                <form className="stack gap-3" onSubmit={createProblem}>
                  <label>Descrição clínica<input required minLength={3} maxLength={300} value={problemForm.display} onChange={e=>setProblemForm({...problemForm,display:e.target.value})}/></label>
                  <label>Código (opcional)<input value={problemForm.code} onChange={e=>setProblemForm({...problemForm,code:e.target.value})} placeholder="CID-10/CID-11/SNOMED"/></label>
                  <label>URI do sistema (quando codificado)<input value={problemForm.codeSystem} onChange={e=>setProblemForm({...problemForm,codeSystem:e.target.value})} placeholder="https://..."/></label>
                  <label>Confirmação<select value={problemForm.verificationStatus} onChange={e=>setProblemForm({...problemForm,verificationStatus:e.target.value})}><option value="provisional">Hipótese provisória</option><option value="confirmed">Confirmado</option></select></label>
                  <button className="secondary-button" disabled={loading} type="submit"><Plus size={15}/> Registrar</button>
                </form>
              </details>}
            </div>
          </div>
          {isDoctor&&<div className="panel"><div className="panel-title"><h2>Iniciar atendimento</h2><Plus size={19}/></div><form className="stack gap-3" onSubmit={createEncounter}>
            <label>Especialidade<select value={specialty} onChange={e=>setSpecialty(e.target.value as Specialty)}>{Object.entries(specialties).map(([key,v])=><option key={key} value={key}>{v.name}</option>)}</select></label>
            <label>Modalidade<select value={encounterType} onChange={e=>setEncounterType(e.target.value)}><option value="consultation">Consulta</option><option value="follow_up">Retorno</option><option value="teleconsultation">Teleconsulta</option><option value="emergency">Urgência</option></select></label>
            <label>Motivo da consulta<textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="Motivo informado para iniciar o atendimento" rows={3}/></label>
            <button type="submit" className="primary-button"><Plus size={16}/> Iniciar</button>
          </form></div>}</div>
          <div className="panel note-panel">{!encounter?<div className="empty-state"><FilePenLine size={35}/><h2>Selecione um atendimento</h2><p>Os campos do prontuário serão carregados conforme a especialidade.</p></div>:<>
            <div className="panel-title"><div><span className="eyebrow">EVOLUÇÃO MÉDICA</span><h2>{specialties[specialty].name}</h2></div><span className={'small-pill '+(note?.status==='signed'?'pill-signed':'')}>{note?.status==='signed'?'Atestada':note?'Rascunho • v'+note.version:'Nova evolução'}</span></div>
            <div className="note-fields">{specialties[specialty].fields.map(field=><label key={field.key}>{field.label}{field.required&&<span className="required"> *</span>}<textarea rows={field.key==='hpi'?4:3} disabled={note?.status==='signed'||!isDoctor} value={sections[field.key]??''} onChange={e=>setSections(s=>({...s,[field.key]:e.target.value}))} placeholder={field.placeholder||'Documente os achados relevantes'}/></label>)}</div>
            {note?.status==='signed'?<div className="signed-message"><ShieldCheck size={19}/> Documento atestado em {note.signed_at?fmt(note.signed_at):'data não informada'}. Edição bloqueada.</div>:isDoctor?<div className="action-row">
              <button className="secondary-button" disabled={loading} onClick={()=>void saveDraft(true)}><WifiOff size={17}/> Salvar criptografado offline</button>
              <button className="secondary-button" disabled={loading} onClick={()=>void saveDraft(false)}><CloudUpload size={17}/> Salvar rascunho</button>
              <button className="primary-button" disabled={loading||!note||hasUnsavedChanges} onClick={()=>void signNote()}><ShieldCheck size={17}/> Atestar evolução</button>
            </div>:<p className="muted">Visualização de equipe assistencial. Apenas o médico responsável pode editar e atestar.</p>}
            {note?.status==='signed'&&<div className="addenda-zone">
              <div className="panel-title"><h2>Adendos da evolução</h2><span className="small-pill">{addenda.length}</span></div>
              {addenda.length===0?<p className="muted">Nenhum adendo registrado.</p>:addenda.map(item=>
                <article key={item.id} className="addendum-entry">
                  <div className="addendum-meta"><ShieldCheck size={15}/><strong>{item.author_name||'Médico responsável'}</strong><span>{fmt(item.signed_at)}</span></div>
                  <p><strong>Motivo:</strong> {item.reason}</p><p>{item.content}</p>
                </article>)}
              {isDoctor&&encounter.doctor_id===user?.id&&<form onSubmit={appendAddendum} className="stack gap-3 addendum-form">
                <label>Motivo do adendo<input required minLength={8} maxLength={1000} value={addendumReason} onChange={e=>setAddendumReason(e.target.value)} placeholder="Ex.: Correção ou complementação de informação clínica"/></label>
                <label>Conteúdo do adendo<textarea rows={4} required minLength={10} maxLength={10000} value={addendumContent} onChange={e=>setAddendumContent(e.target.value)} placeholder="Descreva a informação complementar; o documento original permanece preservado."/></label>
                <button className="primary-button" type="submit" disabled={loading}><ShieldCheck size={16}/> Atestar adendo</button>
              </form>}
            </div>}
            <p className="muted footnote">Atestação no banco não substitui assinatura digital legal. Alterações locais precisam ser salvas antes de atestar.</p>
          </>}</div></div></>}
        </section>}
        {view==='agenda'&&<section>
          <div className="page-heading"><div><span className="eyebrow">ORGANIZAÇÃO</span><h1>Agenda</h1><p>Registros e novos agendamentos por profissional.</p></div></div>
          <div className="content-grid"><div className="panel"><div className="panel-title"><h2>Agendamentos</h2></div>{appointments.length===0?<div className="empty-state">Nenhuma consulta agendada.</div>:appointments.map(a=>{
            const busy=apptBusy===a.id;
            return <div className="list-line" key={a.id}><div className="list-icon"><CalendarDays size={18}/></div>
              <div><strong>{a.patient_name}</strong><small>{fmt(a.scheduled_at)} • {a.duration_minutes} min • {a.kind}</small>
                {(a.status==='scheduled'||a.status==='checked_in')&&<div className="agenda-actions">
                  {a.status==='scheduled'&&<button className="text-button" disabled={busy} onClick={()=>{if(window.confirm('Confirmar check-in de '+a.patient_name+'?'))void updateAppointmentStatus(a,'checked_in');}}><CheckCircle2 size={14}/> Check-in</button>}
                  {a.status==='checked_in'&&<button className="text-button" disabled={busy} onClick={()=>{if(window.confirm('Concluir o atendimento de '+a.patient_name+'?'))void updateAppointmentStatus(a,'completed');}}><ShieldCheck size={14}/> Concluir</button>}
                  {a.status==='scheduled'&&<button className="text-button" disabled={busy} onClick={()=>{if(window.confirm('Marcar '+a.patient_name+' como não compareceu?'))void updateAppointmentStatus(a,'no_show');}}><AlertCircle size={14}/> Não compareceu</button>}
                  <button className="text-button agenda-cancel" disabled={busy} onClick={()=>{setCancelTarget(cancelTarget===a.id?'':a.id);setCancelReason('');}}><X size={14}/> Cancelar</button>
                </div>}
                {cancelTarget===a.id&&<form className="agenda-cancel-form" onSubmit={ev=>{
                  ev.preventDefault();
                  const reason=cancelReason.trim();
                  if(reason.length<5){alert('Informe o motivo do cancelamento com pelo menos 5 caracteres.','error');return;}
                  if(window.confirm('Confirmar o cancelamento do agendamento de '+a.patient_name+'?'))void updateAppointmentStatus(a,'cancelled',reason);
                }}>
                  <label>Motivo do cancelamento (mín. 5 caracteres)
                    <input value={cancelReason} onChange={ev=>setCancelReason(ev.target.value)} minLength={5} maxLength={500} placeholder="Ex.: paciente desistiu, reagendamento solicitado"/>
                  </label>
                  <div className="agenda-cancel-buttons">
                    <button type="submit" className="secondary-button" disabled={busy||cancelReason.trim().length<5}>Confirmar cancelamento</button>
                    <button type="button" className="text-button" onClick={()=>{setCancelTarget('');setCancelReason('');}}>Voltar</button>
                  </div>
                </form>}
              </div>
              <span className="small-pill">{a.status}</span>
            </div>;
          })}</div>
            <div className="panel"><div className="panel-title"><h2>Novo agendamento</h2><Plus size={20}/></div><form className="stack gap-4" onSubmit={createAppointment}>
              <label>Paciente<select required value={appForm.patientId} onChange={e=>setAppForm({...appForm,patientId:e.target.value})}><option value="">Selecione</option>{patients.map(p=><option key={p.id} value={p.id}>{p.fullName}</option>)}</select></label>
              <label>Profissional<select required value={appForm.practitionerId} onChange={e=>setAppForm({...appForm,practitionerId:e.target.value})}><option value="">Selecione</option>{staff.filter(s=>s.role==='doctor').map(s=><option key={s.id} value={s.id}>{s.displayName}</option>)}{isDoctor&&!staff.some(s=>s.id===user!.id)&&<option value={user!.id}>Meu usuário</option>}</select></label>
              <label>Data e hora<input required type="datetime-local" value={appForm.scheduledAt} onChange={e=>setAppForm({...appForm,scheduledAt:e.target.value})}/></label>
              <label>Tipo<select value={appForm.kind} onChange={e=>setAppForm({...appForm,kind:e.target.value})}><option value="consultation">Consulta</option><option value="follow_up">Retorno</option><option value="teleconsultation">Teleconsulta</option></select></label>
              <button className="primary-button" type="submit" disabled={user?.role==='nurse'}><Plus size={17}/> Agendar consulta</button>
            </form></div></div>
        </section>}
        {view==='team'&&<section><div className="page-heading"><div><span className="eyebrow">ADMINISTRAÇÃO</span><h1>Equipe</h1><p>Credencie profissionais na organização.</p></div></div>
          <div className="content-grid"><div className="panel"><div className="panel-title"><h2>Usuários ativos</h2></div>{staff.map(s=><div className="list-line" key={s.id}><div className="patient-avatar">{s.displayName.slice(0,1).toUpperCase()}</div><div><strong>{s.displayName}</strong><small>{s.email}</small></div><span className="small-pill">{s.role}</span></div>)}</div>
            <div className="panel"><div className="panel-title"><h2>Novo profissional</h2></div><form className="stack gap-4" onSubmit={createStaff}>
              <label>Nome<input required value={newStaff.displayName} onChange={e=>setNewStaff({...newStaff,displayName:e.target.value})}/></label>
              <label>E-mail<input required type="email" value={newStaff.email} onChange={e=>setNewStaff({...newStaff,email:e.target.value})}/></label>
              <label>Perfil<select value={newStaff.role} onChange={e=>setNewStaff({...newStaff,role:e.target.value})}><option value="doctor">Médico</option><option value="nurse">Enfermagem</option><option value="reception">Recepção</option><option value="admin">Administrador</option></select></label>
              <label>Senha temporária (mín. 12 caracteres)<input required minLength={12} type="password" value={newStaff.password} onChange={e=>setNewStaff({...newStaff,password:e.target.value})}/></label>
              <button className="primary-button" type="submit"><Plus size={17}/> Cadastrar</button>
            </form><p className="security-note">Verificação em duas etapas disponível em Segurança. A redefinição de senha pelo usuário é item pendente para produção.</p></div></div>
        </section>}
        {view==='assistant'&&<section><div className="page-heading"><div><span className="eyebrow">ASSISTÊNCIA À DOCUMENTAÇÃO</span><h1>Assistente clínico</h1><p>Extração estruturada de uma transcrição para revisão humana.</p></div></div>
          <div className="content-grid"><div className="panel"><div className="panel-title"><h2>Transcrição da consulta</h2><Sparkles size={20}/></div><form onSubmit={askAI} className="stack gap-4">
            <label>Texto a analisar<textarea rows={13} minLength={10} required value={transcript} onChange={e=>setTranscript(e.target.value)} placeholder="Transcrição fornecida pelo profissional. Não inserir informações identificáveis em ambiente sem autorização de tratamento de dados."/></label>
            <button className="primary-button" disabled={loading} type="submit"><Sparkles size={17}/> Extrair informações</button></form>
            <p className="footnote muted">Desabilitado por padrão. Ativar exige configuração contratual do provedor, avaliação de privacidade e permissão na organização.</p>
          </div><div className="panel"><div className="panel-title"><h2>Sugestão para revisão</h2></div>{aiResult?<pre className="ai-json">{JSON.stringify(aiResult,null,2)}</pre>:<div className="empty-state"><Sparkles size={32}/><p>Nenhuma sugestão ainda.</p></div>}<p className="muted footnote">Nenhuma sugestão é registrada ou assinada automaticamente.</p></div></div>
        </section>}
        {view==='record360'&&<section>
          <div className="page-heading"><div><span className="eyebrow">PRONTUÁRIO 360°</span><h1>Prontuário 360°</h1><p>Linha do tempo, alto risco e documentos em uma única visão consolidada.</p></div></div>
          {!patient?<div className="panel empty-state"><ClipboardList size={35}/><h2>Selecione um paciente</h2><p>Comece pela área de pacientes para abrir o prontuário.</p><button className="primary-button" onClick={()=>setView('patients')}>Ir para pacientes <ArrowRight size={16}/></button></div>:
          <Record360Page session={session!} alert={alert} patient={patient} onView={setView}/>}
        </section>}
        {view==='teleconsult'&&<TeleconsultPage session={session!} alert={alert}/>}
        {view==='hospital'&&<HospitalPage session={session!} alert={alert}/>}
        {view==='results'&&<ResultsPage session={session!} alert={alert}/>}
        {view==='templates'&&<TemplatesPage session={session!} alert={alert}/>}
        {view==='metrics'&&<MetricsPage session={session!} alert={alert}/>}
        {view==='lgpd'&&<LgpdPage session={session!} patients={patients} alert={alert}/>}
        {view==='security'&&<SecurityPage session={session!} alert={alert} onMfaDisabled={()=>endSession('Verificação em duas etapas desativada. Entre novamente para continuar.')}/>}
        {view==='prescriptions'&&<PrescriptionsPage session={session!} alert={alert} patient={patient} encounter={encounter} patients={patients} onSelectPatient={p=>void selectPatientForPrescriptions(p)} onView={setView}/>}
      </main>
      <footer className="footer"><div><span className="status-dot"/> StarMed MVP • Ambiente não homologado</div><div className="offline-actions"><LockKeyhole size={15}/><input aria-label="Frase-senha offline" type="password" placeholder="Frase-senha offline (mín. 12)" value={passphrase} onChange={e=>setPassphrase(e.target.value)}/><button onClick={()=>void syncNow()} disabled={loading||!pending||passphrase.length<12}><CloudUpload size={15}/> Sincronizar {pending? '('+pending+')':''}</button></div></footer>
    </div>
  </div>;
}
