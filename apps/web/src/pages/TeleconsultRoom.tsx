import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, ShieldCheck, Video, X } from 'lucide-react';
import { api, ApiError, type Session } from '../api';

/**
 * Teleconsulta — sala da EQUIPE (Fase 4, ST-P1-007): mídia real browser↔browser
 * (getUserMedia + RTCPeerConnection), sinalização REST existente (offer/answer/
 * ice com polling de seq), estados de conexão visíveis e reconexão.
 *
 * HONESTIDADE:
 *  - Gravação: NÃO há capacidade de gravação implementada — "Gravação: desligada
 *    (padrão deste ambiente)" é literal; o consentimento registrado é só exibido.
 *    Armazenamento de mídia é pendência LGPD/DPO (ADR do marco).
 *  - ICE/TURN via `GET /teleconsult/ice-config` (env do servidor); sem env →
 *    P2P direto sem credencial.
 *  - Paciente entra com convite SINGLE-USE e usa um token de sala em MEMÓRIA
 *    (nunca localStorage) — ver TeleconsultPatient.tsx.
 */

export type Alert = (text: string, kind?: 'success' | 'error' | 'info') => void;
export type CallBadge = 'Conectando' | 'Conectado' | 'Reconectando…' | 'Falhou' | 'Sala encerrada';

type TeleRoom = { id: string; status: string; recording_consent: boolean | null; created_at: string; lastSeq?: number };
type SignalRow = { seq: number; sender_kind: string; kind: 'offer' | 'answer' | 'ice' | 'bye'; payload: Record<string, unknown> };

/** Mapa de estado da conexão → rótulo EXATO exibido (contrato do E2E). */
export function callBadge(roomStatus: string, pcState: RTCPeerConnectionState): CallBadge {
  if (roomStatus === 'closed') return 'Sala encerrada';
  if (pcState === 'connected') return 'Conectado';
  if (pcState === 'disconnected' || pcState === 'connecting') return pcState === 'connecting' ? 'Conectando' : 'Reconectando…';
  if (pcState === 'failed' || pcState === 'closed') return 'Falhou';
  return 'Conectando';
}

export type SignalSender = {
  post: (kind: SignalRow['kind'], payload: Record<string, unknown>) => Promise<void>;
  poll: (after: number) => Promise<SignalRow[]>;
};

/**
 * Hook da chamada: mídia + RTCPeerConnection + polling da fila de sinais.
 * - STAFF envia a oferta; PACIENTE responde (convenção simples e determinística).
 * - `sendHeaders` carrega o token de sala do paciente (header por requisição).
 */
export function useTeleconsultCall(opts: {
  roomId: string;
  roomStatus: string;
  senderKind: 'clinician' | 'patient';
  sender: SignalSender;
  onRoomClosed: () => void;
}) {
  const { roomStatus, senderKind, sender } = opts;
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const remoteRef = useRef<MediaStream | null>(null);
  const lastSeqRef = useRef(0);
  const sentOfferRef = useRef(false);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollErrorRef = useRef(0);
  const [badge, setBadge] = useState<CallBadge>('Conectando');
  const [mediaError, setMediaError] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [, setRemoteTick] = useState(0); // força re-render quando a trilha remota chega

  const applyBadge = (roomStatusNow: string, state: RTCPeerConnectionState) =>
    setBadge(callBadge(roomStatusNow, state));

  async function handleRow(row: SignalRow) {
    const pc = pcRef.current;
    if (!pc) return;
    if (row.kind === 'answer' && row.sender_kind !== senderKind) {
      if (!pc.remoteDescription) await pc.setRemoteDescription({ type: 'answer', sdp: String(row.payload.sdp ?? '') });
      for (const cand of pendingIceRef.current.splice(0)) await pc.addIceCandidate(cand).catch(() => undefined);
    } else if (row.kind === 'ice' && row.sender_kind !== senderKind) {
      const candidate = row.payload.candidate as RTCIceCandidateInit | undefined;
      if (candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(candidate).catch(() => undefined);
        else pendingIceRef.current.push(candidate);
      }
    } else if (row.kind === 'offer' && row.sender_kind !== senderKind && pc.signalingState === 'stable') {
      await pc.setRemoteDescription({ type: 'offer', sdp: String(row.payload.sdp ?? '') });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sender.post('answer', { sdp: answer.sdp });
      for (const cand of pendingIceRef.current.splice(0)) await pc.addIceCandidate(cand).catch(() => undefined);
    } else if (row.kind === 'bye') {
      opts.onRoomClosed();
    }
  }

  async function pollLoop() {
    try {
      const rows = await sender.poll(lastSeqRef.current);
      pollErrorRef.current = 0;
      // Sucesso após degradação → recomputa o badge a partir do WebRTC real.
      if (pcRef.current) applyBadge(roomStatus, pcRef.current.connectionState);
      for (const row of rows) {
        // O cursor só avança DEPOIS de tratar: erro transitório (rede) reprocessa
        // a MESMA linha no próximo tick — nunca descarta oferta/ICE silenciosamente.
        await handleRow(row);
        lastSeqRef.current = Math.max(lastSeqRef.current, row.seq);
      }
    } catch (e) {
      // Sinalização degradada (HTTP fora): após 3 falhas seguidas o badge avisa
      // 'Reconectando…' — estado honesto do CANAL DE SINAIS (a mídia pode ainda
      // trafegar; ao voltar, o badge volta a refletir o estado do WebRTC).
      pollErrorRef.current += 1;
      if (pollErrorRef.current >= 3 && pcRef.current && pcRef.current.connectionState === 'connected') setBadge('Reconectando…');
      console.error('[teleconsult] falha ao processar sinais:', e instanceof Error ? e.message : 'erro');
    }
  }

  async function start() {
    setMediaError('');
    try {
      const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      localRef.current = local;
      const ice = await api<{ iceServers: Array<Record<string, unknown>>; warning?: string }>('/teleconsult/ice-config', null, 'GET');
      const pc = new RTCPeerConnection({ iceServers: ice.iceServers as unknown as RTCIceServer[] });
      pcRef.current = pc;
      for (const track of local.getTracks()) pc.addTrack(track, local);
      pc.onconnectionstatechange = () => applyBadge(roomStatus, pc.connectionState);
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected') setBadge('Reconectando…');
        if (pc.iceConnectionState === 'connected') applyBadge(roomStatus, pc.connectionState);
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) void sender.post('ice', { candidate: e.candidate.toJSON() }).catch(() => undefined);
      };
      pc.ontrack = (e) => { remoteRef.current = e.streams[0]; setRemoteTick(t => t + 1); };
      if (senderKind === 'clinician') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sentOfferRef.current = true;
        await sender.post('offer', { sdp: offer.sdp });
      }
      setBadge(callBadge(roomStatus, pc.connectionState));
      timerRef.current = setInterval(() => void pollLoop(), 1000);
      void pollLoop();
      return true;
    } catch (e) {
      setMediaError(e instanceof Error && /Permission|NotAllowed|Device/.test(e.message)
        ? 'Câmera/microfone indisponível ou permissão negada pelo navegador.'
        : 'Não foi possível iniciar a mídia local.');
      return false;
    }
  }

  async function hangUp(sendBye: boolean) {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (sendBye) { try { await sender.post('bye', {}); } catch { /* sala pode já estar fechada */ } }
    pcRef.current?.getSenders().forEach(() => undefined);
    pcRef.current?.close();
    pcRef.current = null;
    localRef.current?.getTracks().forEach(t => t.stop());
    localRef.current = null;
    setBadge(sendBye ? 'Sala encerrada' : callBadge('closed', 'closed'));
  }

  function toggleMic() {
    const track = localRef.current?.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setMicOn(track.enabled); }
  }

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); localRef.current?.getTracks().forEach(t => t.stop()); pcRef.current?.close(); }, []);

  return { badge, mediaError, micOn, toggleMic, start, hangUp, pcRef, localRef, remoteRef };
}

// ------------------------------------------------------------------ página --

export function TeleconsultPage({ session, alert }: { session: Session; alert: Alert }) {
  const token = session.accessToken;
  const isStaff = session.user.role === 'doctor' || session.user.role === 'nurse' || session.user.role === 'admin';
  const [encounterId, setEncounterId] = useState('');
  const [invite, setInvite] = useState<{ inviteCode: string; id: string } | null>(null);
  const [roomId, setRoomId] = useState('');
  const [consent, setConsent] = useState('true');
  const [room, setRoom] = useState<TeleRoom | null>(null);
  const [busy, setBusy] = useState(false);
  const [inCall, setInCall] = useState(false);

  const sender: SignalSender = {
    post: async (kind, payload) => {
      await api(`/teleconsult/rooms/${roomId}/signals`, token, 'POST', { kind, senderKind: 'clinician', payload });
    },
    poll: (after) => api<SignalRow[]>(`/teleconsult/rooms/${roomId}/signals?after=${after}`, token)
  };
  const call = useTeleconsultCall({
    roomId, roomStatus: room?.status ?? 'waiting', senderKind: 'clinician', sender,
    onRoomClosed: () => { setBadgeAndRoomClosed(); }
  });
  function setBadgeAndRoomClosed() { setRoom(r => r ? { ...r, status: 'closed' } : r); void call.hangUp(false); }

  const shareLink = roomId ? `${window.location.origin}${window.location.pathname}#teleconsult=${roomId}` : '';

  async function createRoom(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api<{ id: string; inviteCode: string; status: string }>('/teleconsult/rooms', token, 'POST', { encounterId });
      setInvite({ inviteCode: r.inviteCode, id: r.id });
      setRoomId(r.id);
      setRoom({ id: r.id, status: r.status, recording_consent: null, created_at: new Date().toISOString() });
      alert('Sala criada. Envie o código de convite ao paciente por canal seguro.', 'success');
    } catch (err) { alert((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  async function saveConsent(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api(`/teleconsult/rooms/${roomId}/consent`, token, 'POST', { recordingConsent: consent === 'true' });
      setRoom(r => r ? { ...r, recording_consent: consent === 'true' } : r);
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
  async function joinRoom() {
    if (!room) { alert('Carregue a sala antes de entrar.', 'error'); return; }
    if (room.recording_consent === null) { alert('Registre o consentimento de gravação (aceito ou recusado) antes de entrar.', 'error'); return; }
    setBusy(true);
    try {
      const joined = await api<{ status: string }>(`/teleconsult/rooms/${roomId}/join`, token, 'POST');
      setRoom(r => (r ? { ...r, status: joined.status } : r));
      const ok = await call.start();
      if (ok) { setInCall(true); alert('Você entrou na sala.', 'success'); }
    } catch (err) {
      alert(err instanceof ApiError ? err.message : (err as Error).message, 'error');
    } finally { setBusy(false); }
  }

  if (!isStaff) return <section>
    <div className="page-heading"><div><span className="eyebrow">TELEMEDICINA</span><h1>Teleconsulta</h1></div></div>
    <div className="panel"><div className="empty-state"><Video size={32}/><h2>Área da equipe assistencial</h2>
      <p>Criação de salas é restrita a médicos, enfermagem e administradores.</p></div></div>
  </section>;

  return <section>
    <div className="page-heading"><div><span className="eyebrow">TELEMEDICINA</span><h1>Teleconsulta</h1>
      <p>Mídia peer-to-peer no navegador; o StarMed gerencia sala, consentimento, sinalização e estados de conexão.</p></div></div>

    <div className="content-grid">
      <div className="panel"><div className="panel-title"><h2>Nova sala</h2><Video size={19}/></div>
        <form className="stack gap-4" onSubmit={createRoom}>
          <label>Atendimento (UUID)<input required value={encounterId} onChange={e => setEncounterId(e.target.value)} placeholder="UUID do atendimento (consulte /encounters)"/></label>
          <button className="primary-button" disabled={busy} type="submit"><Plus size={16}/> Criar sala e convite</button>
        </form>
        {invite && <div className="clinical-chip" style={{ marginTop: 12 }}>
          <strong>Convite: {invite.inviteCode}</strong>
          <small>Sala {invite.id.slice(0, 8)} • válido por 6h • uso único. Envie por canal seguro (não é exibido de novo).</small>
          {shareLink && <small data-testid="tc-share-link">Link do paciente: {shareLink}</small>}
        </div>}
        <p className="muted footnote">A mídia é peer-to-peer no navegador; sem ICE/TURN configurado o par trafega diretamente (P2P).</p>
      </div>

      <div className="panel"><div className="panel-title"><h2>Consentimento de gravação</h2><ShieldCheck size={19}/></div>
        <form className="stack gap-3" onSubmit={saveConsent}>
          <label>Sala (UUID)<input required value={roomId} onChange={e => setRoomId(e.target.value)} placeholder="UUID da sala"/></label>
          <label>Consentimento<select value={consent} onChange={e => setConsent(e.target.value)}><option value="true">Aceito (pode gravar)</option><option value="false">Recusado (sem gravação)</option></select></label>
          <button className="secondary-button" disabled={busy} type="submit"><ShieldCheck size={15}/> Registrar consentimento</button>
        </form>
        <p className="muted footnote">O consentimento é obrigatório antes de entrar (o servidor bloqueia sem ele).</p>
      </div>
    </div>

    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-title"><h2>Sala</h2>
        <button type="button" className="text-button" onClick={() => void loadRoom()}><Video size={14}/> Recarregar estado</button></div>
      <div className="stack gap-3">
        <div>
          <span className="small-pill">Estado: {room ? (room.status === 'open' ? 'aberta' : room.status === 'waiting' ? 'aguardando' : 'encerrada') : '—'}</span>{' '}
          <span className="small-pill">Gravação: desligada (padrão deste ambiente — armazenamento de mídia é pendência LGPD/DPO)</span>
        </div>
        {inCall && <div data-testid="tc-call-state">
          <span className="small-pill" style={{ marginRight: 8 }}>Conexão: {call.badge}</span>
          <button type="button" className="secondary-button" onClick={call.toggleMic}>{call.micOn ? 'Desativar microfone' : 'Ativar microfone'}</button>{' '}
          <button type="button" className="primary-button" onClick={() => { setInCall(false); setRoom(r => (r ? { ...r, status: 'closed' } : r)); void call.hangUp(true); }}><X size={15}/> Encerrar</button>
        </div>}
        {!inCall && room?.status !== 'closed' && <>
          <div className="action-row">
            <button type="button" className="primary-button" disabled={busy || !roomId} onClick={() => void joinRoom()}><Video size={16}/> Entrar da sala</button>
            {room?.status === 'closed' && <span className="small-pill">Sala encerrada</span>}
          </div>
          {call.mediaError && <div className="inline-error" role="alert">{call.mediaError}</div>}
        </>}
        {room?.status === 'closed' && <p className="muted">Sala encerrada — crie uma nova sala para uma nova teleconsulta.</p>}
        <div style={{ display: 'flex', gap: 12 }}>
          <video data-testid="tc-video-local" autoPlay playsInline muted ref={el => { if (el && call.localRef.current) el.srcObject = call.localRef.current; }}
            style={{ width: 240, background: '#000', borderRadius: 8 }} />
          <video data-testid="tc-video-remote" autoPlay playsInline
            ref={el => { if (el && call.remoteRef.current && el.srcObject !== call.remoteRef.current) el.srcObject = call.remoteRef.current; }}
            style={{ width: 320, background: '#000', borderRadius: 8 }} />
        </div>
      </div>
    </div>
  </section>;
}
