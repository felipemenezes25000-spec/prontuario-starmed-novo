// StarMed Fase 6 — MLLP REAL sobre TLS (ST-P1-009/010).
//
// Contrato de segurança (decisão nomeada): MLLP SEM TLS não é suportado.
// HL7_MLLP_TLS=true (padrão) + HL7_MLLP_CA=<pem> é o ÚNICO transporte aceito:
// sem CA própria a função falha ANTES de abrir socket (fail-closed, zero
// rede). Certificado/client key são opcionais (mTLS) e devem vir juntos.
//
// Enquadramento MLLP: <VT> (0x0B) + mensagem HL7 + <FS><CR> (0x1C 0x0D).
// A resposta do servidor é lida até o primeiro <FS> e parseada como ACK.
import { readFile } from 'node:fs/promises';
import { connect } from 'node:tls';
import { parseAck, wrapMllp, type Hl7Ack } from './hl7v2';

/** MLLP frame: FSA <VT> payload <FS><CR> — bytes exatos, testados. */
export function frameMllp(message: string): Buffer {
  return wrapMllp(message);
}

/**
 * Pura: varre um buffer acumulado em busca do delimitador <FS>. `consumed`
 * informa quantos bytes podem ser descartados do acumulador (frame completo
 * incluindo o <CR> final, quando presente).
 */
export function readMllpResponse(buffer: Buffer): { complete: boolean; consumed: number; payload: Buffer | null } {
  const fsIndex = buffer.indexOf(0x1c);
  if (fsIndex === -1) return { complete: false, consumed: buffer.length, payload: null };
  const start = buffer.length > 0 && buffer[0] === 0x0b ? 1 : 0;
  return { complete: true, consumed: Math.min(fsIndex + 2, buffer.length), payload: buffer.subarray(start, fsIndex) };
}

export type MllpSendInput = {
  host: string;
  port: number;
  message: string;
  caPath?: string | null;
  certPath?: string | null;
  keyPath?: string | null;
};

export type MllpSendResult = { bytes: number; ack: Hl7Ack | null };

/**
 * Envia uma mensagem HL7 por MLLP sobre TLS e devolve o ACK. Pura-de-config:
 * sem `caPath` (ou com TLS desligado) NENHUMA conexão é aberta — o erro é
 * honesto e local. `rejectUnauthorized: true` sempre (CA própria obrigatória).
 */
export async function sendHl7MllpTls(input: MllpSendInput, timeoutMs = 5000): Promise<MllpSendResult> {
  const { host, port, message } = input;
  if (!host || !host.trim()) throw new Error('MLLP: host obrigatório');
  if (!Number.isInteger(port) || port <= 0) throw new Error('MLLP: port inválida');
  if (!message || message.trim().length === 0) throw new Error('MLLP: mensagem vazia');
  if (!input.caPath) {
    throw new Error('MLLP: HL7_MLLP_CA ausente — TLS com CA própria é o único transporte aceito (nenhuma conexão aberta)');
  }
  if ((input.certPath && !input.keyPath) || (!input.certPath && input.keyPath)) {
    throw new Error('MLLP: certPath e keyPath (mTLS) devem ser informados juntos');
  }
  const ca = await readFile(input.caPath, 'utf8');
  const cert = input.certPath ? await readFile(input.certPath, 'utf8') : undefined;
  const key = input.keyPath ? await readFile(input.keyPath, 'utf8') : undefined;

  const frame = frameMllp(message);
  return new Promise<MllpSendResult>((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const finish = (err: Error | null, result?: MllpSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result!);
    };
    const timer = setTimeout(
      () => finish(new Error(`MLLP: timeout de ${timeoutMs}ms sem ACK de ${host}:${port}`)),
      timeoutMs
    );
    const socket = connect({ host, port, ca: [ca], cert, key, rejectUnauthorized: true }, () => {
      socket.write(frame);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const leitura = readMllpResponse(buffer);
      if (!leitura.complete) return;
      const ackText = leitura.payload!.toString('utf8');
      let ack: Hl7Ack | null = null;
      try {
        ack = parseAck(ackText);
      } catch {
        ack = null; // ACK ilegível = honestamente "sem ACK" (nunca vira sucesso).
      }
      finish(null, { bytes: frame.length, ack });
    });
    socket.on('error', (e) => finish(e instanceof Error ? e : new Error('MLLP: erro de socket/TLS')));
    socket.on('close', () => finish(new Error('MLLP: conexão encerrada antes de um ACK completo')));
  });
}
