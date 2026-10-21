// StarMed interop — HL7 v2.x messaging (PURE module: no Nest/DB imports, safe for node:test via tsx).
// Supports the ADT^A01 / ADT^A03 / ORU^R01 subset used by the integration tests, HL7 escape
// sequences (\F\ \S\ \T\ \R\ \E\), ACK generation (AA/AE/AR) and MLLP framing.

import { randomUUID } from 'node:crypto';

export type Hl7Delimiters = {
  field: string;
  component: string;
  repetition: string;
  escape: string;
  subcomponent: string;
};

export const HL7_DELIMITERS: Hl7Delimiters = { field: '|', component: '^', repetition: '~', escape: '\\', subcomponent: '&' };

export type Hl7ParsedMessage = { segmentos: Map<string, string[][]> };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Decodes the five standard HL7 escape sequences against the message delimiters. */
export function unescapeHl7(value: string, delims: Hl7Delimiters = HL7_DELIMITERS): string {
  if (!value || !value.includes(delims.escape)) return value;
  const map: Record<string, string> = {
    F: delims.field,
    S: delims.component,
    T: delims.subcomponent,
    R: delims.repetition,
    E: delims.escape
  };
  const pattern = new RegExp(`${escapeRegExp(delims.escape)}([FSTRE])${escapeRegExp(delims.escape)}`, 'g');
  return value.replace(pattern, (_match, code: string) => map[code] ?? code);
}

/** Escapes reserved HL7 characters so a value can be safely placed inside one field. */
export function escapeHl7Field(value: string, delims: Hl7Delimiters = HL7_DELIMITERS): string {
  if (!value) return value;
  const e = delims.escape;
  let out = value.split(e).join(e + 'E' + e);
  out = out.split(delims.field).join(e + 'F' + e);
  out = out.split(delims.component).join(e + 'S' + e);
  out = out.split(delims.repetition).join(e + 'R' + e);
  out = out.split(delims.subcomponent).join(e + 'T' + e);
  return out;
}

/**
 * Parses a raw HL7 message into a segment map: segment name -> list of occurrences,
 * each occurrence being the field array where index 0 is the segment name and index N
 * is field N (MSH-1 is the field separator itself, per the spec).
 */
export function parseHL7V2(message: string): Hl7ParsedMessage {
  const normalized = message.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  const lines = normalized.split('\r').map(line => line.trimEnd()).filter(line => line.length > 0);
  if (lines.length === 0 || !lines[0].startsWith('MSH')) throw new Error('HL7: mensagem sem segmento MSH');
  const field = lines[0].charAt(3);
  if (!field) throw new Error('HL7: MSH truncado');
  // MSH-2 must carry the standard encoding characters for this parser; anything else is rejected.
  const encoding = lines[0].split(field)[1] ?? '';
  if (encoding.length >= 4 && encoding.slice(0, 4) !== '^~\\&') throw new Error('HL7: caracteres de codificação não suportados em MSH-2');
  const segmentos = new Map<string, string[][]>();
  for (const line of lines) {
    const name = line.slice(0, 3).toUpperCase();
    let parts = line.split(field);
    if (name === 'MSH') parts = [name, field, ...parts.slice(1)];
    const occurrences = segmentos.get(name) ?? [];
    occurrences.push(parts);
    segmentos.set(name, occurrences);
  }
  return { segmentos };
}

/**
 * Reads field `idx` (1-based) of one segment occurrence; with `sub` returns that
 * component (1-based). The returned value is always unescaped.
 */
export function getFieldValue(fields: string[] | undefined, idx: number, sub?: number, delims: Hl7Delimiters = HL7_DELIMITERS): string {
  if (!fields) return '';
  const raw = fields[idx] ?? '';
  if (raw === '') return '';
  if (sub === undefined || sub < 1) return unescapeHl7(raw, delims);
  return unescapeHl7(raw.split(delims.component)[sub - 1] ?? '', delims);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Builds an ACK for `original`: MSH-9 is ACK + the original trigger event (e.g. ACK^A01),
 * MSA-1 carries the acknowledgment code and MSA-2 the original MSH-10 control id.
 * For AE/AR the error text goes into MSA-3, HL7-escaped.
 */
export function buildAck(original: string, code: 'AA' | 'AE' | 'AR', errorMessage?: string): string {
  const parsed = parseHL7V2(original);
  const msh = parsed.segmentos.get('MSH')?.[0];
  const originalControlId = getFieldValue(msh, 10);
  if (!originalControlId) throw new Error('HL7: MSH-10 ausente, impossível gerar ACK');
  const trigger = getFieldValue(msh, 9, 2);
  const ackType = trigger ? `ACK^${trigger}` : 'ACK';
  const now = new Date();
  const timestamp =
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
  // MSH-1 is the field separator itself (implicit in join); elements after 'MSH' start at MSH-2.
  const mshLine = [
    'MSH', '^~\\&',
    getFieldValue(msh, 5) || 'STARMed',
    getFieldValue(msh, 6) || 'CDT',
    getFieldValue(msh, 3) || '',
    getFieldValue(msh, 4) || '',
    timestamp, '', ackType, randomUUID(), 'P', '2.5'
  ].join(HL7_DELIMITERS.field);
  const msaFields = ['MSA', code, originalControlId];
  if (code !== 'AA' && errorMessage) msaFields.push(escapeHl7Field(errorMessage));
  return [mshLine, msaFields.join('|')].join('\r') + '\r';
}

/** MLLP framing: <VT> payload <FS> <CR>. */
export function wrapMllp(payload: Buffer | string): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from([0x0b]), buf, Buffer.from([0x1c, 0x0d])]);
}

/** Validates MLLP delimiters and returns the inner payload; throws on malformed frames. */
export function unwrapMllp(frame: Buffer): Buffer {
  if (!Buffer.isBuffer(frame) || frame.length < 3) throw new Error('MLLP: frame truncado');
  if (frame[0] !== 0x0b) throw new Error('MLLP: byte inicial <VT> ausente');
  if (frame[frame.length - 2] !== 0x1c || frame[frame.length - 1] !== 0x0d) throw new Error('MLLP: delimitador final <FS><CR> ausente');
  return frame.subarray(1, frame.length - 2);
}

/** ACK recebido por MLLP: código MSA-1, controle MSA-2 e texto de erro MSA-3. */
export type Hl7Ack = { code: 'AA' | 'AE' | 'AR' | string; controlId: string | null; error: string | null };

/**
 * Parses the MSA segment of a received ACK (Fase 6 — envio MLLP de saída).
 * Throws on a message without MSA or without MSA-1: an unreadable ACK is
 * NEVER treated as success by the caller.
 */
export function parseAck(ack: string): Hl7Ack {
  const msa = parseHL7V2(ack).segmentos.get('MSA')?.[0];
  if (!msa) throw new Error('HL7: ACK sem segmento MSA');
  const code = getFieldValue(msa, 1);
  if (!code) throw new Error('HL7: MSA-1 (código de ACK) ausente');
  return { code, controlId: getFieldValue(msa, 2) || null, error: getFieldValue(msa, 3) || null };
}

export type AdtFields = {
  patientExternalId: string;
  patientName: string;
  birthDate: string;
  clinic: string;
  ward: string;
  room: string;
  bed: string;
  admissionAt?: string;
  dischargeAt?: string;
};

function toIsoDate(raw: string): string {
  const value = raw.trim();
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return value;
}

function toIsoDateTime(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (/^\d{14}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`;
  }
  if (/^\d{8}$/.test(value)) return toIsoDate(value);
  return value;
}

function parseAdt(message: string, expected: 'A01' | 'A03'): AdtFields {
  const { segmentos } = parseHL7V2(message);
  const msh = segmentos.get('MSH')?.[0];
  const trigger = getFieldValue(msh, 9, 2);
  if (trigger !== expected) throw new Error(`HL7: esperado ADT^${expected}, recebido ${trigger || '(sem trigger)'}`);
  const pid = segmentos.get('PID')?.[0];
  const pv1 = segmentos.get('PV1')?.[0];
  const nameComponents = pid
    ? [getFieldValue(pid, 5, 1), getFieldValue(pid, 5, 2), getFieldValue(pid, 5, 3)].filter(Boolean)
    : [];
  const fields: AdtFields = {
    patientExternalId: getFieldValue(pid, 3, 1),
    patientName: nameComponents.join(' '),
    birthDate: toIsoDate(getFieldValue(pid, 7)),
    clinic: getFieldValue(pv1, 2),
    ward: getFieldValue(pv1, 3, 1),
    room: getFieldValue(pv1, 3, 2),
    bed: getFieldValue(pv1, 3, 3)
  };
  const admissionAt = toIsoDateTime(getFieldValue(pv1, 44));
  if (admissionAt) fields.admissionAt = admissionAt;
  if (expected === 'A03') {
    const dischargeAt = toIsoDateTime(getFieldValue(pv1, 45));
    if (dischargeAt) fields.dischargeAt = dischargeAt;
  }
  return fields;
}

/** ADT^A01 (admissão): PV1-2 clínica, PV1-3 ala/leito, PID-3/PID-5/PID-7. */
export function parseADT_A01(message: string): AdtFields {
  return parseAdt(message, 'A01');
}

/** ADT^A03 (alta): mesmos campos de A01 mais PV1-45 (dischargeAt). */
export function parseADT_A03(message: string): AdtFields {
  return parseAdt(message, 'A03');
}

export type ObxObservation = {
  identifier: string;
  text?: string;
  value: string;
  units: string;
  referenceRange: string;
  abnormalFlags: string;
};

export type OruR01Message = {
  controlId: string;
  patientExternalId: string;
  patientName: string;
  observations: ObxObservation[];
};

/** Minimal ORU^R01: demographics plus OBX-3/5/6/7/8 observations. */
export function parseORU_R01(message: string): OruR01Message {
  const { segmentos } = parseHL7V2(message);
  const msh = segmentos.get('MSH')?.[0];
  const trigger = getFieldValue(msh, 9, 2);
  if (trigger !== 'R01') throw new Error(`HL7: esperado ORU^R01, recebido ${trigger || '(sem trigger)'}`);
  const pid = segmentos.get('PID')?.[0];
  const obxRows = segmentos.get('OBX') ?? [];
  const nameComponents = pid
    ? [getFieldValue(pid, 5, 1), getFieldValue(pid, 5, 2), getFieldValue(pid, 5, 3)].filter(Boolean)
    : [];
  return {
    controlId: getFieldValue(msh, 10),
    patientExternalId: getFieldValue(pid, 3, 1),
    patientName: nameComponents.join(' '),
    observations: obxRows.map(row => {
      const text = getFieldValue(row, 3, 2);
      const observation: ObxObservation = {
        identifier: getFieldValue(row, 3, 1),
        value: getFieldValue(row, 5),
        units: getFieldValue(row, 6, 1),
        referenceRange: getFieldValue(row, 7),
        abnormalFlags: getFieldValue(row, 8, 1)
      };
      if (text) observation.text = text;
      return observation;
    })
  };
}

/** Pure mapping from parsed ADT fields to encounter-intake fields. */
export function mapperAdtToEncounterFields(parsed: {
  patientExternalId: string;
  patientName: string;
  birthDate: string;
  clinic?: string;
  ward?: string;
  room?: string;
  bed?: string;
  admissionAt?: string;
}): {
  patientExternalId: string;
  patientName: string;
  birthDate: string;
  ward: string;
  room: string;
  bed: string;
  admissionAt?: string;
} {
  const mapped: {
    patientExternalId: string;
    patientName: string;
    birthDate: string;
    ward: string;
    room: string;
    bed: string;
    admissionAt?: string;
  } = {
    patientExternalId: parsed.patientExternalId,
    patientName: parsed.patientName,
    birthDate: parsed.birthDate,
    ward: parsed.ward || parsed.clinic || '',
    room: parsed.room || '',
    bed: parsed.bed || ''
  };
  if (parsed.admissionAt) mapped.admissionAt = parsed.admissionAt;
  return mapped;
}
