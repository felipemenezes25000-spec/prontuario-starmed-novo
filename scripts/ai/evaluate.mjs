#!/usr/bin/env node
/**
 * Avaliador da extração clínica de IA — Fase 8 (ST-P1-013).
 *
 * Pontua PREDIÇÕES contra o dataset sintético (scripts/ai/dataset/cases.json)
 * usando as funções puras de apps/api/src/ai-eval.ts (import .ts ⇒ rode com
 * `npx tsx scripts/ai/evaluate.mjs …`). NÃO chama modelo:
 *   --self-check    pontua o próprio dataset contra ele (sanidade: tudo1.0)
 *   --predictions F arquivo JSON [{id, predicted:{cid10[],medications[],complaint,examination}}]
 * Sem modelo e sem predições o script explica HONESTAMENTE o que falta
 * (credencial do provedor LLM + revisão humana) e sai com código2.
 * Dados 100% sintéticos — sem PHI possível.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const datasetPath = resolve('scripts/ai/dataset/cases.json');
const evaluatorModule = resolve('apps/api/src/ai-eval.ts');

async function loadEvaluator() {
  const mod = await import(pathToFileURL(evaluatorModule).href);
  return mod;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const main = async () => {
  const { scoreCase, summarizeScores, goldenToPrediction } = await loadEvaluator();
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
  if (!Array.isArray(dataset) || !dataset.length) throw new Error('Dataset vazio ou inválido');

  const selfCheck = process.argv.includes('--self-check');
  const predictionsPath = arg('--predictions');
  let pairs;
  if (selfCheck) {
    console.log('[avaliação-ia] self-check: dataset × dataset (sanidade do scorer)');
    pairs = dataset.map((c) => ({ id: c.id, predicted: goldenToPrediction(c.golden), golden: c.golden }));
  } else if (predictionsPath) {
    const preds = JSON.parse(readFileSync(resolve(predictionsPath), 'utf8'));
    pairs = dataset.map((c) => {
      const hit = preds.find((p) => p.id === c.id);
      if (!hit) throw new Error(`Predição ausente para o caso ${c.id}`);
      return { id: c.id, predicted: hit.predicted ?? {}, golden: c.golden };
    });
  } else {
    console.error(
      '[avaliação-ia] Sem predições. Este avaliador pontua saídas já geradas.\n' +
      '  • Para sanidade do scorer:        node scripts/ai/evaluate.mjs --self-check\n' +
      '  • Para avaliar um modelo real:    exporte LLM_API_URL/LLM_API_KEY + LLM_MODEL,\n' +
      '    ative a organização (ai_enabled) e gere as predições via POST /ai/extract,\n' +
      '    exportando-as para um JSON e passando --predictions <arquivo>.\n' +
      '  Pendências EXTERNAS: credencial do provedor + revisão humana (liderança clínica).'
    );
    process.exit(2);
  }

  const scores = pairs.map((p) => scoreCase(p.id, p.predicted, p.golden));
  const summary = summarizeScores(scores);
  for (const s of scores) {
    console.log(`  ${s.id}: cid10 f1=${s.cid10.f1} · medicamentos f1=${s.medications.f1} · queixa f1=${s.complaint.f1} · exame=${s.examination}`);
  }
  console.log('==== Resumo (dataset sintético; revisar com a liderança clínica) ====');
  console.log(JSON.stringify(summary, null, 2));
  if (selfCheck && summary.macroF1 !== 1) {
    console.error('SELF-CHECK FALHOU: scorer não devolve1.0 para o próprio dataset');
    process.exit(1);
  }
  console.log(selfCheck ? 'SELF-CHECK OK (scorer íntegro)' : 'Avaliação concluída');
};

main().catch((e) => { console.error('[avaliação-ia] erro:', e?.message ?? e); process.exit(1); });
