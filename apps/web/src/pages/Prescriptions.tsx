import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, AlertTriangle, ArrowRight, Ban, CloudUpload, Download, FileSignature, FileText, Info, KeyRound, Pill, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api, ApiError, EVENT_SESSION_EXPIRED, type Encounter, type Patient, type Session } from '../api';
import { measureEvent } from './perf-metrics';

/**
 * P1/ST-P1-004 (parte web) — JORNADA DE PRESCRIÇÃO na UI de equipe, integrada aos
 * controllers de apps/api/src/prescriptions.ts (adições C6: download do PDF e
 * assinatura PAdES; os demais endpoints permanecem iguais):
 *   GET  /patients/:patientId/prescriptions          → histórico do paciente atual
 *   GET  /encounters/:encounterId/prescriptions      → prescrições do encontro aberto
 *   POST /encounters/:encounterId/prescriptions      → rascunho {operationId,...} → linha + safetyAlerts
 *   PATCH /prescriptions/:id                         → edição de rascunho (schema STRICT: sem operationId)
 *   POST /prescriptions/:id/sign                     → {operationId, overrideJustification?} — SOMENTE doctor
 *   GET  /prescriptions/:id/pdf                      → PDF persistido como BLOB com Bearer (doctor/nurse;
 *                                                      nunca link público; o servidor re-confere o SHA-256)
 *   POST /prescriptions/:id/sign-pades               → PAdES/ICP-Brasil sobre os bytes do PDF (SOMENTE doctor;
 *                                                      exige prescrição atestada 'signed'; CMS detached — o
 *                                                      embarque ByteRange no PDF segue pendente)
 *   POST /prescriptions/:id/cancel                   → {reason} (mín. 8), admin/doctor, nunca apaga
 * safetyAlerts: info | review_required | block — review exige overrideJustification (mín. 20)
 * digitado na tela; block impede a assinatura NO SERVIDOR (422, sem override possível).
 * HONESTIDADE: signature_status 'attested' é exibido como "Atestada (PDF com SHA-256) —
 * assinatura PAdES pendente"; 'pades' como evidência registrada com qualificação
 * TRI-ESTADO (qualified|not_qualified|unknown) — o sistema NUNCA afirma "assinatura válida".
 * 401: o helper api() já dispara EVENT_SESSION_EXPIRED e o App volta ao login — não duplicamos.
 * Prescrição pertence ao encontro: sem encontro utilizável, exibimos orientação (não um formulário morto).
 */

type Alert=(text:string,kind?:'success'|'error'|'info')=>void;
type SafetyAlert={level:'info'|'review_required'|'block';code:string;message:string;substance?:string;criticality?:string;existingPrescriptionId?:string;};
type ApiIssue={path:string;message:string};
type MedicationForm='tablet'|'capsule'|'solution'|'suspension'|'cream'|'ointment'|'injectable'|'inhaler'|'drops'|'other';

type Prescription={
  id:string;encounter_id:string;prescriber_id:string;
  medication_code:string|null;medication_name:string;dose:string;
  dose_value:number|null;dose_unit:string|null;medication_form:string|null;medication_concentration:string|null;
  route:string;frequency:string;duration:string;times:unknown;
  quantity:number|null;indication:string;instructions:string;special_class:string|null;
  status:'draft'|'signed'|'cancelled';signature_status:'none'|'attested'|'pades';
  signed_document_id:string|null;signed_at:string|null;override_justification:string|null;
  cancel_reason:string|null;cancelled_at:string|null;
  created_at:string;updated_at:string;prescriber_name?:string;
};
type SignResult={
  id:string;status:string;signature_status:string;signed_document_id:string|null;signed_at:string|null;
  document?:{id:string;storage_key:string;sha256:string;created_at:string};
  document_sha256?:string;payload_sha256?:string;signature_note?:string;safetyAlerts?:SafetyAlert[];
};
/** Resposta de POST /prescriptions/:id/sign-pades (qualificação tri-estado + revogação). */
type PadesResult={
  prescriptionId:string;signatureId:string;documentType:string;contentDigest:string;
  policyOid:string;timestampAuthority:string|null;signatureIsQualified:boolean|null;
  qualification:'qualified'|'not_qualified'|'unknown';
  signer:{id:string;councilNumber:string;councilState:string};
  revocation:{checked:boolean;status:string|null;source:string|null;checkedAt:string|null;mode:string;reason?:string;note?:string;revokedAt?:string|null};
  padesEmbedding:{embedded:boolean;reason:string};
  note?:string;createdAt:string;
};
type PadesForm={cert:string;chain:string;key:string;crm:string;uf:string;requireTimestamp:boolean};
type DraftForm={
  medName:string;medCode:string;medForm:string;concentration:string;
  doseValue:string;doseUnit:string;route:string;frequency:string;duration:string;
  times:string[];quantity:string;indication:string;instructions:string;
};

const NETWORK='Não foi possível conectar ao StarMed. Tente novamente.';
const errText=(e:unknown)=>e instanceof ApiError?e.message:NETWORK;
/** Base da API (espelha api.ts): usada só para o download BLOB do PDF. */
const apiBase=(import.meta.env.VITE_API_URL||'http://localhost:3001').replace(/\/$/,'');
const HHMM=/^([01]\d|2[0-3]):[0-5]\d$/;
const MED_FORMS:{value:MedicationForm;label:string}[]=[
  {value:'tablet',label:'Comprimido'},{value:'capsule',label:'Cápsula'},{value:'solution',label:'Solução'},
  {value:'suspension',label:'Suspensão'},{value:'cream',label:'Creme'},{value:'ointment',label:'Pomada'},
  {value:'injectable',label:'Injetável'},{value:'inhaler',label:'Inalador'},{value:'drops',label:'Gotas'},
  {value:'other',label:'Outra'}
];
const ROUTES=['Oral','Intravenosa','Intramuscular','Subcutânea','Tópica','Inalatória','Oftálmica','Otológica','Retal','Sublingual'];

const emptyForm=():DraftForm=>({medName:'',medCode:'',medForm:'',concentration:'',doseValue:'',doseUnit:'',route:'',frequency:'',duration:'',times:['08:00'],quantity:'',indication:'',instructions:''});
const fmt=(v?:string|null)=>v?new Date(v).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—';
const statusLabel=(s:string)=>s==='draft'?'Rascunho':s==='signed'?'Atestada':s==='cancelled'?'Cancelada':s;
/** Rotulo honesto do resultado de assinatura — nunca "assinatura válida". */
function signatureLabel(s:string){
  if(s==='attested')return 'Atestada (PDF com SHA-256) — assinatura PAdES pendente';
  if(s==='pades')return 'PAdES registrada no registro da prescrição';
  return 'Sem assinatura digital registrada';
}
/** Rótulos honestos TRI-ESTADO — nunca "assinatura válida". */
const qualificationLabel=(q:'qualified'|'not_qualified'|'unknown')=>
  q==='qualified'?'Qualificada (carimbo de tempo + OIDs ITI no CMS)'
  :q==='not_qualified'?'Não qualificada (sem carimbo de tempo — ex.: AD-RB)'
  :'Qualificação indeterminada na emissão';
function revocationLabel(r:PadesResult['revocation']){
  if(r.status==='good')return `Não revogado (OCSP good${r.source?` via ${r.source}`:''})`;
  if(r.status==='revoked')return `REVOGADO (OCSP${r.revokedAt?` em ${r.revokedAt}`:''})`;
  if(r.status==='unknown')return 'Status OCSP desconhecido para o certificado';
  if(r.status==='unavailable')return `OCSP indisponível${r.reason?` — ${r.reason}`:''}`;
  return r.reason||'OCSP não consultado';
}
/** Extrai blocos PEM de certificado de um texto colado (certificado + cadeia). */
function pemsOf(text:string):string[]{
  const matches=text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return matches?matches:[];
}
const encounterStatus=(s:string)=>s==='in-progress'?'Em atendimento':s==='planned'?'Planejado':s==='finished'?'Concluído':s==='cancelled'?'Cancelado':s;
const encounterType=(t:string)=>t==='consultation'?'Consulta':t==='follow_up'?'Retorno':t==='teleconsultation'?'Teleconsulta':t==='emergency'?'Urgência':t;

function timesOf(t:unknown):string[]{
  if(Array.isArray(t))return t.filter((x):x is string=>typeof x==='string').slice(0,6);
  if(typeof t==='string'){try{const p:unknown=JSON.parse(t);if(Array.isArray(p))return p.filter((x):x is string=>typeof x==='string').slice(0,6);}catch{/* json inesperado: sem horários */}}
  return [];
}
function bodyOf(e:unknown):Record<string,unknown>|null{
  return e instanceof ApiError&&e.body&&typeof e.body==='object'?e.body as Record<string,unknown>:null;
}
function issuesOf(e:unknown):ApiIssue[]{
  const raw=bodyOf(e)?.issues;
  return Array.isArray(raw)?raw.filter((x):x is ApiIssue=>!!x&&typeof x==='object'&&typeof (x as ApiIssue).path==='string'&&typeof (x as ApiIssue).message==='string'):[];
}
function alertsOf(e:unknown):SafetyAlert[]{
  const raw=bodyOf(e)?.alerts;
  if(!Array.isArray(raw))return[];
  return raw.filter(x=>{
    if(!x||typeof x!=='object')return false;
    const a=x as SafetyAlert;
    return (a.level==='info'||a.level==='review_required'||a.level==='block')&&typeof a.message==='string';
  }) as SafetyAlert[];
}
const normTime=(v:string)=>/^\d{2}:\d{2}:\d{2}$/.test(v)?v.slice(0,5):v;

/** Validação no cliente espelhando o zod do backend (dose sem unidade e via ausente invalidadas aqui). */
function validate(f:DraftForm):Record<string,string>{
  const e:Record<string,string>={};
  if(f.medName.trim().length<2)e['medication.name']='Informe o medicamento (mínimo de 2 caracteres).';
  else if(f.medName.trim().length>200)e['medication.name']='Nome do medicamento deve ter até 200 caracteres.';
  if(f.medCode.trim().length>50)e['medication.code']='Código deve ter até 50 caracteres.';
  if(f.concentration.trim().length>60)e['medication.concentration']='Concentração deve ter até 60 caracteres.';
  const dv=Number(f.doseValue);
  if(!f.doseValue.trim()||!Number.isFinite(dv)||dv<=0)e['dose.value']='Dose deve ser um número maior que zero.';
  else if(dv>10000)e['dose.value']='Dose acima do limite aceito (10000).';
  if(!f.doseUnit.trim())e['dose.unit']='Dose sem unidade: informe a unidade (mg, mL, gotas…).';
  else if(f.doseUnit.trim().length>30)e['dose.unit']='Unidade deve ter até 30 caracteres.';
  if(f.route.trim().length<2)e['route']='Via de administração ausente (mínimo de 2 caracteres).';
  else if(f.route.trim().length>60)e['route']='Via deve ter até 60 caracteres.';
  if(!f.frequency.trim())e.frequency='Informe a frequência.';
  else if(f.frequency.trim().length>80)e.frequency='Frequência deve ter até 80 caracteres.';
  if(!f.duration.trim())e.duration='Informe a duração.';
  else if(f.duration.trim().length>80)e.duration='Duração deve ter até 80 caracteres.';
  if(f.times.length<1)e.times='Informe ao menos um horário (HH:MM).';
  else if(f.times.length>6)e.times='Máximo de 6 horários.';
  else f.times.forEach((t,i)=>{if(!HHMM.test(t))e['times.'+i]='Horário '+t+' inválido: use o formato HH:MM.';});
  const q=Number(f.quantity);
  if(!f.quantity.trim()||!Number.isInteger(q)||q<=0)e.quantity='Quantidade deve ser um número inteiro maior que zero.';
  else if(q>9999)e.quantity='Quantidade máxima: 9999.';
  if(f.indication.trim().length<2||f.indication.trim().length>500)e.indication='Indicação deve ter entre 2 e 500 caracteres.';
  if(f.instructions.trim().length<2||f.instructions.trim().length>2000)e.instructions='Orientações devem ter entre 2 e 2000 caracteres.';
  return e;
}
type CreatePayload={
  medication:{name:string;code?:string;form?:MedicationForm;concentration?:string};
  dose:{value:number;unit:string};
  route:string;frequency:string;duration:string;times:string[];quantity:number;indication:string;instructions:string;
};
function payloadOf(f:DraftForm):CreatePayload{
  const code=f.medCode.trim(),conc=f.concentration.trim();
  return {
    medication:{name:f.medName.trim(),...(code?{code}:{}),...(f.medForm?{form:f.medForm as MedicationForm}:{}),...(conc?{concentration:conc}:{})},
    dose:{value:Number(f.doseValue),unit:f.doseUnit.trim()},
    route:f.route.trim(),frequency:f.frequency.trim(),duration:f.duration.trim(),
    times:[...f.times],quantity:Number(f.quantity),indication:f.indication.trim(),instructions:f.instructions.trim()
  };
}
function formOf(rx:Prescription):DraftForm{
  return{
    medName:rx.medication_name,medCode:rx.medication_code??'',medForm:rx.medication_form??'',concentration:rx.medication_concentration??'',
    doseValue:rx.dose_value!=null?String(rx.dose_value):'',doseUnit:rx.dose_unit??'',route:rx.route,frequency:rx.frequency,duration:rx.duration,
    times:timesOf(rx.times),quantity:rx.quantity!=null?String(rx.quantity):'',indication:rx.indication,instructions:rx.instructions
  };
}

function InlineError({text}:{text:string}){
  return <div className="inline-error" role="alert"><AlertCircle size={16}/>{text}</div>;
}

/** Painel de safetyAlerts com níveis VISUALMENTE distintos (badge textual + cor + ícone). */
function SafetyAlertsPanel({alerts,rxId,override,onOverride,overrideError,onRecheck,rechecking}:{
  alerts:SafetyAlert[];rxId:string|null;override:string;onOverride:(v:string)=>void;overrideError:string;
  onRecheck?:()=>void;rechecking?:boolean;
}){
  if(alerts.length===0)return null;
  const groups=[
    {level:'block' as const,label:'BLOQUEIO',title:'Assinatura bloqueada',Icon:Ban},
    {level:'review_required' as const,label:'REVISÃO OBRIGATÓRIA',title:'Exige justificativa auditável',Icon:AlertTriangle},
    {level:'info' as const,label:'INFORMATIVO',title:'Não impede a assinatura',Icon:Info}
  ];
  const hasReview=alerts.some(a=>a.level==='review_required');
  return <div className="panel" role="region" aria-label="Alertas de segurança medicamentosa">
    <div className="panel-title"><h2>Segurança medicamentosa</h2>
      {rxId&&<span className="small-pill">RX {rxId.slice(0,8)}</span>}</div>
    <p className="muted footnote">Níveis: <strong>informativo</strong> (orientação), <strong>revisão obrigatória</strong> (exige justificativa digitada, enviada ao servidor como overrideJustification) e <strong>bloqueio</strong> (assinatura bloqueada no servidor, sem override).</p>
    {groups.filter(g=>alerts.some(a=>a.level===g.level)).map(g=>{
      const Icon=g.Icon;
      return <div className={'rx-alert '+g.level} key={g.level} role={g.level==='info'?'status':'alert'}>
        <div className="rx-alert-head"><Icon size={16} className="rx-alert-icon"/>
          <span className="rx-alert-badge">{g.label}</span>
          <strong>{g.title}</strong></div>
        {alerts.filter(a=>a.level===g.level).map(a=><p key={a.code+a.message}>{a.message}</p>)}
        {g.level==='block'&&<p className="rx-alert-strong">Assinatura bloqueada: esta prescrição não pode ser assinada enquanto o bloqueio estiver presente. O servidor recusa a assinatura mesmo com justificativa.</p>}
        {g.level==='review_required'&&<p className="rx-alert-strong">Revisão obrigatória: a assinatura exige a justificativa clínica digitada abaixo (mínimo de 20 caracteres), registrada em auditoria.</p>}
      </div>;
    })}
    {hasReview&&<div className="stack gap-3">
      <label htmlFor="rx-override">Justificativa clínica para assinar sob revisão (mínimo de 20 caracteres)
        <textarea id="rx-override" rows={3} maxLength={2000} value={override} onChange={e=>onOverride(e.target.value)}
          aria-invalid={!!overrideError}
          placeholder="Descreva a revisão realizada: por que o benefício supera o risco neste paciente."/>
        {overrideError&&<InlineError text={overrideError}/>}
        <small className="muted">Enviada ao servidor como overrideJustification no ato da assinatura e registrada em auditoria.</small>
      </label>
    </div>}
    {onRecheck&&<div className="action-row">
      <button type="button" className="secondary-button" disabled={rechecking} onClick={onRecheck}><RefreshCw size={15}/> {rechecking?'Reavaliando…':'Reavaliar segurança'}</button>
    </div>}
  </div>;
}

function RxDetails({rx}:{rx:Prescription}){
  return <>
    <dl className="rx-fields">
      <div><dt>Medicamento</dt><dd>{rx.medication_name}{rx.medication_concentration?` (${rx.medication_concentration})`:''}{rx.medication_form?` • ${MED_FORMS.find(f=>f.value===rx.medication_form)?.label??rx.medication_form}`:''}{rx.medication_code?` • cód. ${rx.medication_code}`:''}</dd></div>
      <div><dt>Dose</dt><dd>{rx.dose||`${rx.dose_value} ${rx.dose_unit}`}</dd></div>
      <div><dt>Via</dt><dd>{rx.route}</dd></div>
      <div><dt>Frequência</dt><dd>{rx.frequency}</dd></div>
      <div><dt>Duração</dt><dd>{rx.duration}</dd></div>
      <div><dt>Horários</dt><dd>{timesOf(rx.times).join(', ')||'—'}</dd></div>
      <div><dt>Quantidade</dt><dd>{rx.quantity??'—'}</dd></div>
      <div><dt>Indicação</dt><dd>{rx.indication}</dd></div>
      <div><dt>Orientações</dt><dd>{rx.instructions}</dd></div>
      <div><dt>Prescritor</dt><dd>{rx.prescriber_name||'—'}</dd></div>
      {rx.status==='cancelled'&&<div><dt>Motivo do cancelamento</dt><dd>{rx.cancel_reason||'—'}</dd></div>}
      {rx.override_justification&&<div><dt>Justificativa de override</dt><dd>{rx.override_justification}</dd></div>}
    </dl>
    {rx.status==='signed'&&<p className="rx-sign-status"><ShieldCheck size={15}/> {signatureLabel(rx.signature_status)}{rx.signed_at?` • assinada em ${fmt(rx.signed_at)}`:''}</p>}
    {rx.status==='cancelled'&&<p className="muted footnote">Cancelada em {fmt(rx.cancelled_at)} — registro e documento permanecem preservados com rastro completo.</p>}
  </>;
}

export function PrescriptionsPage({session,alert,patient,encounter,patients,onSelectPatient,onView}:{
  session:Session;alert:Alert;patient:Patient|null;encounter:Encounter|null;patients:Patient[];
  onSelectPatient:(p:Patient)=>void;onView:(v:'patients'|'record')=>void;
}){
  const token=session.accessToken;
  const role=session.user.role;
  const canDraft=role==='doctor'||role==='admin';
  const canSign=role==='doctor';
  const canDownload=role==='doctor'||role==='nurse';

  const [patientList,setPatientList]=useState<Prescription[]>([]);
  const [encounterList,setEncounterList]=useState<Prescription[]>([]);
  const [loading,setLoading]=useState(false);
  const [loadError,setLoadError]=useState('');
  const [pickId,setPickId]=useState('');

  const [form,setForm]=useState<DraftForm>(emptyForm);
  const [editingId,setEditingId]=useState<string|null>(null);
  const [errors,setErrors]=useState<Record<string,string>>({});
  const [saving,setSaving]=useState(false);
  const [savedNote,setSavedNote]=useState('');
  const [alerts,setAlerts]=useState<SafetyAlert[]>([]);
  const [alertsRxId,setAlertsRxId]=useState<string|null>(null);
  const [override,setOverride]=useState('');
  const [rechecking,setRechecking]=useState(false);
  const [signingId,setSigningId]=useState<string|null>(null);
  const [signResult,setSignResult]=useState<SignResult|null>(null);
  const [cancelId,setCancelId]=useState<string|null>(null);
  const [cancelReason,setCancelReason]=useState('');
  const [cancelBusy,setCancelBusy]=useState(false);
  const [downloadingId,setDownloadingId]=useState<string|null>(null);
  const [padesId,setPadesId]=useState<string|null>(null);
  const [padesForm,setPadesForm]=useState<PadesForm>({cert:'',chain:'',key:'',crm:'',uf:'',requireTimestamp:false});
  const [padesBusy,setPadesBusy]=useState(false);
  const [padesResult,setPadesResult]=useState<PadesResult|null>(null);
  const [padesError,setPadesError]=useState('');
  const [padesFieldErrors,setPadesFieldErrors]=useState<Record<string,string>>({});

  async function load(){
    if(!patient){setPatientList([]);setEncounterList([]);return;}
    setLoading(true);setLoadError('');
    try{
      const pl=await api<Prescription[]>('/patients/'+patient.id+'/prescriptions',token);
      setPatientList(pl);
      if(encounter&&encounter.patient_id===patient.id&&encounter.status!=='cancelled'){
        setEncounterList(await api<Prescription[]>('/encounters/'+encounter.id+'/prescriptions',token));
      }else setEncounterList([]);
    }catch(e){setLoadError(errText(e));}
    finally{setLoading(false);}
  }
  useEffect(()=>{void load();},[patient?.id,encounter?.id,token]);
  // Troca de paciente limpa o contexto clínico exibido (alertas, edição, resultado de assinatura).
  useEffect(()=>{
    setAlerts([]);setAlertsRxId(null);setOverride('');setSignResult(null);
    setCancelId(null);setCancelReason('');setErrors({});setSavedNote('');
    setForm(emptyForm());setEditingId(null);
    setPadesId(null);setPadesResult(null);setPadesError('');setPadesFieldErrors({});
    setPadesForm({cert:'',chain:'',key:'',crm:'',uf:'',requireTimestamp:false});
  },[patient?.id]);

  const err=(k:string)=>errors[k]?<InlineError text={errors[k]}/>:null;
  const setField=<K extends keyof DraftForm>(k:K,v:DraftForm[K])=>setForm(f=>({...f,[k]:v}));
  const alertsFor=(id:string)=>alertsRxId===id?alerts:[];
  const blocked=(id:string)=>alertsFor(id).some(a=>a.level==='block');
  const needsOverride=(id:string)=>alertsFor(id).some(a=>a.level==='review_required');

  function applyIssues(list:ApiIssue[]){
    if(!list.length)return;
    setErrors(prev=>{const n={...prev};for(const i of list)n[i.path||'_']=i.message;return n;});
  }

  async function saveDraft(e:FormEvent){
    e.preventDefault();
    if(!patient||!encounter||encounter.status==='cancelled'||encounter.patient_id!==patient.id)return;
    const client=validate(form);
    setErrors(client);
    if(Object.keys(client).length){alert('Corrija os campos destacados antes de salvar.','error');return;}
    setSaving(true);
    const payload=payloadOf(form);
    try{
      const r=editingId
        ? await api<Prescription&{safetyAlerts?:SafetyAlert[]}>('/prescriptions/'+editingId,token,'PATCH',payload)
        : await api<Prescription&{safetyAlerts?:SafetyAlert[]}>('/encounters/'+encounter.id+'/prescriptions',token,'POST',{operationId:crypto.randomUUID(),...payload});
      setErrors({});
      if(Array.isArray(r.safetyAlerts)){setAlerts(r.safetyAlerts);setAlertsRxId(r.id);}
      setEditingId(r.id);
      setSavedNote(`Rascunho ${editingId?'atualizado':'salvo'} às ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})} para ${patient.fullName}. Ainda NÃO está assinado: a assinatura é uma etapa separada e só ela emite o PDF.`);
      alert('Rascunho salvo — prescrição ainda não assinada.','info');
      await load();
    }catch(err2){
      const iss=issuesOf(err2);
      if(iss.length){applyIssues(iss);alert('Dados recusados pelo servidor: corrija os campos destacados.','error');}
      else alert(errText(err2),'error');
    }finally{setSaving(false);}
  }

  function startEdit(rx:Prescription){
    setForm(formOf(rx));setEditingId(rx.id);setErrors({});setSavedNote('');
    window.setTimeout(()=>document.getElementById('rx-form')?.scrollIntoView({block:'start'}),0);
  }
  function resetForm(){setForm(emptyForm());setEditingId(null);setErrors({});setSavedNote('');}

  /** PATCH usado como "reavaliar": reenvia a linha atual para o servidor recalcular safetyAlerts. */
  async function recheck(rx:Prescription){
    setRechecking(true);
    try{
      const r=await api<Prescription&{safetyAlerts?:SafetyAlert[]}>('/prescriptions/'+rx.id,token,'PATCH',payloadOf(formOf(rx)));
      if(Array.isArray(r.safetyAlerts)){setAlerts(r.safetyAlerts);setAlertsRxId(rx.id);}
      alert('Segurança medicamentosa reavaliada pelo servidor.','info');
      await load();
    }catch(e){
      const iss=issuesOf(e);applyIssues(iss);
      alert(iss.length?'Dados recusados pelo servidor ao reavaliar.':errText(e),'error');
    }finally{setRechecking(false);}
  }

  async function sign(rx:Prescription){
    if(!canSign||signingId)return;
    const review=needsOverride(rx.id);
    const just=override.trim();
    if(review&&just.length<20){
      setErrors(p=>({...p,override:'Justificativa obrigatória: mínimo de 20 caracteres para assinar sob revisão.'}));
      document.getElementById('rx-override')?.focus();
      alert('Alerta de revisão obrigatória: digite a justificativa antes de assinar.','error');
      return;
    }
    setErrors(p=>({...p,override:''}));
    setSigningId(rx.id);
    try{
      const body:{operationId:string;overrideJustification?:string}={operationId:crypto.randomUUID()};
      if(just)body.overrideJustification=just;
      // Métrica 'create_prescription' (ST-P1-012): emitir/atestar a prescrição.
      const r=await measureEvent(token,'create_prescription',()=>api<SignResult>('/prescriptions/'+rx.id+'/sign',token,'POST',body));
      setSignResult(r);
      if(Array.isArray(r.safetyAlerts)){setAlerts(r.safetyAlerts);setAlertsRxId(rx.id);}
      setOverride('');
      alert('Prescrição atestada: PDF emitido com SHA-256. Assinatura PAdES pendente — não constitui assinatura qualificada.','success');
      await load();
    }catch(e){
      const als=alertsOf(e);
      if(als.length){setAlerts(als);setAlertsRxId(rx.id);}
      applyIssues(issuesOf(e));
      if(als.some(a=>a.level==='block'))alert('Assinatura bloqueada pela segurança medicamentosa: o bloqueio não admite override.','error');
      else if(e instanceof ApiError&&e.status===409&&als.some(a=>a.level==='review_required'))alert('Revisão obrigatória: informe a justificativa (mínimo de 20 caracteres) no painel de alertas e assine novamente.','error');
      else if(issuesOf(e).length)alert('Dados recusados pelo servidor: corrija os campos destacados.','error');
      else alert(errText(e),'error');
    }finally{setSigningId(null);}
  }

  /** Download do PDF persistido: BLOB com Bearer (nunca link público). Erros são
   *  honestos: 404 = sem artefato persistido; 500 = documento corrompido (hash divergente). */
  async function downloadPdf(rx:Prescription){
    if(downloadingId)return;
    setDownloadingId(rx.id);
    try{
      const response=await fetch(apiBase+'/prescriptions/'+rx.id+'/pdf',{
        method:'GET',cache:'no-store',headers:{Authorization:'Bearer '+token}
      });
      if(response.status===401){window.dispatchEvent(new Event(EVENT_SESSION_EXPIRED));return;}
      if(!response.ok){
        const data:unknown=await response.json().catch(()=>null);
        const message=data&&typeof data==='object'&&typeof (data as {message?:unknown}).message==='string'
          ?(data as {message:string}).message:'Falha ao baixar o PDF da prescrição.';
        alert(message,'error');return;
      }
      const blob=await response.blob();
      const url=URL.createObjectURL(blob);
      const anchor=document.createElement('a');
      anchor.href=url;anchor.download='prescricao-'+rx.id.slice(0,8)+'.pdf';
      document.body.appendChild(anchor);anchor.click();anchor.remove();
      URL.revokeObjectURL(url);
    }catch{alert(NETWORK,'error');}
    finally{setDownloadingId(null);}
  }

  function openPades(rx:Prescription){
    setPadesId(padesId===rx.id?null:rx.id);
    setPadesResult(null);setPadesError('');setPadesFieldErrors({});
  }

  async function submitPades(e:FormEvent){
    e.preventDefault();
    if(!padesId||padesBusy)return;
    const client:Record<string,string>={};
    const pems=pemsOf(padesForm.cert);
    if(pems.length!==1)client.cert='Cole exatamente UM certificado do signatário em PEM (begin/end CERTIFICATE).';
    if(padesForm.chain.trim()&&pemsOf(padesForm.chain).length===0)client.chain='Cadeia em PEM inválida: cole blocos -----BEGIN CERTIFICATE----- / -----END CERTIFICATE----- ou deixe vazio.';
    if(!/-----BEGIN (ENCRYPTED |)?PRIVATE KEY-----/.test(padesForm.key))client.key='Cole a chave privada em PEM (PKCS#8, -----BEGIN PRIVATE KEY-----).';
    if(!/^[0-9]{4,6}$/.test(padesForm.crm.trim()))client.crm='CRM deve ter 4 a 6 dígitos.';
    if(!/^[A-Z]{2}$/.test(padesForm.uf.trim().toUpperCase()))client.uf='UF deve ser a sigla de 2 letras (ex.: SP).';
    setPadesFieldErrors(client);
    if(Object.keys(client).length){alert('Corrija os campos do certificado antes de assinar.','error');return;}
    setPadesBusy(true);setPadesError('');
    try{
      const chainPems=pemsOf(padesForm.chain);
      const r=await api<PadesResult>('/prescriptions/'+padesId+'/sign-pades',token,'POST',{
        signerCertPem:pems[0],
        chainPems,
        privateKeyPkcs8Pem:padesForm.key.trim(),
        councilNumber:padesForm.crm.trim(),
        councilState:padesForm.uf.trim().toUpperCase(),
        requireTimestamp:padesForm.requireTimestamp
      });
      setPadesResult(r);setPadesId(null);
      alert('PAdES registrada para a prescrição. '+(r.note||''),'success');
      await load();
    }catch(err2){
      const message=errText(err2);
      const status=err2 instanceof ApiError?err2.status:null;
      const hint=status===400?' (recusa do servidor: certificado/cadeia/LPA/ACT)'
        :status===409?' (conflito: prescrição não atestada ou já assinada com PAdES)'
        :status===403?' (permissão: somente médico ativo — ou certificado bloqueado por REVOCATION_MODE=hard)'
        :status===404?' (prescrição ou PDF não encontrado)'
        :status===500?' (documento corrompido ou erro interno — veja o motivo do servidor)'
        :status===502||status===503?' (autoridade de carimbo de tempo indisponível/recusou)'
        :'';
      setPadesError(message+hint);
      alert(message,'error');
    }finally{setPadesBusy(false);}
  }

  async function submitCancel(e:FormEvent){
    e.preventDefault();
    if(!cancelId)return;
    const reason=cancelReason.trim();
    if(reason.length<8){setErrors(p=>({...p,_cancel:'Motivo deve ter ao menos 8 caracteres.'}));return;}
    setCancelBusy(true);
    try{
      await api('/prescriptions/'+cancelId+'/cancel',token,'POST',{reason});
      alert('Prescrição cancelada com motivo registrado. Nada é apagado: o rastro (autor, horário, motivo) permanece.','success');
      setCancelId(null);setCancelReason('');setErrors(p=>({...p,_cancel:''}));
      if(alertsRxId===cancelId){setAlerts([]);setAlertsRxId(null);setOverride('');}
      await load();
    }catch(err2){
      const iss=issuesOf(err2);
      if(iss.length){applyIssues(iss);alert('Motivo recusado pelo servidor.','error');}
      else alert(errText(err2),'error');
    }finally{setCancelBusy(false);}
  }

  function pickPatient(){
    const p=patients.find(x=>x.id===pickId);
    if(p)onSelectPatient(p);
  }

  const encUsable=!!encounter&&!!patient&&encounter.patient_id===patient.id&&encounter.status!=='cancelled';
  const recheckTarget=alertsRxId?patientList.find(x=>x.id===alertsRxId):undefined;

  return <section>
    <div className="page-heading"><div><span className="eyebrow">PRESCRIÇÃO ELETRÔNICA</span><h1>Prescrições</h1>
      <p>Campos estruturados obrigatórios, segurança medicamentosa e assinatura médica no contexto do atendimento.</p></div></div>

    {!patient?<div className="panel empty-state">
      <Pill size={35}/>
      <h2>Selecione um paciente</h2>
      <p>As prescrições são consultadas por paciente e criadas a partir de um atendimento. Escolha um paciente abaixo ou localize-o na área de Pacientes.</p>
      <div className="stack gap-3">
        <label>Paciente
          <select value={pickId} onChange={e=>setPickId(e.target.value)}>
            <option value="">Selecione um paciente…</option>
            {patients.map(p=><option key={p.id} value={p.id}>{p.fullName}</option>)}
          </select>
        </label>
        {patients.length===0&&<p className="muted footnote">Nenhum paciente carregado nesta sessão — use "Buscar paciente" para pesquisar.</p>}
        <div className="action-row">
          <button type="button" className="primary-button" disabled={!pickId} onClick={pickPatient}>Abrir prescrições <ArrowRight size={16}/></button>
          <button type="button" className="secondary-button" onClick={()=>onView('patients')}>Buscar paciente</button>
        </div>
      </div>
    </div>:
    <>
      <div className="patient-header">
        <div className="patient-avatar large">{patient.fullName.slice(0,1).toUpperCase()}</div>
        <div><span className="eyebrow">PACIENTE SELECIONADO</span><h2>{patient.fullName}</h2>
          <p>Nascimento: {String(patient.birthDate).slice(0,10)}</p></div>
        <span className="small-pill">ID {patient.id.slice(0,8)}</span>
        {role!=='admin'&&<button type="button" className="secondary-button" onClick={()=>onView('record')}>Prontuário</button>}
      </div>

      <div className="content-grid" style={{alignItems:'start'}}>
        <div className="panel" aria-busy={loading}>
          <div className="panel-title"><h2>Prescrições do paciente</h2>
            <button type="button" className="text-button" onClick={()=>void load()}><RefreshCw size={14}/> Atualizar</button></div>
          <p className="muted footnote">{patientList.length} prescrição(ões) • histórico completo do paciente.</p>
          {loadError&&<InlineError text={loadError}/>}
          {loading&&patientList.length===0&&<p className="muted" role="status">Carregando prescrições…</p>}
          {!loading&&!loadError&&patientList.length===0&&<div className="empty-state"><Pill size={28}/><p>Nenhuma prescrição registrada para este paciente.</p></div>}
          {patientList.map(rx=><div key={rx.id}>
            <div className="list-line">
              <div className="list-icon"><Pill size={18}/></div>
              <div><strong>{rx.medication_name}</strong>
                <small>{rx.dose||`${rx.dose_value} ${rx.dose_unit}`} • {rx.route} • {rx.frequency} • {fmt(rx.created_at)}{rx.prescriber_name?` • ${rx.prescriber_name}`:''}</small></div>
              <span className={'small-pill '+(rx.status==='signed'?'pill-signed':'')}>{statusLabel(rx.status)}</span>
            </div>
            <div className="action-row">
              {canSign&&rx.status==='draft'&&<button type="button" className="primary-button" disabled={signingId!==null||blocked(rx.id)} onClick={()=>void sign(rx)}>
                <ShieldCheck size={16}/> {signingId===rx.id?'Assinando…':needsOverride(rx.id)?'Assinar com justificativa':'Assinar'}</button>}
              {canDraft&&rx.status==='draft'&&<button type="button" className="secondary-button" onClick={()=>startEdit(rx)}><FileSignature size={15}/> Editar rascunho</button>}
              {canDownload&&rx.status==='signed'&&<button type="button" className="secondary-button" disabled={downloadingId===rx.id} onClick={()=>void downloadPdf(rx)}>
                <Download size={15}/> {downloadingId===rx.id?'Baixando…':'Baixar PDF'}</button>}
              {canSign&&rx.status==='signed'&&rx.signature_status!=='pades'&&<button type="button" className="secondary-button" onClick={()=>openPades(rx)}>
                <KeyRound size={15}/> {padesId===rx.id?'Fechar certificado':'Assinar com certificado ICP-Brasil…'}</button>}
              {canDraft&&rx.status!=='cancelled'&&cancelId!==rx.id&&<button type="button" className="secondary-button" onClick={()=>{setCancelId(rx.id);setCancelReason('');setErrors(p=>({...p,_cancel:''}));}}><Ban size={15}/> Cancelar…</button>}
            </div>
            {padesId===rx.id&&<form className="stack gap-3" onSubmit={submitPades}>
              <p className="muted footnote">Assinatura PAdES/ICP-Brasil sobre os <strong>bytes do PDF persistido</strong> (a prescrição já está atestada). A chave privada é usada <strong>em memória no servidor e nunca armazenada</strong> — para produção, prefira custódia em KMS/HSM. O CMS sai como evidência detached: o embarque da assinatura no PDF (ByteRange) segue pendente.</p>
              <label>Certificado do signatário (e-CPF) em PEM <span className="required"> *</span>
                <textarea rows={3} value={padesForm.cert} onChange={e=>setPadesForm(f=>({...f,cert:e.target.value}))}
                  aria-invalid={!!padesFieldErrors.cert}
                  placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}/>
                {padesFieldErrors.cert&&<InlineError text={padesFieldErrors.cert}/>}
              </label>
              <label>Cadeia de certificação (intermediárias em PEM, opcional)
                <textarea rows={2} value={padesForm.chain} onChange={e=>setPadesForm(f=>({...f,chain:e.target.value}))}
                  aria-invalid={!!padesFieldErrors.chain}
                  placeholder="Cole os blocos PEM das intermediárias, se o e-CPF não as incluir."/>
                {padesFieldErrors.chain&&<InlineError text={padesFieldErrors.chain}/>}
              </label>
              <label>Chave privada PKCS#8 (PEM) <span className="required"> *</span>
                <textarea rows={3} value={padesForm.key} onChange={e=>setPadesForm(f=>({...f,key:e.target.value}))}
                  aria-invalid={!!padesFieldErrors.key}
                  placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}/>
                {padesFieldErrors.key&&<InlineError text={padesFieldErrors.key}/>}
                <small className="muted">Usada em memória pelo servidor e descartada — não é persistida em lugar algum.</small>
              </label>
              <div className="rx-grid">
                <label>CRM (4 a 6 dígitos) <span className="required"> *</span>
                  <input value={padesForm.crm} maxLength={6} inputMode="numeric" onChange={e=>setPadesForm(f=>({...f,crm:e.target.value}))}
                    aria-invalid={!!padesFieldErrors.crm} placeholder="Ex.: 123456"/>
                  {padesFieldErrors.crm&&<InlineError text={padesFieldErrors.crm}/>}
                </label>
                <label>UF do conselho <span className="required"> *</span>
                  <input value={padesForm.uf} maxLength={2} onChange={e=>setPadesForm(f=>({...f,uf:e.target.value.toUpperCase()}))}
                    aria-invalid={!!padesFieldErrors.uf} placeholder="Ex.: SP"/>
                  {padesFieldErrors.uf&&<InlineError text={padesFieldErrors.uf}/>}
                </label>
              </div>
              <label style={{display:'flex',alignItems:'center',gap:'8px'}}>
                <input type="checkbox" checked={padesForm.requireTimestamp} onChange={e=>setPadesForm(f=>({...f,requireTimestamp:e.target.checked}))}/>
                Exigir carimbo de tempo (ACT/AD-RT) — sem ACT configurada (TSA_URL) o servidor recusa com 400; falha da ACT aborta a emissão.
              </label>
              {padesError&&<InlineError text={padesError}/>}
              <div className="action-row">
                <button type="button" className="secondary-button" onClick={()=>setPadesId(null)}>Voltar</button>
                <button type="submit" className="primary-button" disabled={padesBusy}>
                  <KeyRound size={16}/> {padesBusy?'Assinando PAdES…':'Assinar PDF com certificado ICP-Brasil'}</button>
              </div>
            </form>}
            {padesResult&&padesResult.prescriptionId===rx.id&&<div className="panel">
              <div className="panel-title"><h2>Evidência PAdES da prescrição</h2>
                <button type="button" className="text-button" onClick={()=>setPadesResult(null)}><X size={14}/> Fechar</button></div>
              <div className="rx-sign-status"><ShieldCheck size={15}/> {qualificationLabel(padesResult.qualification)}</div>
              <dl className="rx-fields">
                <div><dt>Assinatura ID</dt><dd>{padesResult.signatureId.slice(0,8)}</dd></div>
                <div><dt>SHA-256 do PDF assinado</dt><dd className="rx-hash">{padesResult.contentDigest}</dd></div>
                <div><dt>Política (LPA)</dt><dd>{padesResult.policyOid}</dd></div>
                <div><dt>Carimbo de tempo</dt><dd>{padesResult.timestampAuthority||'sem carimbo (AD-RB)'}</dd></div>
                <div><dt>CRM/UF do signatário</dt><dd>{padesResult.signer.councilNumber}/{padesResult.signer.councilState}</dd></div>
                <div><dt>Revogação (OCSP)</dt><dd>{revocationLabel(padesResult.revocation)}</dd></div>
                <div><dt>Emitida em</dt><dd>{fmt(padesResult.createdAt)}</dd></div>
              </dl>
              <p className="muted footnote">{padesResult.padesEmbedding.reason}</p>
              <p className="muted footnote">{padesResult.note||'Evidência PAdES registrada. O sistema não afirma "assinatura válida": a validação oficial é a do verificador do ITI.'}</p>
            </div>}
            {cancelId===rx.id&&<form className="stack gap-3" onSubmit={submitCancel}>
              <label>Motivo do cancelamento <span className="required"> *</span> — mínimo de 8 caracteres; o registro é preservado com rastro.
                <textarea rows={2} required minLength={8} maxLength={1000} value={cancelReason} onChange={e=>setCancelReason(e.target.value)}
                  placeholder="Ex.: Prescrição duplicada após revisão do tratamento"/>
              </label>
              {err('_cancel')}
              <div className="action-row">
                <button type="button" className="secondary-button" onClick={()=>{setCancelId(null);setCancelReason('');}}>Voltar</button>
                <button type="submit" className="primary-button" disabled={cancelBusy||cancelReason.trim().length<8}>{cancelBusy?'Cancelando…':'Confirmar cancelamento'}</button>
              </div>
            </form>}
            <details className="clinical-details"><summary>Detalhes da prescrição</summary>
              <RxDetails rx={rx}/>
            </details>
          </div>)}
        </div>

        {encUsable&&encounter&&<div className="panel">
          <div className="panel-title"><h2>Prescrições deste atendimento</h2>
            <span className="small-pill">{encounterStatus(encounter.status)}</span></div>
          <p className="muted footnote">{encounterType(encounter.type)} • iniciado em {fmt(encounter.started_at)} • ID {encounter.id.slice(0,8)}</p>
          {loading&&encounterList.length===0&&<p className="muted" role="status">Carregando…</p>}
          {!loading&&encounterList.length===0&&<p className="muted empty-state">Nenhuma prescrição neste atendimento ainda.</p>}
          {encounterList.map(rx=><div className="list-line" key={rx.id}>
            <div className="list-icon"><Pill size={18}/></div>
            <div><strong>{rx.medication_name}</strong>
              <small>{rx.dose||`${rx.dose_value} ${rx.dose_unit}`} • {rx.route} • {fmt(rx.created_at)}</small></div>
            <span className={'small-pill '+(rx.status==='signed'?'pill-signed':'')}>{statusLabel(rx.status)}</span>
          </div>)}
          <p className="muted footnote">Ações (editar, assinar, cancelar) ficam na lista completa do paciente ao lado.</p>
        </div>}
      </div>

      <div className="stack gap-5">
        {alerts.length>0&&<SafetyAlertsPanel alerts={alerts} rxId={alertsRxId} override={override} onOverride={v=>setOverride(v)}
          overrideError={errors.override||''}
          onRecheck={recheckTarget&&recheckTarget.status==='draft'?()=>void recheck(recheckTarget):undefined}
          rechecking={rechecking}/>}

        {signResult&&<div className="panel">
          <div className="panel-title"><h2>Resultado da assinatura</h2>
            <button type="button" className="text-button" onClick={()=>setSignResult(null)}><X size={14}/> Fechar</button></div>
          <div className="rx-sign-status"><ShieldCheck size={15}/> {signatureLabel(signResult.signature_status||'attested')}</div>
          <dl className="rx-fields">
            <div><dt>Status do registro</dt><dd>{signResult.status}</dd></div>
            <div><dt>Documento</dt><dd>{signResult.document?.id?'PDF '+signResult.document.id.slice(0,8):(signResult.signed_document_id??'—')}</dd></div>
            <div><dt>Assinada em</dt><dd>{fmt(signResult.signed_at)}</dd></div>
            {signResult.document_sha256&&<div><dt>SHA-256 do PDF</dt><dd className="rx-hash">{signResult.document_sha256}</dd></div>}
            {signResult.payload_sha256&&<div><dt>SHA-256 do conteúdo</dt><dd className="rx-hash">{signResult.payload_sha256}</dd></div>}
          </dl>
          <p className="muted footnote">{signResult.signature_note||'Documento emitido, persistido (bytes + SHA-256) e hasheado (atestado). A assinatura PAdES/ICP-Brasil é uma etapa separada: enquanto for "Atestada", não constitui assinatura qualificada.'}</p>
          <p className="muted footnote">O sistema não afirma "assinatura válida": a assinatura PAdES qualificada é a etapa "Assinar com certificado ICP-Brasil" (e a validação oficial é a do verificador do ITI).</p>
        </div>}

        {!encUsable?<div className="panel empty-state">
          <FileText size={35}/>
          <h2>Prescrição exige um atendimento em aberto</h2>
          <p>{encounter&&encounter.status==='cancelled'
            ? 'O atendimento selecionado está cancelado e não aceita prescrições. Abra ou inicie outro atendimento no prontuário.'
            : 'No StarMed a prescrição pertence ao atendimento: sem um encontro aberto não existe formulário de prescrição. Abra (ou inicie) um atendimento no prontuário deste paciente para criar um rascunho.'}</p>
          {role!=='admin'&&<div className="action-row">
            <button type="button" className="primary-button" onClick={()=>onView('record')}>Ir para o prontuário <ArrowRight size={16}/></button>
          </div>}
          <p className="muted footnote">A consulta acima continua disponível: assinar e cancelar prescrições existentes independe de haver encontro em aberto.</p>
        </div>:
        !canDraft?<div className="panel"><p className="muted">Somente médicos e administradores criam e editam prescrições. Este perfil pode consultar o histórico acima.</p></div>:
        <div className="panel">
          <div className="panel-title"><div><span className="eyebrow">RASCUNHO ESTRUTURADO</span>
            <h2>{editingId?'Editar prescrição':'Nova prescrição'}</h2></div>
            {editingId&&<span className="small-pill">Rascunho {editingId.slice(0,8)}</span>}</div>
          {savedNote&&<div className="recovery-once" role="status">
            <div className="recovery-once-head"><AlertCircle size={18}/><strong>Rascunho salvo — ainda não assinado</strong></div>
            <p className="muted">{savedNote}</p>
          </div>}
          <form id="rx-form" className="stack gap-3" onSubmit={saveDraft}>
            <div className="rx-grid">
              <label>Nome do medicamento <span className="required"> *</span>
                <input value={form.medName} maxLength={200} onChange={e=>setField('medName',e.target.value)}
                  placeholder="Ex.: Losartana potássica" aria-invalid={!!errors['medication.name']}/>
                {err('medication.name')}
              </label>
              <label>Código (opcional)
                <input value={form.medCode} maxLength={50} onChange={e=>setField('medCode',e.target.value)}
                  placeholder="Ex.: DCB/HC6" aria-invalid={!!errors['medication.code']}/>
                {err('medication.code')}
              </label>
              <label>Forma farmacêutica (opcional)
                <select value={form.medForm} onChange={e=>setField('medForm',e.target.value)}>
                  <option value="">Não informar</option>
                  {MED_FORMS.map(f=><option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </label>
              <label>Concentração (opcional)
                <input value={form.concentration} maxLength={60} onChange={e=>setField('concentration',e.target.value)}
                  placeholder="Ex.: 50 mg/comprimido" aria-invalid={!!errors['medication.concentration']}/>
                {err('medication.concentration')}
              </label>
              <label>Dose — valor <span className="required"> *</span>
                <input type="number" step="any" min="0" value={form.doseValue} onChange={e=>setField('doseValue',e.target.value)}
                  placeholder="Ex.: 50" aria-invalid={!!errors['dose.value']}/>
                {err('dose.value')}
              </label>
              <label>Dose — unidade <span className="required"> *</span>
                <input value={form.doseUnit} maxLength={30} onChange={e=>setField('doseUnit',e.target.value)}
                  placeholder="Ex.: mg" aria-invalid={!!errors['dose.unit']}/>
                {err('dose.unit')}
              </label>
              <label>Via de administração <span className="required"> *</span>
                <input list="rx-routes" value={form.route} maxLength={60} onChange={e=>setField('route',e.target.value)}
                  placeholder="Ex.: Oral" aria-invalid={!!errors.route}/>
                {err('route')}
                <datalist id="rx-routes">{ROUTES.map(r=><option key={r} value={r}/>)}</datalist>
              </label>
              <label>Frequência <span className="required"> *</span>
                <input value={form.frequency} maxLength={80} onChange={e=>setField('frequency',e.target.value)}
                  placeholder="Ex.: 8/8h" aria-invalid={!!errors.frequency}/>
                {err('frequency')}
              </label>
              <label>Duração <span className="required"> *</span>
                <input value={form.duration} maxLength={80} onChange={e=>setField('duration',e.target.value)}
                  placeholder="Ex.: 7 dias" aria-invalid={!!errors.duration}/>
                {err('duration')}
              </label>
              <label>Quantidade <span className="required"> *</span>
                <input type="number" step="1" min="1" max="9999" value={form.quantity} onChange={e=>setField('quantity',e.target.value)}
                  placeholder="Ex.: 30" aria-invalid={!!errors.quantity}/>
                {err('quantity')}
              </label>
              <div className="rx-span stack gap-3">
                <span>Horários de administração (HH:MM) — {form.times.length}/6 <span className="required"> *</span></span>
                <div className="rx-times">
                  {form.times.map((t,i)=><div className="rx-time-slot" key={i}>
                    <input type="time" step={60} aria-label={'Horário '+(i+1)+' (HH:MM)'} value={t}
                      aria-invalid={!!errors['times.'+i]} onChange={e=>setForm(f=>({...f,times:f.times.map((x,j)=>j===i?normTime(e.target.value):x)}))}/>
                    <button type="button" className="text-button" aria-label={'Remover horário '+(i+1)}
                      disabled={form.times.length<=1} onClick={()=>setForm(f=>({...f,times:f.times.filter((_,j)=>j!==i)}))}><X size={14}/></button>
                  </div>)}
                  {form.times.length<6&&<button type="button" className="secondary-button" onClick={()=>setForm(f=>({...f,times:[...f.times,'08:00']}))}><Plus size={15}/> Adicionar horário</button>}
                </div>
                {Object.keys(errors).filter(k=>k.startsWith('times')).sort().map(k=><div key={k}>{err(k)}</div>)}
              </div>
              <label>Indicação <span className="required"> *</span>
                <textarea rows={2} value={form.indication} maxLength={500} onChange={e=>setField('indication',e.target.value)}
                  placeholder="Ex.: Hipertensão arterial essencial" aria-invalid={!!errors.indication}/>
                {err('indication')}
              </label>
              <label>Orientações ao paciente <span className="required"> *</span>
                <textarea rows={3} value={form.instructions} maxLength={2000} onChange={e=>setField('instructions',e.target.value)}
                  placeholder="Ex.: Tomar com alimentos; não interromper sem orientação médica." aria-invalid={!!errors.instructions}/>
                {err('instructions')}
              </label>
            </div>
            {err('_')}
            <div className="action-row">
              {editingId&&<button type="button" className="secondary-button" onClick={resetForm}><X size={15}/> Descartar edição</button>}
              <button type="submit" className="primary-button" disabled={saving}><CloudUpload size={16}/> {saving?'Salvando…':editingId?'Salvar alterações':'Salvar rascunho'}</button>
            </div>
            <p className="muted footnote">A segurança medicamentosa (alergias e duplicidade) é calculada pelo servidor a cada salvamento e novamente na assinatura. Campos marcados com * são obrigatórios no backend.</p>
          </form>
        </div>}
      </div>
    </>}
  </section>;
}
