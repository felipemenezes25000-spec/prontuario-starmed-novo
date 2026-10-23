/**
 * Pareamento probabilístico de identidade (MPI) — porte do repositório de
 * referência (StarMedMpiMatcher.cs, regra "starmed-mpi-v1"), restrito aos campos
 * que este sistema tem: nome, nascimento, sexo administrativo, telefone, CPF, CNS.
 *
 * Determinístico primeiro: CPF ou CNS iguais = mesma pessoa; dois CPFs válidos e
 * DIFERENTES = pessoas diferentes (conflito rígido: gêmeos com nome e nascimento
 * quase iguais são exatamente o caso em que o probabilístico erraria).
 * Depois probabilístico: Jaro-Winkler no nome normalizado + pesos da política.
 *
 * Pesos e limiares são os do ref SEM recalibração. Como este cadastro não tem
 * nome da mãe (peso 20 lá), o teto probabilístico aqui é 73 < 80: fora de
 * CPF/CNS iguais, o máximo é "possible" — tudo vai à revisão humana.
 *
 * NUNCA une ninguém: classifica o par para a fila de REVISÃO HUMANA (o merge
 * continua sendo ação explícita em mpi.ts). As "features" levam só o peso de
 * cada característica, nunca o valor comparado (sem PHI na evidência).
 */
export const MPI_RULE_VERSION = 'starmed-mpi-v1-ts';

export type MpiPerson = {
  id: string;
  name: string;
  birthDate: string | null; // AAAA-MM-DD
  sex: string | null;
  phone: string | null;
  cpf: string | null;
  cns: string | null;
};

export const MPI_POLICY = {
  reviewThreshold: 60,
  probableThreshold: 80,
  nameStrong: 35, nameGood: 25, nameWeak: 12, nameMismatch: -10,
  birthExact: 25, birthNear: 10, birthYear: 5, birthMismatch: -20,
  sexMatch: 5, sexMismatch: -15,
  phoneMatch: 8,
} as const;

export type MpiClassification = 'definite' | 'probable' | 'possible' | 'non_match';
export type MpiScore = { score: number; classification: MpiClassification; hardConflict: boolean; features: Record<string, number> };

const PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'd']);
const digits = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '');
const fold = (v: string) => v.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Minúsculo, sem acento e sem partículas ("de", "da"...). */
export function normalizeMpiName(name: string | null | undefined): string {
  return fold(name ?? '').replace(/[^a-z]+/g, ' ').split(' ').filter(t => t && !PARTICLES.has(t)).join(' ');
}

export function jaroWinkler(s1: string, s2: string): number {
  if (!s1.length && !s2.length) return 1;
  if (!s1.length || !s2.length) return 0;
  if (s1 === s2) return 1;
  const range = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array<boolean>(s1.length).fill(false);
  const m2 = new Array<boolean>(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - range), end = Math.min(i + range + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = m2[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0, k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / s1.length + m / s2.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) { if (s1[i] === s2[i]) prefix++; else break; }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Dia/mês trocados ou 1 de diferença no dia ou no mês, no mesmo ano: erro típico de digitação. */
function nearDate(a: string, b: string): boolean {
  const [ay, am, ad] = a.split('-').map(Number), [by, bm, bd] = b.split('-').map(Number);
  if (ay !== by) return false;
  if (ad === bm && am === bd) return true;
  return (am === bm && Math.abs(ad - bd) <= 1) || (ad === bd && Math.abs(am - bm) <= 1);
}

function normSex(s: string | null): 'm' | 'f' | null {
  const v = String(s ?? '').trim().toLowerCase();
  return v === 'male' || v === 'm' || v === 'masculino' ? 'm' : v === 'female' || v === 'f' || v === 'feminino' ? 'f' : null;
}

export function compareIdentity(a: MpiPerson, b: MpiPerson, p = MPI_POLICY): MpiScore {
  const features: Record<string, number> = {};
  const cpfA = digits(a.cpf), cpfB = digits(b.cpf), cnsA = digits(a.cns), cnsB = digits(b.cns);
  if (cpfA.length === 11 && cpfA === cpfB) return { score: 100, classification: 'definite', hardConflict: false, features: { cpf_igual: 100 } };
  if (cnsA.length === 15 && cnsA === cnsB) return { score: 100, classification: 'definite', hardConflict: false, features: { cns_igual: 100 } };
  if (cpfA.length === 11 && cpfB.length === 11) return { score: 0, classification: 'non_match', hardConflict: true, features: { cpf_diferente: 0 } };

  let score = 0;
  const name = jaroWinkler(normalizeMpiName(a.name), normalizeMpiName(b.name));
  features.nome = name >= 0.95 ? p.nameStrong : name >= 0.9 ? p.nameGood : name >= 0.85 ? p.nameWeak : p.nameMismatch;
  score += features.nome;
  if (a.birthDate && b.birthDate) {
    const ba = a.birthDate.slice(0, 10), bb = b.birthDate.slice(0, 10);
    features.nascimento = ba === bb ? p.birthExact : nearDate(ba, bb) ? p.birthNear
      : ba.slice(0, 4) === bb.slice(0, 4) ? p.birthYear : p.birthMismatch;
    score += features.nascimento;
  }
  const sa = normSex(a.sex), sb = normSex(b.sex);
  if (sa && sb) { features.sexo = sa === sb ? p.sexMatch : p.sexMismatch; score += features.sexo; }
  const pa = digits(a.phone);
  if (pa.length >= 8 && pa === digits(b.phone)) { features.telefone = p.phoneMatch; score += p.phoneMatch; }
  score = Math.min(99, Math.max(0, score));
  const classification: MpiClassification = score >= p.probableThreshold ? 'probable' : score >= p.reviewThreshold ? 'possible' : 'non_match';
  return { score, classification, hardConflict: false, features };
}

/** Qualidade do cadastro de identidade (0–100) e o que falta para melhorá-la. */
export function identityQuality(p: MpiPerson): { score: number; missing: string[] } {
  const missing: string[] = [];
  let score = 0;
  if (digits(p.cpf).length === 11) score += 35; else missing.push('CPF');
  if (digits(p.cns).length === 15) score += 30; else missing.push('CNS');
  if (p.birthDate) score += 20; else missing.push('data de nascimento');
  if (normSex(p.sex)) score += 5; else missing.push('sexo');
  if (digits(p.phone).length >= 8) score += 10; else missing.push('telefone');
  return { score, missing };
}
