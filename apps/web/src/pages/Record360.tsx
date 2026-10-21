import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Ban, FileText, FlaskConical, HeartPulse, History, Info, Pill, RefreshCw, Stethoscope } from 'lucide-react';
import {
  api, ApiError,
  type DocumentRow, type DocumentVersions, type MedicationsBundle, type Patient, type Session, type TimelineItem
} from '../api';

/**
 * PRONTUÁRIO 360° (P1/ST-P1-XXX parte web) — visão consolidada do paciente sobre
 * três leituras somente-consulta do backend (contrato fechado):
 *   GET /patients/:patientId/timeline?types=encounter,note,prescription,allergy,problem,exam,document&limit=50
 *   GET /patients/:patientId/medications
 *   GET /patients/:patientId/documents  +  /documents/:documentId/versions
 * HONESTIDADE CLÍNICA (regra desta tela):
 *   - allergyState 'none_recorded' NUNCA vira "sem alergias": exibimos aviso explícito
 *     de que ausência de registro ≠ ausência de alergia.
 *   - assinaturas: 'attested'→"Atestada", 'pades'→"PAdES" (evidência registrada);
 *     nunca afirmamos "assinatura válida" — a validação oficial ICP-Brasil/ITI
 *     permanece no verificador oficial (dito na aba Documentos quando há só v1).
 *   - 403 break-glass: sem reimplementar o painel aqui; a mensagem orienta a usar o
 *     painel de break-glass do prontuário (view 'record') e tentar de novo.
 * 401: o helper api() dispara EVENT_SESSION_EXPIRED e o App volta ao login — não duplicamos.
 * Sem merge/MPI nesta rodada (backend expõe depois; fica fora da UI).
 */

type Alert=(text:string,kind?:'success'|'error'|'info')=>void;
type R360Tab='timeline'|'risk'|'documents';

const NETWORK='Não foi possível conectar ao StarMed. Tente novamente.';
const BREAK_GLASS='Acesso a este prontuário exige autorização break-glass. Abra o prontuário do paciente, informe o motivo no painel de break-glass e tente novamente.';

/** Erro de carga amigável: 403/break-glass vira orientação acionável; corpo JSON bruto
 *  (fallback do api()) nunca vira mensagem técnica na tela. */
function errText(e:unknown):string{
  if(e instanceof ApiError){
    if(e.status===403||/break-glass/i.test(e.message))return BREAK_GLASS;
    if(e.status===404)return 'Paciente ou registro não encontrado.';
    const m=(e.message||'').trim();
    if(m&&!m.startsWith('{')&&!m.startsWith('['))return m;
    return 'Não foi possível carregar os dados do prontuário. Tente novamente.';
  }
  return NETWORK;
}

const fmt=(iso:string)=>{
  const d=new Date(iso);
  if(Number.isNaN(d.getTime()))return iso;
  return d.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
};
const shortSha=(s:string)=>s.length>16?s.slice(0,16)+'…':s;

const KIND_LABEL:Record<string,string>={
  encounter:'Encontro',note:'Nota',prescription:'Prescrição',allergy:'Alergia',
  problem:'Problema',exam:'Exame',document:'Documento'
};
function kindIcon(kind:string):ReactNode{
  switch(kind){
    case 'encounter':return <Stethoscope size={18}/>;
    case 'prescription':return <Pill size={18}/>;
    case 'allergy':return <AlertTriangle size={18}/>;
    case 'problem':return <HeartPulse size={18}/>;
    case 'exam':return <FlaskConical size={18}/>;
    case 'document':return <FileText size={18}/>;
    default:return <FileText size={18}/>;
  }
}

/** Vocabulário de status honesto; o que não mapeamos aparece como veio do servidor. */
const STATUS_LABEL:Record<string,string>={
  draft:'Rascunho',signed:'Assinada',cancelled:'Cancelada',
  active:'Ativa',inactive:'Inativa',recorded:'Registrada',
  resolved:'Resolvida',relapse:'Recorrente',remission:'Em remissão',
  confirmed:'Confirmada',provisional:'Provisória',differential:'Diferencial',
  open:'Em aberto',scheduled:'Agendada',closed:'Encerrada',completed:'Concluído',
  pending:'Pendente',preliminary:'Preliminar',final:'Final',
  critical:'Crítico',urgent:'Urgente',normal:'Normal',
  high:'Alta',low:'Baixa',unableToAssess:'Não avaliada','unable-to-assess':'Não avaliada',
  // Estados de encontro (schema) e de agenda/pedido (migrações 002..017).
  planned:'Planejado','in-progress':'Em andamento',finished:'Concluído',
  checked_in:'Check-in',no_show:'Não compareceu',
  ordered:'Solicitado',in_progress:'Em execução'
};
const statusLabel=(s:string)=>STATUS_LABEL[s]??s;

/** assinatura tri-estado da prescrição: '' quando não há metadata de assinatura. */
const signatureLabel=(s?:string)=>s==='attested'?'Atestada':s==='pades'?'PAdES':s==='none'?'Sem assinatura':'';

const CHANGE_KIND_LABEL:Record<string,string>={
  created:'Criação do documento',content_updated:'Conteúdo atualizado',renamed:'Renomeado'
};
const changeKindLabel=(k:string)=>CHANGE_KIND_LABEL[k]??k;

const DOC_TYPE_LABEL:Record<string,string>={
  prescription:'Prescrição (PDF)',prescription_pdf:'Prescrição (PDF)',clinical_note:'Nota clínica',exam_report:'Resultado de exame',attachment:'Anexo'
};
const docTypeLabel=(t:string)=>DOC_TYPE_LABEL[t]??t;

const ALERT_LEVEL_LABEL:Record<string,string>={
  block:'BLOQUEIO',review_required:'REVISÃO OBRIGATÓRIA',info:'INFORMATIVO'
};

function InlineError({text}:{text:string}){
  return <div className="inline-error" role="alert"><AlertCircle size={16}/>{text}</div>;
}

const TABS:{key:R360Tab;label:string}[]=[
  {key:'timeline',label:'Linha do tempo'},
  {key:'risk',label:'Alto risco'},
  {key:'documents',label:'Documentos'}
];

export function Record360Page({session,alert,patient,onView}:{
  session:Session;alert:Alert;patient:Patient|null;onView:(v:'record'|'patients')=>void;
}){
  const token=session.accessToken;
  const [tab,setTab]=useState<R360Tab>('timeline');

  const [items,setItems]=useState<TimelineItem[]>([]);
  const [tlLoading,setTlLoading]=useState(false);
  const [tlError,setTlError]=useState('');

  const [bundle,setBundle]=useState<MedicationsBundle|null>(null);
  const [riskLoading,setRiskLoading]=useState(false);
  const [riskError,setRiskError]=useState('');

  const [docs,setDocs]=useState<DocumentRow[]>([]);
  const [docsLoading,setDocsLoading]=useState(false);
  const [docsError,setDocsError]=useState('');
  const [versionsFor,setVersionsFor]=useState<string|null>(null);
  const [versions,setVersions]=useState<DocumentVersions|null>(null);
  const [versionsLoading,setVersionsLoading]=useState(false);
  const [versionsError,setVersionsError]=useState('');

  async function loadTimeline(){
    if(!patient)return;
    setTlLoading(true);setTlError('');
    try{
      const q='/patients/'+patient.id+'/timeline?types=encounter,note,prescription,allergy,problem,exam,document&limit=50';
      const rows=await api<TimelineItem[]>(q,token);
      // Mais recente primeiro — a ordenação é da UI, não do backend.
      setItems([...rows].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()));
    }catch(e){setTlError(errText(e));}
    finally{setTlLoading(false);}
  }
  async function loadRisk(){
    if(!patient)return;
    setRiskLoading(true);setRiskError('');
    try{setBundle(await api<MedicationsBundle>('/patients/'+patient.id+'/medications',token));}
    catch(e){setRiskError(errText(e));}
    finally{setRiskLoading(false);}
  }
  async function loadDocs(){
    if(!patient)return;
    setDocsLoading(true);setDocsError('');
    try{setDocs(await api<DocumentRow[]>('/patients/'+patient.id+'/documents',token));}
    catch(e){setDocsError(errText(e));}
    finally{setDocsLoading(false);}
  }

  // Troca de paciente limpa tudo (inclusive histórico de versões aberto).
  useEffect(()=>{
    setItems([]);setBundle(null);setDocs([]);
    setVersionsFor(null);setVersions(null);setVersionsError('');
    if(!patient)return;
    void loadTimeline();void loadRisk();void loadDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[patient?.id,token]);

  async function loadVersions(row:DocumentRow){
    if(!patient)return;
    if(versionsFor===row.id){setVersionsFor(null);setVersions(null);setVersionsError('');return;}
    setVersionsFor(row.id);setVersions(null);setVersionsError('');setVersionsLoading(true);
    try{
      setVersions(await api<DocumentVersions>('/patients/'+patient.id+'/documents/'+row.id+'/versions',token));
    }catch(e){
      const msg=errText(e);
      setVersionsError(msg);alert(msg,'error');
    }
    finally{setVersionsLoading(false);}
  }

  if(!patient){
    return <div className="panel empty-state">
      <Pill size={35}/>
      <h2>Selecione um paciente</h2>
      <p>A visão 360° consolida linha do tempo, alto risco (alergias e medicações) e documentos do paciente selecionado.</p>
      <div className="action-row">
        <button type="button" className="secondary-button" onClick={()=>onView('patients')}>Buscar paciente</button>
      </div>
    </div>;
  }

  const timeline=<div className="panel" aria-busy={tlLoading}>
    <div className="panel-title"><h2>Linha do tempo do prontuário</h2>
      <button type="button" className="text-button" onClick={()=>void loadTimeline()}><RefreshCw size={14}/> Atualizar</button></div>
    <p className="muted footnote">{items.length} evento(s) • encontros, notas, prescrições, alergias, problemas, exames e documentos.</p>
    {tlError&&<InlineError text={tlError}/>}
    {tlLoading&&items.length===0&&<p className="muted" role="status">Carregando…</p>}
    {!tlLoading&&!tlError&&items.length===0&&<div className="empty-state"><FileText size={28}/><p>Nenhum evento registrado para este paciente.</p></div>}
    {items.map(it=>{
      const sig=it.kind==='prescription'?signatureLabel(it.meta?.signatureStatus):'';
      const critical=it.kind==='exam'&&it.meta?.critical===true;
      const docSha=it.kind==='document'&&it.meta?.sha256?shortSha(it.meta.sha256):'';
      return <div className="list-line" key={it.kind+':'+it.id}>
        <div className="list-icon">{kindIcon(it.kind)}</div>
        <div><strong>{it.title}</strong>
          <small>{KIND_LABEL[it.kind]??it.kind} • {fmt(it.at)}{it.author?` • ${it.author}`:''}</small>
          {it.summary&&<small className="r360-summary">{it.summary}</small>}</div>
        {critical
          ?<span className="r360-badge-critical">EXAME CRÍTICO</span>
          :<span className="small-pill">{statusLabel(it.status)}</span>}
        {sig&&<span className={'small-pill '+(it.meta?.signatureStatus==='pades'?'pill-signed':'')}>{sig}</span>}
        {docSha&&<span className="small-pill">SHA-256 {docSha}</span>}
      </div>;
    })}
  </div>;

  const risk=<div className="panel" aria-busy={riskLoading}>
    <div className="panel-title"><h2>Alto risco — alergias, medicações e alertas</h2>
      <button type="button" className="text-button" onClick={()=>void loadRisk()}><RefreshCw size={14}/> Atualizar</button></div>
    {riskError&&<InlineError text={riskError}/>}
    {riskLoading&&!bundle&&<p className="muted" role="status">Carregando…</p>}
    {bundle&&<>
      <h3 className="r360-subtitle">Alergias</h3>
      {bundle.allergyState==='none_recorded'&&<div className="r360-notice-warn" role="status">
        <AlertTriangle size={16}/>
        <span><strong>Nenhuma alergia registrada — isto NÃO significa ausência de alergia; confirme a anamnese.</strong></span>
      </div>}
      {bundle.allergies.length===0&&bundle.allergyState==='recorded'&&<p className="muted">Registro de alergias consultado e sem entradas. Confirme a anamnese antes de assumir ausência de alergia.</p>}
      {bundle.allergies.map(a=><div className="list-line" key={a.substance+':'+a.clinicalStatus+':'+a.verificationStatus}>
        <div className="list-icon"><AlertTriangle size={18}/></div>
        <div><strong>{a.substance}</strong>
          <small>status clínico: {statusLabel(a.clinicalStatus)} • verificação: {statusLabel(a.verificationStatus)}</small></div>
        {a.criticality==='high'
          ?<span className="r360-badge-critical">CRÍTICO</span>
          :<span className="small-pill">Criticalidade: {statusLabel(a.criticality)}</span>}
      </div>)}

      <h3 className="r360-subtitle">Medicações ativas</h3>
      {bundle.activeMedications.length===0
        ?<p className="muted">Nenhuma medicação ativa registrada.</p>
        :bundle.activeMedications.map(m=><div className="list-line" key={m.id}>
          <div className="list-icon"><Pill size={18}/></div>
          <div><strong>{m.medicationName}</strong>
            <small>{m.dose||'—'} • {m.route||'—'} • {m.frequency||'—'}{m.prescribedAt?` • prescrita em ${fmt(m.prescribedAt)}`:''}</small></div>
          <span className={'small-pill '+(m.signatureStatus==='pades'?'pill-signed':'')}>
            {signatureLabel(m.signatureStatus)||statusLabel(m.status)}</span>
        </div>)}

      {bundle.alerts.length>0&&<>
        <h3 className="r360-subtitle">Alertas de segurança medicamentosa</h3>
        {bundle.alerts.map(al=><div className={'r360-alert r360-alert-'+al.level} key={al.code+':'+al.message} role={al.level==='block'?'alert':undefined}>
          {al.level==='block'?<Ban size={16}/>:al.level==='review_required'?<AlertTriangle size={16}/>:<Info size={16}/>}
          <div><strong>{ALERT_LEVEL_LABEL[al.level]??al.level}</strong><p>{al.message}</p></div>
        </div>)}
      </>}
    </>}
  </div>;

  const documents=<div className="panel" aria-busy={docsLoading}>
    <div className="panel-title"><h2>Documentos do paciente</h2>
      <button type="button" className="text-button" onClick={()=>void loadDocs()}><RefreshCw size={14}/> Atualizar</button></div>
    {docsError&&<InlineError text={docsError}/>}
    {docsLoading&&docs.length===0&&<p className="muted" role="status">Carregando…</p>}
    {!docsLoading&&!docsError&&docs.length===0&&<div className="empty-state"><FileText size={28}/><p>Nenhum documento registrado para este paciente.</p></div>}
    {docs.map(d=><div key={d.id}>
      <div className="list-line">
        <div className="list-icon"><FileText size={18}/></div>
        <div><strong>{docTypeLabel(d.doc_type)}</strong>
          <small>{fmt(d.created_at)} • SHA-256 {shortSha(d.sha256)} • {d.versions} versão(ões)</small></div>
        <button type="button" className="secondary-button" disabled={versionsFor===d.id&&versionsLoading}
          onClick={()=>void loadVersions(d)}>
          <History size={14}/> {versionsFor===d.id?(versionsLoading?'Carregando…':'Fechar histórico'):'Ver histórico'}</button>
      </div>
      {versionsFor===d.id&&<div className="r360-versions">
        {versionsError&&<InlineError text={versionsError}/>}
        {versionsLoading&&<p className="muted" role="status">Carregando…</p>}
        {versions&&<>
          {[...versions.versions].sort((a,b)=>b.version-a.version).map(v=><div className="list-line" key={v.version}>
            <div><strong>v{v.version} — {changeKindLabel(v.change_kind)}</strong>
              <small>{fmt(v.created_at)} • SHA-256 {shortSha(v.sha256)}</small></div>
          </div>)}
          {versions.versions.length<=1&&<p className="muted footnote">Este documento tem apenas a versão de criação. A validação oficial permanece no verificador do ITI — esta tela não substitui a verificação do documento assinado.</p>}
          {versions.note&&<p className="muted footnote">{versions.note}</p>}
        </>}
      </div>}
    </div>)}
  </div>;

  return <>
    <div className="patient-header">
      <div className="patient-avatar large">{patient.fullName.slice(0,1).toUpperCase()}</div>
      <div><span className="eyebrow">PRONTUÁRIO 360°</span><h2>{patient.fullName}</h2>
        <p>Nascimento: {String(patient.birthDate).slice(0,10)}</p></div>
      <span className="small-pill">ID {patient.id.slice(0,8)}</span>
      <button type="button" className="secondary-button" onClick={()=>onView('record')}>Prontuário</button>
    </div>

    <div className="r360-tabs" role="tablist" aria-label="Seções do prontuário 360°">
      {TABS.map(t=><button key={t.key} type="button" role="tab" aria-selected={tab===t.key}
        className={'r360-tab'+(tab===t.key?' r360-tab-active':'')}
        onClick={()=>setTab(t.key)}>{t.label}</button>)}
    </div>

    <div role="tabpanel" aria-label={TABS.find(t=>t.key===tab)?.label}>
      {tab==='timeline'&&timeline}
      {tab==='risk'&&risk}
      {tab==='documents'&&documents}
    </div>
  </>;
}
