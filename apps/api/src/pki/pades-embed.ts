/**
 * Embarque PAdES (ByteRange) em PDF — puro, sem rede (C6 / J1 #10).
 *
 * Conceito: o CMS é um detached signature sobre os bytes DO ARQUIVO EXCETO o
 * próprio valor hex do /Contents (o "buraco" do ByteRange). Ordem correta —
 * e esta é a parte que costuma dar errado:
 *   1) reserveSignatureSpace: monta o layout com /Contents zerado e grava o
 *      ByteRange REAL (0, A, B, C) ANTES de assinar — os 4 números são
 *      deterministicos pelo layout (largura fixa), então podem (e devem) entrar
 *      na região assinada já com valor final; depois disso só o Contents muda,
 *      e ele fica 100% dentro do buraco.
 *   2) Assine os BYTES FORA DO BURACO (slice(0,A) + slice(B,C)), não o arquivo
 *      inteiro — é o que o verificador recalcula.
 *   3) embedSignature preenche APENAS o /Contents (mesmíssimo tamanho → offsets
 *      e ByteRange permanecem válidos por construção).
 * Qualquer byte fora do buraco alterado invalida a verificação (J1 #10).
 *
 * Restrições declaradas: opera no formato de xref clássico produzido pelo
 * builder de prescrições (xref/trailer tradicionais); PDF com xref comprimido
 * ou objeto stream lança erro claro em vez de corromper silenciosamente.
 */
import * as asn1js from 'asn1js';

export const RESERVED_HEX_CHARS = 65536; // 32 KiB de CMS — folga generosa

const CONTENTS_RE = /\/Contents <(0+)>/;
const BYTERANGE_SLOT = '[0000000000 0000000000 0000000000 0000000000]';

export type EmbeddedSignature = { byteRange: [number, number, number, number]; cms: Buffer };

function latin1(buf: Buffer): string { return buf.toString('latin1'); }

/** Último startxref → offset da tabela xref (formato clássico). */
function findLastXref(pdf: Buffer): { xrefOffset: number } {
  const text = latin1(pdf);
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!m) throw new Error('PDF sem startxref/%%EOF final — não é um PDF fechado');
  const xrefOffset = Number(m[1]);
  if (!Number.isInteger(xrefOffset) || latin1(pdf.subarray(xrefOffset, xrefOffset + 4)) !== 'xref')
    throw new Error('startxref não aponta para uma tabela xref clássica (xref comprimido/stream não suportado)');
  return { xrefOffset };
}

type XrefData = { entries: Map<number, number>; trailer: string; size: number };

function parseClassicXref(pdf: Buffer, xrefOffset: number): XrefData {
  const text = latin1(pdf);
  const head = /^xref\s+(\d+) (\d+)\s/.exec(text.slice(xrefOffset));
  if (!head) throw new Error('tabela xref ilegível (formato inesperado)');
  const start = Number(head[1]);
  const count = Number(head[2]);
  const entriesOffset = xrefOffset + head[0].length;
  const entries = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    // Linha clássica de 20 bytes: 'nnnnnnnnnn ggggg n' + EOL (prefixo basta).
    const raw = text.slice(entriesOffset + i * 20, entriesOffset + (i + 1) * 20);
    const parsed = /^(\d{10}) (\d{5}) ([nf]) /.exec(raw);
    if (!parsed) throw new Error(`linha de xref inválida na posição ${entriesOffset + i * 20}`);
    if (parsed[3] === 'n') entries.set(start + i, Number(parsed[1]));
  }
  const trailerAt = text.indexOf('trailer', entriesOffset + count * 20);
  if (trailerAt < 0) throw new Error('trailer não encontrado após a xref');
  const trailerEnd = text.indexOf('>>', trailerAt);
  if (trailerEnd < 0) throw new Error('dicionário trailer malformado');
  const trailer = text.slice(trailerAt + 'trailer'.length, trailerEnd + 2);
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)?.[1] ?? NaN);
  if (!Number.isInteger(size) || size < 2) throw new Error('/Size do trailer inválido');
  return { entries, trailer, size };
}

function readObject(pdf: Buffer, offset: number): string {
  const text = latin1(pdf.subarray(offset));
  const end = text.indexOf('endobj');
  if (end < 0) throw new Error('objeto sem endobj');
  return text.slice(0, end).trim();
}

/** Primeira página (objeto /Page) para o /P do widget — melhor esforço. */
function firstPageRef(catalogDict: string, xref: XrefData, pdf: Buffer): string | null {
  const pagesRef = /\/Pages\s+(\d+) (\d+) R/.exec(catalogDict);
  if (!pagesRef) return null;
  const pagesOffset = xref.entries.get(Number(pagesRef[1]));
  if (pagesOffset === undefined) return null;
  const pagesDict = readObject(pdf, pagesOffset);
  const kids = /\/Kids\s*\[(\d+) (\d+) R/.exec(pagesDict);
  return kids ? `${kids[1]} ${kids[2]} R` : null;
}

/**
 * Reserva o espaço da assinatura e grava o ByteRange REAL (pré-assinatura).
 * Retorna o PDF pronto para ter os bytes externos ao buraco assinados.
 */
export function reserveSignatureSpace(pdf: Buffer, reservedHexChars: number = RESERVED_HEX_CHARS): Buffer {
  if (reservedHexChars < 2048 || reservedHexChars % 2 !== 0)
    throw new Error('reservedHexChars par e >= 2048');
  const { xrefOffset } = findLastXref(pdf);
  const xref = parseClassicXref(pdf, xrefOffset);
  const rootMatch = /\/Root\s+(\d+) (\d+) R/.exec(xref.trailer);
  if (!rootMatch) throw new Error('trailer sem /Root');
  const rootNum = Number(rootMatch[1]);
  const rootOffset = xref.entries.get(rootNum);
  if (rootOffset === undefined) throw new Error('/Root aponta para objeto fora da xref');
  const catalogDict = readObject(pdf, rootOffset);
  if (/\/AcroForm/.test(catalogDict)) throw new Error('PDF já possui /AcroForm — reserveSignatureSpace só cobre o formato do builder StarMed (AcroForm ausente)');

  const pageRef = firstPageRef(catalogDict, xref, pdf);
  const head = latin1(pdf.subarray(0, xrefOffset)); // todos os offsets originais seguem válidos

  const newRootNum = xref.size;          // N
  const sigNum = xref.size + 1;          // N+1
  const fieldNum = xref.size + 2;        // N+2
  const contentsHex = '0'.repeat(reservedHexChars);
  const sigDict =
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached ` +
    `/Contents <${contentsHex}> /ByteRange ${BYTERANGE_SLOT} >>`;
  const fieldDict =
    `<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /F 4 ` +
    `${pageRef ? `/P ${pageRef} ` : ''}/T (StarMedSignature) /V ${sigNum} 0 R >>`;
  const newCatalog = catalogDict.replace(/>>\s*$/, `/AcroForm << /Fields [${fieldNum} 0 R] /SigFlags 3 >> >>`);

  let appended = '';
  const offsets = new Map<number, number>();
  const push = (n: number, body: string) => {
    offsets.set(n, Buffer.byteLength(head + appended, 'latin1'));
    appended += `${n} 0 obj\n${body}\nendobj\n`;
  };
  push(newRootNum, newCatalog);
  push(sigNum, sigDict);
  push(fieldNum, fieldDict);

  const size = xref.size + 3;
  const xrefStart = Buffer.byteLength(head + appended, 'latin1');
  let xrefTable = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    const off = n < xref.size ? xref.entries.get(n) : offsets.get(n);
    if (off === undefined) throw new Error(`offset desconhecido para o objeto ${n}`);
    xrefTable += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  // Trailer: dicionário original com /Size novo e /Root NOVO (o catálogo original
  // fica intocado no arquivo; o trailer aponta para a cópia com /AcroForm).
  const trailerDict = xref.trailer
    .replace(/\/Root\s+\d+ \d+ R/, `/Root ${newRootNum} 0 R`)
    .replace(/\/Size\s+\d+/, `/Size ${size}`);
  const tail = `trailer\n${trailerDict}\nstartxref\n${xrefStart}\n%%EOF\n`;

  // Reescrevemos a partir do início (head preserva TODOS os offsets originais).
  const body = Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from(appended + xrefTable + tail, 'latin1')]);

  // ByteRange REAL, gravado ANTES do assinamento (valores deterministicos pelo layout).
  return stampByteRange(body);
}

/** Grava [0, A, B, len] no slot — A = offset do '<', B = offset após '>'. */
export function stampByteRange(pdf: Buffer): Buffer {
  const text = latin1(pdf);
  const contents = CONTENTS_RE.exec(text);
  if (!contents) throw new Error('slot /Contents não encontrado para o ByteRange');
  const inner = contents[1]; // zeros do placeholder
  const open = contents.index + contents[0].indexOf('<');
  const close = open + 1 + inner.length + 1;
  if (text[close - 1] !== '>') throw new Error('slot /Contents malformado');
  const a = open;
  const b = close;
  const c = pdf.length;
  const digits = (n: number) => { const s = String(n); if (s.length > 10) throw new Error('ByteRange excede 10 dígitos'); return s.padStart(10, '0'); };
  const prefix = '/ByteRange ';
  const replacement = `[${digits(a)} ${digits(b)} ${digits(c)}]`;
  if (replacement.length !== BYTERANGE_SLOT.length)
    throw new Error('ByteRange com largura diferente do slot (offsets mudariam)');
  // indexOf determinístico contra a CONSTANTE do slot (sem armadilhas de replace).
  const slot = prefix + BYTERANGE_SLOT;
  const slotAt = text.indexOf(slot);
  if (slotAt < 0) {
    // Idempotência: slot já preenchido com valores consistentes → não regrava.
    if (/\/ByteRange \[\d{10} \d{10} \d{10} \d{10}\]/.test(text)) return pdf;
    throw new Error('slot /ByteRange zerado não encontrado');
  }
  const stamped = text.slice(0, slotAt) + prefix + replacement + text.slice(slotAt + slot.length);
  if (stamped.length !== text.length) throw new Error('ByteRange alterou o tamanho do arquivo');
  return Buffer.from(stamped, 'latin1');
}

/** Preenche APENAS o /Contents com o CMS (hex + padding de zeros, mesma largura). */
export function embedSignature(pdfReserved: Buffer, cms: Buffer): Buffer {
  const text = latin1(pdfReserved);
  const match = CONTENTS_RE.exec(text);
  if (!match) throw new Error('slot /Contents zerado não encontrado (o PDF já foi embebido?)');
  const maxChars = match[1].length;
  if (cms.length * 2 > maxChars)
    throw new Error(`CMS de ${cms.length} bytes excede a reserva de ${maxChars / 2} bytes`);
  const hex = cms.toString('hex');
  const padded = hex + '0'.repeat(maxChars - hex.length);
  const replaced = text.slice(0, match.index) + `/Contents <${padded}>` + text.slice(match.index + match[0].length);
  if (replaced.length !== text.length) throw new Error('embed alterou o tamanho do arquivo');
  return Buffer.from(replaced, 'latin1');
}

/** Lê /ByteRange + CMS embutidos; geometria quebrada → null (J1 #10 começa aqui). */
export function readEmbeddedSignature(pdf: Buffer): EmbeddedSignature | null {
  const text = latin1(pdf);
  const br = /\/ByteRange \[([0-9]{1,10}) ([0-9]{1,10}) ([0-9]{1,10}) ([0-9]{1,10})\]/.exec(text);
  if (!br) return null;
  if (Number(br[1]) !== 0) return null;              // primeiro intervalo sempre começa em 0
  const a = Number(br[2]);
  const b = Number(br[3]);
  const c = Number(br[4]);
  if (!(a > 0 && a < b && b <= c && c === pdf.length)) return null;
  if (pdf[a] !== 0x3c || pdf[b - 1] !== 0x3e) return null; // '<' ... '>'
  const inner = text.slice(a + 1, b - 1);
  if (!/^[0-9a-fA-F]*$/.test(inner) || inner.length % 2 !== 0) return null;
  let cms = Buffer.from(inner, 'hex');
  const ber = (buf: Buffer): boolean => {
    try {
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      asn1js.fromBER(ab);
      return true;
    } catch { return false; }
  };
  // Comprimento EXATO do CMS pelo cabeçalho DER (SEQUENCE): retira o padding de
  // zeros sem adivinhar — cortar "0x00 finais" às cegas pode comer bytes reais.
  const derEnd = derSequenceLength(cms);
  if (derEnd !== null && derEnd <= cms.length && ber(cms.subarray(0, derEnd))) {
    cms = Buffer.from(cms.subarray(0, derEnd));
  } else {
    // Fallback: zeros finais de padding, validando o BER de cada candidato.
    let end = cms.length;
    while (end > 0 && cms[end - 1] === 0) end--;
    const trimmed = cms.subarray(0, end);
    if (trimmed.length && ber(trimmed)) cms = Buffer.from(trimmed);
    else if (!ber(cms)) return null;
  }
  return { byteRange: [0, a, b, c], cms };
}

/** Tamanho total (cabeçalho + conteúdo) de uma SEQUENCE DER, ou null. */
function derSequenceLength(buf: Buffer): number | null {
  if (buf.length < 4 || buf[0] !== 0x30) return null;
  const marker = buf[1];
  if (marker < 0x80) return 2 + marker;
  const lenBytes = marker & 0x7f;
  if (lenBytes === 0 || lenBytes > 4 || buf.length < 2 + lenBytes) return null;
  let length = 0;
  for (let i = 0; i < lenBytes; i++) length = (length * 256) + buf[2 + i];
  return 2 + lenBytes + length;
}

/** Bytes assinados = fora do buraco. */
export function signedBytesOf(pdf: Buffer): Buffer | null {
  const read = readEmbeddedSignature(pdf);
  if (!read) return null;
  const [, a, b, c] = read.byteRange;
  return Buffer.concat([pdf.subarray(0, a), pdf.subarray(b, c)]);
}

/**
 * Verificação ponta a ponta: geometria do ByteRange + CMS sobre os bytes
 * externos ao buraco. Alterar 1 byte fora do buraco → o verifyCms falha;
 * alterar o buraco/geometria → ok:false.
 */
export async function verifyEmbeddedSignature<T extends object>(
  pdf: Buffer,
  verifyCms: (cms: Buffer, signedBytes: Buffer) => Promise<T>
): Promise<{ ok: true; byteRange: [number, number, number, number]; result: T } | { ok: false; reason: string }> {
  const read = readEmbeddedSignature(pdf);
  if (!read)
    return { ok: false, reason: 'ByteRange/Contents ausentes ou geometria inválida — assinatura embutida não confiável (J1 #10).' };
  const signed = Buffer.concat([pdf.subarray(0, read.byteRange[1]), pdf.subarray(read.byteRange[2], read.byteRange[3])]);
  const result = await verifyCms(read.cms, signed);
  return { ok: true, byteRange: read.byteRange, result };
}
