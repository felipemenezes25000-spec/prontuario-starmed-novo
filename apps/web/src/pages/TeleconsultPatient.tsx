import { useRef, useState, type FormEvent } from 'react';
import { Video } from 'lucide-react';
import { api, ApiError } from '../api';
import { useTeleconsultCall, type Alert, type SignalSender } from './TeleconsultRoom';

/**
 * Teleconsulta — lado do PACIENTE (Fase 4): acesso público pelo link
 * `#teleconsult=<roomId>` + código de convite SINGLE-USE. O token de sala
 * (4h, devolvido no join) vive SÓ em memória (useRef) — nunca em
 * localStorage/sessionStorage; fechar a aba encerra a sessão da sala.
 * Sem autenticação de usuário: quem tem o convite não utilizado entra.
 */
export function TeleconsultPatient({ roomId, alert }: { roomId: string; alert: Alert }) {
  const [inviteCode, setInviteCode] = useState('');
  const tokenRef = useRef(''); // síncrono: o hook inicia a chamada logo após o join
  const [roomStatus, setRoomStatus] = useState('waiting');
  const [inCall, setInCall] = useState(false);
  const [busy, setBusy] = useState(false);
  // Aviso PRÓPRIO: esta tela é pública (early-return do App) e o banner do shell
  // não está montado — o feedback precisa viver aqui (o alert() externo é só
  // um eco para quem eventualmente montar esta página dentro do shell).
  const [msg, setMsg] = useState<{ text: string; kind: 'success' | 'error' | 'info' } | null>(null);
  const say = (text: string, kind: 'success' | 'error' | 'info' = 'info') => { setMsg({ text, kind }); alert(text, kind); };

  const sender: SignalSender = {
    post: async (kind, payload) => {
      await api(`/teleconsult/rooms/${roomId}/signals/patient`, tokenRef.current, 'POST',
        { kind, senderKind: 'patient', payload }, { 'x-teleconsult-token': tokenRef.current });
    },
    poll: (after) => api<Array<{ seq: number; sender_kind: string; kind: 'offer' | 'answer' | 'ice' | 'bye'; payload: Record<string, unknown> }>>(
      `/teleconsult/rooms/${roomId}/signals/patient?after=${after}`, tokenRef.current, 'GET', undefined, { 'x-teleconsult-token': tokenRef.current })
  };
  const call = useTeleconsultCall({
    roomId, roomStatus, senderKind: 'patient', sender,
    onRoomClosed: () => { setRoomStatus('closed'); setInCall(false); void call.hangUp(false); }
  });

  async function join(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api<{ id: string; status: string; patientToken: string }>(
        `/teleconsult/rooms/${roomId}/join-patient`, null, 'POST', { inviteCode });
      tokenRef.current = r.patientToken;
      setRoomStatus(r.status);
      const ok = await call.start();
      if (ok) { setInCall(true); say('Você entrou na teleconsulta.', 'success'); }
    } catch (err) {
      // Bloqueios honestos do servidor (convite inválido/expirado, sala
      // encerrada, consentimento não registrado) chegam como mensagem amigável.
      say(err instanceof ApiError ? err.message : 'Não foi possível entrar na teleconsulta.', 'error');
    } finally { setBusy(false); }
  }

  return <section>
    <div className="page-heading"><div><span className="eyebrow">TELEMEDICINA</span><h1>Teleconsulta do paciente</h1>
      <p>Entre com o código de convite recebido (uso único, válido por 6 horas). Nada é instalado; a mídia fica no seu navegador.</p></div></div>

    <div className="panel">
      <div className="panel-title"><h2>Entrar na sala</h2><Video size={19}/></div>
      {msg && <div className={'notice ' + msg.kind} role={msg.kind === 'error' ? 'alert' : 'status'}>
        <span>{msg.text}</span>
      </div>}
      {!inCall ? <form className="stack gap-3" onSubmit={join}>
        <label>Código de convite
          <input required value={inviteCode} onChange={e => setInviteCode(e.target.value.toUpperCase())}
            maxLength={64} spellCheck={false} autoComplete="off" placeholder="20 caracteres recebidos por canal seguro" />
        </label>
        <button className="primary-button" disabled={busy || !inviteCode} type="submit"><Video size={16}/> Entrar na teleconsulta</button>
        <p className="muted footnote">Sala: {roomId.slice(0, 8)}… • Gravação: desligada (padrão deste ambiente — armazenamento de mídia é pendência LGPD/DPO).</p>
      </form> : <>
        <div data-testid="tc-patient-call-state">
          <span className="small-pill" style={{ marginRight: 8 }}>Conexão: {call.badge}</span>
          <button type="button" className="secondary-button" onClick={call.toggleMic}>{call.micOn ? 'Desativar microfone' : 'Ativar microfone'}</button>{' '}
          <button type="button" className="primary-button" onClick={() => { setInCall(false); void call.hangUp(true); }}>Sair e encerrar</button>
        </div>
        <p className="muted footnote">Gravação: desligada (padrão deste ambiente — armazenamento de mídia é pendência LGPD/DPO).</p>
      </>}
      {call.mediaError && <div className="inline-error" role="alert">{call.mediaError}</div>}
      {roomStatus === 'closed' && <p className="muted">Sala encerrada pelo profissional.</p>}
      <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
        <video data-testid="tc-video-local" autoPlay playsInline muted
          ref={el => { if (el && call.localRef.current) el.srcObject = call.localRef.current; }}
          style={{ width: 240, background: '#000', borderRadius: 8 }} />
        <video data-testid="tc-video-remote" autoPlay playsInline
          ref={el => { if (el && call.remoteRef.current && el.srcObject !== call.remoteRef.current) el.srcObject = call.remoteRef.current; }}
          style={{ width: 320, background: '#000', borderRadius: 8 }} />
      </div>
    </div>
  </section>;
}
