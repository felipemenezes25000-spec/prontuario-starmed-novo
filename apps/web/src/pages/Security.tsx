import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, Copy, KeyRound, PowerOff, RefreshCw, ShieldCheck, Smartphone, X } from 'lucide-react';
import { api, ApiError, type MfaEnrollment, type MfaStatus, type Session } from '../api';

/**
 * Segurança da conta: enrollment MFA (inscrição → confirmação → códigos de
 * recuperação exibidos UMA vez), regeneração e desativação — exatamente os
 * contratos de apps/api/src/auth-mfa.ts:
 *   GET  /auth/mfa/status         → {enabled, enrolledAt, methods}
 *   POST /auth/mfa/enroll    {}   → {secretBase32, otpauthUri, algorithm, digits, periodSeconds}
 *   POST /auth/mfa/activate   {code}                 → {enabled, recoveryCodes}
 *   POST /auth/mfa/recovery-codes {password, code}   → {recoveryCodes}
 *   POST /auth/mfa/disable    {password, code}       → {enabled, sessionsRevoked}
 * Nenhum desses retorna sessão nova; a desativação revoga as sessões existentes
 * (auth_version bump), por isso o componente avisa o App via onMfaDisabled.
 */

type Alert=(text:string,kind?:'success'|'error'|'info')=>void;

const NETWORK='Não foi possível conectar ao StarMed. Tente novamente.';
const errText=(e:unknown)=>e instanceof ApiError?e.message:NETWORK;

/** Copia texto para a área de transferência sem enviar nada a serviços externos. */
async function copyText(text:string,alert:Alert){
  try{
    await navigator.clipboard.writeText(text);
    alert('Copiado para a área de transferência.','info');
  }catch{alert('Não foi possível copiar automaticamente. Selecione o texto e copie manualmente.','error');}
}

function InlineError({text}:{text:string}){
  return <div className="inline-error" role="alert"><AlertCircle size={16}/>{text}</div>;
}

export function SecurityPage({session,alert,onMfaDisabled}:{session:Session;alert:Alert;onMfaDisabled:()=>void}){
  const token=session.accessToken;
  const [status,setStatus]=useState<MfaStatus|null>(null);
  const [loadError,setLoadError]=useState('');
  const [enrollment,setEnrollment]=useState<MfaEnrollment|null>(null);
  const [activateCode,setActivateCode]=useState('');
  const [recoveryCodes,setRecoveryCodes]=useState<string[]|null>(null);
  const [confirmKind,setConfirmKind]=useState<'regen'|'disable'|null>(null);
  const [confirmForm,setConfirmForm]=useState({password:'',code:''});
  const [busy,setBusy]=useState(false);
  const [formError,setFormError]=useState('');
  const activateRef=useRef<HTMLInputElement>(null);

  async function load(){
    try{setStatus(await api<MfaStatus>('/auth/mfa/status',token));setLoadError('');}
    catch(e){setLoadError(errText(e));}
  }
  useEffect(()=>{void load();},[]);

  async function startEnrollment(e?:FormEvent){
    e?.preventDefault();setBusy(true);setFormError('');
    try{
      const r=await api<MfaEnrollment>('/auth/mfa/enroll',token,'POST',{});
      setEnrollment(r);setActivateCode('');
      window.setTimeout(()=>activateRef.current?.focus(),0);
    }catch(e){
      // 409 = "MFA já ativado; desative antes de reinscrever"
      setFormError(errText(e));
      if(e instanceof ApiError&&e.status===409)await load();
    }finally{setBusy(false);}
  }

  async function activate(e:FormEvent){
    e.preventDefault();if(!enrollment)return;
    if(!/^\d{6}$/.test(activateCode)){setFormError('Digite os 6 dígitos exibidos no aplicativo autenticador.');return;}
    setBusy(true);setFormError('');
    try{
      const r=await api<{enabled:boolean;recoveryCodes:string[]}>('/auth/mfa/activate',token,'POST',{code:activateCode});
      setRecoveryCodes(r.recoveryCodes);      // exibição ÚNICA: fica só em memória
      setEnrollment(null);setActivateCode('');
      await load();
      alert('Verificação em duas etapas ativada.','success');
    }catch(e){
      // 401 = "Código inválido"
      setFormError(e instanceof ApiError&&e.status===401?'Código incorreto. Confira o aplicativo autenticador e tente novamente.':errText(e));
    }finally{setBusy(false);}
  }

  async function submitConfirmation(e:FormEvent){
    e.preventDefault();if(!confirmKind)return;
    setBusy(true);setFormError('');
    const body={password:confirmForm.password,code:confirmForm.code};
    try{
      if(confirmKind==='regen'){
        const r=await api<{recoveryCodes:string[]}>('/auth/mfa/recovery-codes',token,'POST',body);
        setRecoveryCodes(r.recoveryCodes);    // substitui o conjunto anterior (todos invalidados)
        setConfirmKind(null);setConfirmForm({password:'',code:''});
        alert('Novos códigos gerados. Os códigos anteriores deixaram de funcionar.','success');
      }else{
        const r=await api<{enabled:boolean;sessionsRevoked:boolean}>('/auth/mfa/disable',token,'POST',body);
        setConfirmKind(null);setConfirmForm({password:'',code:''});
        if(r.sessionsRevoked)onMfaDisabled(); // sessões revogadas no servidor → voltar ao login
        else await load();
      }
    }catch(e){setFormError(errText(e));}finally{setBusy(false);}
  }

  const copyRecovery=()=>{if(recoveryCodes)void copyText(recoveryCodes.join('\n'),alert);};
  const enrolledAt=status?.enrolledAt?new Date(status.enrolledAt).toLocaleString('pt-BR',{dateStyle:'long',timeStyle:'short'}):null;
  const methodLabel=(m:string)=>m==='totp'?'Aplicativo autenticador (TOTP)':m==='recovery'?'Códigos de recuperação':m;

  return <section>
    <div className="page-heading"><div><span className="eyebrow">SEGURANÇA DA CONTA</span><h1>Verificação em duas etapas</h1>
      <p>Proteja o acesso ao StarMed com um segundo fator além da senha.</p></div></div>

    {loadError&&<div className="panel"><InlineError text={loadError}/></div>}

    {!status&&!loadError&&<div className="panel"><p className="muted">Carregando configuração de segurança…</p></div>}

    {recoveryCodes&&<div className="recovery-once" role="status">
      <div className="recovery-once-head"><AlertCircle size={18}/><strong>Códigos de recuperação — anote agora</strong></div>
      <p className="muted">Estes códigos aparecem <strong>somente uma vez</strong>. Guarde-os em local seguro: cada um serve para um acesso e não pode ser reutilizado.</p>
      <ul className="recovery-grid">{recoveryCodes.map(c=><li className="recovery-code" key={c}>{c}</li>)}</ul>
      <div className="action-row">
        <button type="button" className="secondary-button" onClick={copyRecovery}><Copy size={15}/> Copiar códigos</button>
        <button type="button" className="primary-button" onClick={()=>setRecoveryCodes(null)}><CheckCircle2 size={16}/> Já salvei os códigos</button>
      </div>
    </div>}

    {status&&<div className="content-grid">
      <div className="panel"><div className="panel-title"><h2>Situação da conta</h2><ShieldCheck size={19}/></div>
        <div className="list-line" style={{borderTop:0}}>
          <div className="list-icon">{status.enabled?<ShieldCheck size={18}/>:<Smartphone size={18}/>}</div>
          <div><strong>{status.enabled?'Verificação em duas etapas ativa':'Verificação em duas etapas desativada'}</strong>
            <small>{status.enabled?(enrolledAt?'Ativada em '+enrolledAt:'Ativada'):'A senha ainda é o único fator do seu acesso.'}</small></div>
          <span className={'small-pill '+(status.enabled?'pill-signed':'')}>{status.enabled?'Ativa':'Inativa'}</span>
        </div>
        {status.enabled&&<div className="mfa-facts">{status.methods.map(m=><span className="small-pill" key={m}>{methodLabel(m)}</span>)}</div>}
        {status.enabled?<p className="muted footnote">Os códigos de recuperação já emitidos não podem ser exibidos de novo por segurança; se os perdeu, gere um novo conjunto (os anteriores deixam de funcionar).</p>:
          !enrollment&&<p className="muted footnote">Ative para exigir um código do aplicativo autenticador — ou um código de recuperação — a cada novo login.</p>}
      </div>

      {!status.enabled&&!enrollment&&<div className="panel"><div className="panel-title"><h2>Ativar verificação em duas etapas</h2><Smartphone size={19}/></div>
        <p className="muted">Você receberá uma chave para cadastrar no aplicativo autenticador de sua escolha e confirmará com um código para concluir.</p>
        {formError&&<InlineError text={formError}/>}
        <div className="action-row">
          <button type="button" className="primary-button" disabled={busy} onClick={()=>void startEnrollment()}><Smartphone size={16}/> {busy?'Iniciando…':'Iniciar ativação'}</button>
        </div>
      </div>}

      {enrollment&&<div className="panel"><div className="panel-title"><h2>Cadastrar no aplicativo autenticador</h2><KeyRound size={19}/></div>
        <ol className="mfa-steps">
          <li>Abra seu aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Aegis ou equivalente) e escolha <strong>adicionar conta manualmente</strong>.</li>
          <li>Copie a chave secreta abaixo e cole no aplicativo. O link otpauth também pode ser aberto em um dispositivo com o app instalado.</li>
          <li>Informe o código de 6 dígitos gerado para confirmar a ativação.</li>
        </ol>
        <div className="stack gap-3">
          <label>Chave secreta (digite ou copie no aplicativo)
            <div className="secret-field"><input readOnly value={enrollment.secretBase32} aria-label="Chave secreta TOTP" onFocus={e=>e.currentTarget.select()}/>
              <button type="button" className="text-button" onClick={()=>void copyText(enrollment.secretBase32,alert)}><Copy size={14}/> Copiar</button></div>
          </label>
          <label>Link da conta (otpauth)
            <div className="secret-field"><input readOnly value={enrollment.otpauthUri} aria-label="Link otpauth da conta" onFocus={e=>e.currentTarget.select()}/>
              <button type="button" className="text-button" onClick={()=>void copyText(enrollment.otpauthUri,alert)}><Copy size={14}/> Copiar</button></div>
          </label>
          <p className="muted footnote">Algoritmo {enrollment.algorithm} • {enrollment.digits} dígitos • {enrollment.periodSeconds}s por código. A chave é exibida apenas em texto, sem passar por serviços externos de QR.</p>
        </div>
        <form className="stack gap-3" onSubmit={activate}>
          <label>Código de 6 dígitos do aplicativo
            <input ref={activateRef} required inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}"
              className="code-input" value={activateCode} onChange={e=>setActivateCode(e.target.value.replace(/\D/g,''))} placeholder="000000"/></label>
          {formError&&<InlineError text={formError}/>}
          <div className="action-row">
            <button type="button" className="secondary-button" onClick={()=>{setEnrollment(null);setFormError('');setActivateCode('');}}><X size={15}/> Cancelar</button>
            <button type="submit" className="primary-button" disabled={busy||activateCode.length!==6}><ShieldCheck size={16}/> {busy?'Confirmando…':'Confirmar e ativar'}</button>
          </div>
        </form>
      </div>}

      {status.enabled&&<div className="panel"><div className="panel-title"><h2>Manutenção</h2><KeyRound size={19}/></div>
        {confirmKind===null?<>
          <div className="list-line" style={{borderTop:0}}>
            <div className="list-icon"><RefreshCw size={18}/></div>
            <div><strong>Gerar novos códigos de recuperação</strong><small>Exige sua senha e um código do aplicativo</small></div>
            <button type="button" className="secondary-button" onClick={()=>{setConfirmKind('regen');setFormError('');}}><RefreshCw size={15}/> Gerar</button>
          </div>
          <div className="list-line">
            <div className="list-icon"><PowerOff size={18}/></div>
            <div><strong>Desativar verificação em duas etapas</strong><small>Exige senha e código; encerra todas as sessões</small></div>
            <button type="button" className="secondary-button" onClick={()=>{setConfirmKind('disable');setFormError('');}}><PowerOff size={15}/> Desativar</button>
          </div>
          <p className="muted footnote">A desativação encerra as sessões abertas neste e em outros dispositivos; você precisará entrar novamente.</p>
        </>:<form className="stack gap-3" onSubmit={submitConfirmation}>
          <span className="eyebrow">{confirmKind==='regen'?'CONFIRME PARA GERAR NOVOS CÓDIGOS':'CONFIRME PARA DESATIVAR O MFA'}</span>
          <label>Senha atual<input required type="password" autoComplete="current-password" value={confirmForm.password}
            onChange={e=>setConfirmForm({...confirmForm,password:e.target.value})} placeholder="Sua senha"/></label>
          <label>Código de 6 dígitos do aplicativo
            <input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" className="code-input"
              value={confirmForm.code} onChange={e=>setConfirmForm({...confirmForm,code:e.target.value.replace(/\D/g,'')})} placeholder="000000"/></label>
          {formError&&<InlineError text={formError}/>}
          <div className="action-row">
            <button type="button" className="secondary-button" onClick={()=>{setConfirmKind(null);setFormError('');setConfirmForm({password:'',code:''});}}><X size={15}/> Cancelar</button>
            <button type="submit" className="primary-button" disabled={busy||!confirmForm.password||confirmForm.code.length!==6}>
              {busy?'Confirmando…':confirmKind==='regen'?'Gerar novos códigos':'Desativar MFA'}</button>
          </div>
        </form>}
      </div>}
    </div>}
  </section>;
}
