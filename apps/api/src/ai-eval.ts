/**
 * Avaliação da extração clínica de IA — FUNÇÕES PURAS (ST-P1-013/Fase 8).
 *
 * O avaliador NÃO chama modelo: pontua QUALQUER predição contra o dataset
 * sintético (scripts/ai/dataset/cases.json). A execução com modelo real exige
 * credencial do provedor (LLM_API_URL/LLM_API_KEY + org.ai_enabled) — pendência
 * EXTERNA; a revisão dos resultados é humana (liderança clínica nomeada).
 * Sem PHI por construção: o dataset é 100% fictício e os scores só carregam
 * conjuntos de códigos/tokens normalizados.
 */

export type Golden = {
  cid10: string[];
  medications: string[];
  complaintTokens: string[];
  examinationPresent: boolean;
};
export type DatasetCase = { id: string; transcript: string; golden: Golden };
export type Prediction = { cid10?: string[]; medications?: string[]; complaint?: string; examination?: string | null };

export type FieldScore = { precision: number; recall: number; f1: number };
export type CaseScore = { id: string; cid10: FieldScore; medications: FieldScore; complaint: FieldScore; examination: number };

const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** Normalização compartilhada com o produto (sem acento, minúsculas, espaço duplo). */
export const normalizeText = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const f1 = (p: number, r: number): number => (p + r === 0 ? 0 : round4((2 * p * r) / (p + r)));

/**
 * Métrica de conjunto (códigos CID-10 e medicamentos):
 * - ouro e predição vazios →1,1,1 (acerto de ausência);
 * - ouro vazio e predição com itens → precisão0 (falso positivo pune);
 * - matching de medicamento por normalização + correspondência PARCIAL
 *   (substring bidirecional) — "losartana50" casa com "losartana".
 */
export function setScores(predicted: string[], golden: string[]): FieldScore {
  const p = predicted.map(normalizeText).filter(Boolean);
  const g = golden.map(normalizeText).filter(Boolean);
  if (!g.length && !p.length) return { precision: 1, recall: 1, f1: 1 };
  if (!g.length) return { precision: 0, recall: 0, f1: 0 };
  if (!p.length) return { precision: 0, recall: 0, f1: 0 };
  let matched = 0;
  const usedG = new Set<number>();
  for (const pi of p) {
    const gi = g.findIndex((gg, i) => !usedG.has(i) && (gg === pi || gg.includes(pi) || pi.includes(gg)));
    if (gi >= 0) { matched += 1; usedG.add(gi); }
  }
  const precision = round4(matched / p.length);
  const recall = round4(matched / g.length);
  return { precision, recall, f1: f1(precision, recall) };
}

/** Sobreposição de tokens entre a queixa prevista e os tokens dourados.
 *  recall = cobertura dos tokens dourados; precisão = fraction dos tokens
 *  preditos que são relevantes (punir texto vago que não fala da queixa). */
export function tokenScores(complaint: string | undefined, goldenTokens: string[]): FieldScore {
  const predicted = new Set(normalizeText(complaint ?? '').split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const g = [...new Set(goldenTokens.map(normalizeText).filter(Boolean))];
  if (!g.length && predicted.size === 0) return { precision: 1, recall: 1, f1: 1 };
  if (!g.length || predicted.size === 0) return { precision: 0, recall: 0, f1: 0 };
  const isRelevant = (tok: string) => g.some((gg) => gg === tok || (gg.length > 4 && tok.includes(gg)) || (tok.length > 4 && gg.includes(tok)));
  const matched = g.filter((t) => [...predicted].some((tok) => isRelevantExact(t, tok))).length;
  const relevantPredicted = [...predicted].filter(isRelevant).length;
  const precision = round4(relevantPredicted / predicted.size);
  const recall = round4(matched / g.length);
  return { precision, recall, f1: f1(precision, recall) };
}

function isRelevantExact(golden: string, token: string): boolean {
  return golden === token || (golden.length > 4 && token.includes(golden)) || (token.length > 4 && golden.includes(token));
}

/** Presença/ausência do exame físico (acerto binário →0 ou1). */
export function examinationScore(pred: string | undefined | null, expected: boolean): number {
  const present = typeof pred === 'string' && pred.trim().length >= 5;
  return present === expected ? 1 : 0;
}

export function scoreCase(id: string, predicted: Prediction, golden: Golden): CaseScore {
  return {
    id,
    cid10: setScores(predicted.cid10 ?? [], golden.cid10),
    medications: setScores(predicted.medications ?? [], golden.medications),
    complaint: tokenScores(predicted.complaint, golden.complaintTokens),
    examination: examinationScore(predicted.examination, golden.examinationPresent)
  };
}

/** Sanidade do scorer: o GOLDEN convertido para predição deve pontuar1.0. */
export function goldenToPrediction(g: Golden): Prediction {
  return {
    cid10: g.cid10,
    medications: g.medications,
    complaint: g.complaintTokens.join(' '),
    examination: g.examinationPresent ? 'exame fictício realizado' : null
  };
}

/** Média macro dos casos (cada campo) — o número que a liderança clínica revisa. */
export function summarizeScores(scores: CaseScore[]): {
  cases: number; cid10: FieldScore; medications: FieldScore; complaint: FieldScore; examination: number; macroF1: number;
} {
  const n = Math.max(1, scores.length);
  const avg = (sel: (s: CaseScore) => FieldScore): FieldScore => ({
    precision: round4(scores.reduce((a, s) => a + sel(s).precision, 0) / n),
    recall: round4(scores.reduce((a, s) => a + sel(s).recall, 0) / n),
    f1: round4(scores.reduce((a, s) => a + sel(s).f1, 0) / n)
  });
  const cid10 = avg((s) => s.cid10);
  const medications = avg((s) => s.medications);
  const complaint = avg((s) => s.complaint);
  const examination = round4(scores.reduce((a, s) => a + s.examination, 0) / n);
  return {
    cases: scores.length,
    cid10,
    medications,
    complaint,
    examination,
    macroF1: round4((cid10.f1 + medications.f1 + complaint.f1 + examination) / 4)
  };
}
