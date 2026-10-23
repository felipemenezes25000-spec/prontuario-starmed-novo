#!/usr/bin/env node
/**
 * Análise do estudo comparativo (docs/estudo/PROTOCOLO_ESTUDO_COMPARATIVO.md §6).
 *
 *   node scripts/estudo/analisar.mjs --tarefas coleta-tarefas.csv --sus coleta-sus.csv
 *        [--referencia StarMed] [--saida relatorio.md]
 *
 * Entrada SEM PHI (participante = código). Saída: relatório Markdown com
 * mediana/IQR por tarefa e sistema, Wilcoxon pareado (exato até n=20) com Holm,
 * McNemar exato para sucesso e segurança e SUS 0–100. Funções puras exportadas
 * para teste (analisar.test.mjs).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------ CSV
export function parseCsv(texto) {
  const linhas = texto.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (!linhas.length) return [];
  const cab = linhas[0].split(',').map(s => s.trim());
  return linhas.slice(1).map(l => {
    const cols = l.split(',');
    return Object.fromEntries(cab.map((c, i) => [c, (cols[i] ?? '').trim()]));
  });
}

// ------------------------------------------------------------ estatística
export function mediana(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function quartis(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = p => {
    if (!s.length) return NaN;
    const pos = (s.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  return { q1: q(0.25), q3: q(0.75) };
}

/** Wilcoxon de postos sinalizados, bilateral. Zeros descartados; empates com posto médio.
 *  Exato por enumeração para n ≤ 20; aproximação normal com correção de empates acima. */
export function wilcoxonPareado(diferencas) {
  const d = diferencas.filter(x => Number.isFinite(x) && x !== 0);
  const n = d.length;
  if (n === 0) return { n: 0, w: 0, p: 1, metodo: 'sem diferenças' };
  const abs = d.map((x, i) => ({ v: Math.abs(x), i })).sort((a, b) => a.v - b.v);
  const postos = new Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && abs[j + 1].v === abs[i].v) j++;
    const medio = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) postos[abs[k].i] = medio;
    i = j + 1;
  }
  const wPos = d.reduce((s, x, i) => s + (x > 0 ? postos[i] : 0), 0);
  const total = n * (n + 1) / 2;
  const w = Math.min(wPos, total - wPos);
  if (n <= 20) {
    // Distribuição exata de W+ sob H0 enumerando os sinais sobre os postos (com empates).
    let menorOuIgual = 0;
    const casos = 2 ** n;
    for (let mask = 0; mask < casos; mask++) {
      let s = 0;
      for (let k = 0; k < n; k++) if (mask & (1 << k)) s += postos[k];
      if (Math.min(s, total - s) <= w + 1e-9) menorOuIgual++;
    }
    return { n, w, p: Math.min(1, menorOuIgual / casos), metodo: 'exato' };
  }
  const empates = {};
  for (const r of postos) empates[r] = (empates[r] ?? 0) + 1;
  const corr = Object.values(empates).reduce((s, t) => s + (t ** 3 - t), 0) / 48;
  const media = total / 2;
  const dp = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24 - corr);
  const z = (Math.abs(wPos - media) - 0.5) / dp;
  return { n, w, p: Math.min(1, 2 * (1 - phi(z))), metodo: 'normal' };
}
function phi(z) { // CDF normal padrão (Abramowitz-Stegun 7.1.26)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** McNemar exato (binomial bilateral) sobre pares discordantes b (só ref) e c (só comparador). */
export function mcnemarExato(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let cauda = 0;
  for (let i = 0; i <= k; i++) cauda += binom(n, i);
  return Math.min(1, 2 * cauda / 2 ** n);
}
function binom(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }

/** Holm-Bonferroni: devolve p ajustados na mesma ordem. */
export function holm(ps) {
  const ord = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array(ps.length);
  let max = 0;
  ord.forEach((o, k) => { max = Math.max(max, Math.min(1, (ps.length - k) * o.p)); out[o.i] = max; });
  return out;
}

/** SUS: ímpares (q-1), pares (5-q), soma × 2,5. Respostas 1..5 obrigatórias. */
export function escoreSus(respostas) {
  if (respostas.length !== 10 || respostas.some(r => !(r >= 1 && r <= 5))) throw new Error('SUS exige 10 respostas de 1 a 5');
  return respostas.reduce((s, r, i) => s + (i % 2 === 0 ? r - 1 : 5 - r), 0) * 2.5;
}

// --------------------------------------------------------------- análise
const sim = v => /^(1|s|sim|true|y|yes)$/i.test(String(v).trim());

export function analisar(tarefas, sus, referencia = 'StarMed') {
  const sistemas = [...new Set(tarefas.map(r => r.sistema))];
  const comparadores = sistemas.filter(s => s !== referencia);
  const ids = [...new Set(tarefas.map(r => r.tarefa))].sort();
  const linhas = [];
  for (const comp of comparadores) {
    const resultados = ids.map(t => {
      const ref = new Map(tarefas.filter(r => r.tarefa === t && r.sistema === referencia).map(r => [r.participante, r]));
      const cmp = new Map(tarefas.filter(r => r.tarefa === t && r.sistema === comp).map(r => [r.participante, r]));
      const pares = [...ref.keys()].filter(p => cmp.has(p)).map(p => [ref.get(p), cmp.get(p)]);
      const tRef = pares.map(([a]) => Number(a.tempo_s)), tCmp = pares.map(([, b]) => Number(b.tempo_s));
      const wil = wilcoxonPareado(pares.map(([a, b]) => Number(a.tempo_s) - Number(b.tempo_s)));
      const disc = campo => {
        let b = 0, c = 0;
        for (const [a, x] of pares) { const ra = sim(a[campo]), rx = sim(x[campo]); if (ra && !rx) b++; if (!ra && rx) c++; }
        return { b, c, p: mcnemarExato(b, c) };
      };
      return { t, n: pares.length, tRef, tCmp, wil, sucesso: disc('sucesso'), seguranca: disc('erro_seguranca_evitado') };
    });
    const pAj = holm(resultados.map(r => r.wil.p));
    resultados.forEach((r, i) => { r.pHolm = pAj[i]; });
    const susPar = participantes => participantes.map(p => {
      const a = sus.find(s => s.participante === p && s.sistema === referencia);
      const b = sus.find(s => s.participante === p && s.sistema === comp);
      if (!a || !b) return null;
      const q = row => Array.from({ length: 10 }, (_, i) => Number(row['q' + (i + 1)]));
      return [escoreSus(q(a)), escoreSus(q(b))];
    }).filter(Boolean);
    const sp = susPar([...new Set(sus.map(s => s.participante))]);
    linhas.push({ comp, resultados, sus: { n: sp.length, ref: sp.map(x => x[0]), cmp: sp.map(x => x[1]), wil: wilcoxonPareado(sp.map(([a, b]) => a - b)) } });
  }
  return { referencia, comparadores, linhas };
}

const f = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';
const fp = p => p < 0.001 ? '< 0,001' : p.toFixed(3).replace('.', ',');

export function relatorio(res) {
  const out = [`# Relatório do estudo comparativo`, '', `Referência: **${res.referencia}**. Tempos em segundos; mediana [Q1–Q3]. Wilcoxon pareado sobre (referência − comparador): negativo = referência mais rápida. Sem PHI.`, ''];
  for (const l of res.linhas) {
    out.push(`## ${res.referencia} × ${l.comp}`, '', '| Tarefa | n | ' + res.referencia + ' | ' + l.comp + ' | Δ mediana | p (Holm) | Sucesso b/c (p) | Erro de segurança evitado b/c (p) |', '|---|---|---|---|---|---|---|---|');
    for (const r of l.resultados) {
      const qa = quartis(r.tRef), qb = quartis(r.tCmp);
      const delta = mediana(r.tRef.map((x, i) => x - r.tCmp[i]));
      out.push(`| ${r.t} | ${r.n} | ${f(mediana(r.tRef))} [${f(qa.q1)}–${f(qa.q3)}] | ${f(mediana(r.tCmp))} [${f(qb.q1)}–${f(qb.q3)}] | ${f(delta)} | ${fp(r.pHolm)} | ${r.sucesso.b}/${r.sucesso.c} (${fp(r.sucesso.p)}) | ${r.seguranca.b}/${r.seguranca.c} (${fp(r.seguranca.p)}) |`);
    }
    out.push('', `SUS (n=${l.sus.n}): ${res.referencia} mediana ${f(mediana(l.sus.ref))} × ${l.comp} ${f(mediana(l.sus.cmp))}; Wilcoxon p = ${fp(l.sus.wil.p)} (${l.sus.wil.metodo}).`, '',
      '_b = só a referência acertou/evitou; c = só o comparador. Amostra pequena e casos sintéticos limitam a generalização; não é desfecho clínico._', '');
  }
  return out.join('\n');
}

// ------------------------------------------------------------------- CLI
function main(argv) {
  const opt = { referencia: 'StarMed' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tarefas') opt.tarefas = argv[++i];
    else if (a === '--sus') opt.sus = argv[++i];
    else if (a === '--referencia') opt.referencia = argv[++i];
    else if (a === '--saida') opt.saida = argv[++i];
    else throw new Error('opção desconhecida: ' + a);
  }
  if (!opt.tarefas || !opt.sus) throw new Error('uso: --tarefas <csv> --sus <csv> [--referencia StarMed] [--saida relatorio.md]');
  const md = relatorio(analisar(parseCsv(readFileSync(resolve(opt.tarefas), 'utf8')), parseCsv(readFileSync(resolve(opt.sus), 'utf8')), opt.referencia));
  if (opt.saida) writeFileSync(resolve(opt.saida), md + '\n'); else console.log(md);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
