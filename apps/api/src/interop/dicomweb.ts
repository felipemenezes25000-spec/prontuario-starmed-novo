// StarMed Fase 6 — DICOMweb (ST-P1-010): QIDO-RS com capacidade NASCE DESLIGADA.
//
// Sem DICOMWEB_URL não há um byte na rede; DICOMWEB_SANDBOX='true' opera em
// modo simulado e devolve `matches: []` HONESTO — nada foi encontrado porque
// nada foi consultado (nunca inventamos exame). Consulta real: 1 tentativa,
// timeout 5s, erro propagado como está (sem retry implícito que esconda falha).
export type DicomWebConfig = {
  enabled: boolean;
  /** null quando habilitado; caso contrário o motivo honesto (sem PHI). */
  reason: string | null;
  /** Base DICOMweb (…/dicomweb); null quando desligado. */
  url: string | null;
  /** AE Title da organização (DICOMWEB_AETITLE); metadado, opcional. */
  aetitle: string | null;
  /** DICOMWEB_SANDBOX='true' → respostas sintéticas honestas, ZERO rede. */
  sandbox: boolean;
};

const trim = (value?: string) => (value ?? '').trim();
const isTrue = (value?: string) => trim(value).toLowerCase() === 'true';

/** Pura (env injetável): DICOMweb nasce DESLIGADO sem DICOMWEB_URL. */
export function dicomwebConfigFromEnv(source: Record<string, string | undefined> = process.env): DicomWebConfig {
  const url = trim(source.DICOMWEB_URL).length > 0 ? trim(source.DICOMWEB_URL) : null;
  const aetitle = trim(source.DICOMWEB_AETITLE).length > 0 ? trim(source.DICOMWEB_AETITLE) : null;
  const sandbox = isTrue(source.DICOMWEB_SANDBOX);
  const enabled = sandbox || url !== null;
  return {
    enabled,
    reason: enabled ? null : 'dicom desligado (DICOMWEB_URL ausente)',
    url,
    aetitle,
    sandbox
  };
}

/** Metadados de um estudo QIDO (tags DICOM → chaves legíveis; sem pixel data). */
export type QidoMatch = {
  studyInstanceUID: string | null;
  accessionNumber: string | null;
  modalities: string[];
  studyDate: string | null;
};

type DicomJsonValue = { vr?: string; Value?: unknown[] };
type DicomJsonEntry = Record<string, DicomJsonValue | undefined>;

/** Pura: extrai campos de uma entrada DICOM JSON (QIDO-RS) sem assumptiones. */
export function mapQidoStudy(entry: DicomJsonEntry): QidoMatch {
  const value = (tag: string): unknown => entry[tag]?.Value?.[0];
  const values = (tag: string): unknown[] => entry[tag]?.Value ?? [];
  return {
    studyInstanceUID: typeof value('0020000D') === 'string' ? (value('0020000D') as string) : null,
    accessionNumber: typeof value('00080050') === 'string' ? (value('00080050') as string) : null,
    modalities: values('00080061').filter((m): m is string => typeof m === 'string'),
    studyDate: typeof value('00080020') === 'string' ? (value('00080020') as string) : null
  };
}

export type QidoQuery = { patientId: string; modalities?: string[] | undefined };

export type QidoResult =
  | { status: 'sandbox'; matches: QidoMatch[]; note: string }
  | { status: 'ok'; matches: QidoMatch[] }
  | { status: 'error'; matches: QidoMatch[]; error: string };

/** Monta a URL QIDO-RS de estudos (função pura, testável sem rede). */
export function buildQidoUrl(baseUrl: string, query: QidoQuery): string {
  const url = new URL('studies', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('PatientID', query.patientId);
  for (const modality of query.modalities ?? []) url.searchParams.append('Modalities', modality);
  return url.toString();
}

/**
 * Consulta QIDO-RS real: UMA tentativa, timeout 5s. Nunca lança — devolve
 * {status:'error'} com a causa honesta para o chamador decidir (fila/retry).
 */
export async function qidoSearch(cfg: DicomWebConfig, query: QidoQuery, timeoutMs = 5000): Promise<QidoResult> {
  if (!cfg.enabled || !cfg.url) {
    return { status: 'error', matches: [], error: cfg.reason ?? 'dicom desligado (DICOMWEB_URL ausente)' };
  }
  if (cfg.sandbox) {
    return {
      status: 'sandbox',
      matches: [],
      // Honesty: empty BECAUSE nothing was queried — never a fabricated "exam found".
      note: 'DICOMWEB_SANDBOX=true: nenhuma consulta saiu da máquina; matches vazio é honesto (nada foi consultado, nada foi encontrado).'
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildQidoUrl(cfg.url, query), {
      method: 'GET',
      headers: { Accept: 'application/dicom+json' },
      signal: controller.signal
    });
    if (!response.ok) {
      return { status: 'error', matches: [], error: `DICOMweb respondeu HTTP ${response.status} (1 tentativa, sem retry implícito)` };
    }
    const body: unknown = await response.json();
    const entries = Array.isArray(body) ? (body as DicomJsonEntry[]) : [];
    return { status: 'ok', matches: entries.map(mapQidoStudy) };
  } catch {
    return { status: 'error', matches: [], error: 'falha de rede ou timeout (5s) na consulta QIDO' };
  } finally {
    clearTimeout(timer);
  }
}
