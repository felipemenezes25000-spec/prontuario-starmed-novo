#!/usr/bin/env node
/**
 * Sorteio REPRODUTÍVEL (semente registrada no pré-registro) da ordem dos sistemas
 * e do conjunto de casos por participante, em blocos de 4 balanceados:
 * cada bloco contém as 4 combinações (ordem AB/BA × conjunto A/B no 1º sistema).
 *
 *   node scripts/estudo/sortear.mjs --n 16 --semente 20261023 --ref StarMed --comp "Sistema Z"
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** mulberry32: PRNG determinístico de 32 bits (mesma semente → mesmo sorteio). */
export function prng(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sortear(n, semente, ref = 'StarMed', comp = 'Comparador') {
  const rnd = prng(semente);
  const combos = [[ref, comp, 'A'], [ref, comp, 'B'], [comp, ref, 'A'], [comp, ref, 'B']];
  const out = [];
  while (out.length < n) {
    const bloco = [...combos];
    for (let i = bloco.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [bloco[i], bloco[j]] = [bloco[j], bloco[i]]; }
    for (const [primeiro, segundo, conj] of bloco) {
      if (out.length >= n) break;
      out.push({ participante: 'P' + String(out.length + 1).padStart(2, '0'), primeiro, segundo,
        conjuntoNoPrimeiro: conj, conjuntoNoSegundo: conj === 'A' ? 'B' : 'A' });
    }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const n = Number(get('--n')), semente = Number(get('--semente'));
  if (!Number.isInteger(n) || n < 4 || !Number.isInteger(semente)) {
    console.error('uso: --n <participantes ≥ 4> --semente <inteiro registrado no pré-registro> [--ref X] [--comp Y]');
    process.exitCode = 1;
  } else {
    console.log('participante,primeiro_sistema,conjunto_no_primeiro,segundo_sistema,conjunto_no_segundo');
    for (const r of sortear(n, semente, get('--ref') ?? 'StarMed', get('--comp') ?? 'Comparador'))
      console.log([r.participante, r.primeiro, r.conjuntoNoPrimeiro, r.segundo, r.conjuntoNoSegundo].join(','));
  }
}
