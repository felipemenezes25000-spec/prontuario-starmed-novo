/**
 * Termos de medicamento: nome comercial → princípio ativo e guardas regulatórias
 * por substância (lote 3 do porte do repositório de referência —
 * DrugSynonymDatabase.cs; dados em ./data/drug-terms.json com procedência).
 *
 * Usos, todos CONSERVADORES:
 *  - alergia e duplicidade passam a casar pelo princípio ativo ("Novalgina" ×
 *    alergia a "dipirona"; "Rivotril" × "clonazepam"): só ACRESCENTA alertas;
 *  - substância sujeita a controle especial (Portaria 344/98) não sai em
 *    receita simples nem de antimicrobiano; antimicrobiano conhecido não sai em
 *    receita simples. Erro na lista só pode BLOQUEAR a mais, nunca liberar.
 *
 * Não classifica a lista (A/B/C) da Portaria 344, não traz dose, interação
 * nem contraindicação: isso exige base farmacológica licenciada (ADR-0003).
 */
import terms from './data/drug-terms.json';

export const DRUG_TERMS_VERSION: string = terms._meta.version;

/** Caixa, acentos e pontuação fora (mantém '+' das associações). */
export function normalizeDrugText(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9+ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const SYNONYMS = new Map<string, string>(Object.entries(terms.synonyms as Record<string, string>));
const CONTROLLED = new Set<string>(terms.controlledSubstances);
const ANTIMICROBIALS = new Set<string>(terms.antimicrobials);

/** Princípio ativo canônico de um nome livre ("Rivotril 2 mg comprimido" →
 *  "clonazepam"): tenta o nome inteiro, depois cada palavra e pares de palavras
 *  ("acido valproico"). null = desconhecido (não é "sem princípio ativo"). */
export function canonicalDrug(name: string): string | null {
  const n = normalizeDrugText(name);
  if (!n) return null;
  const hit = SYNONYMS.get(n) ?? (CONTROLLED.has(n) || ANTIMICROBIALS.has(n) ? n : undefined);
  if (hit) return hit;
  const words = n.split(' ');
  for (let i = 0; i < words.length; i++) {
    for (const cand of [words.slice(i, i + 2).join(' '), words[i]]) {
      const c = SYNONYMS.get(cand) ?? (CONTROLLED.has(cand) || ANTIMICROBIALS.has(cand) ? cand : undefined);
      if (c) return c;
    }
  }
  return null;
}

/** Mesmo princípio ativo conhecido nos dois nomes. Desconhecido nunca casa. */
export function sameActiveIngredient(a: string, b: string): boolean {
  const ca = canonicalDrug(a);
  return ca !== null && ca === canonicalDrug(b);
}

export type SubstanceClass = { substance: string; regulatedAs: 'controlled_special' | 'antimicrobial' } | null;

export function regulatedSubstance(name: string): SubstanceClass {
  const c = canonicalDrug(name);
  if (!c) return null;
  if (CONTROLLED.has(c)) return { substance: c, regulatedAs: 'controlled_special' };
  if (ANTIMICROBIALS.has(c)) return { substance: c, regulatedAs: 'antimicrobial' };
  return null;
}

/** null = o tipo de receita escolhido é compatível com a substância (até onde a
 *  lista conhece); string = motivo da recusa. */
export function kindSubstanceConflict(kind: 'simple' | 'antimicrobial' | 'controlled_special', medicationName: string): string | null {
  const reg = regulatedSubstance(medicationName);
  if (!reg) return null;
  if (reg.regulatedAs === 'controlled_special' && kind !== 'controlled_special')
    return `"${reg.substance}" é substância sujeita a controle especial (Portaria SVS/MS 344/1998): exige receita de controle especial, não ${kind === 'simple' ? 'receita simples' : 'receita de antimicrobiano'}.`;
  if (reg.regulatedAs === 'antimicrobial' && kind === 'simple')
    return `"${reg.substance}" é antimicrobiano (RDC Anvisa 471/2021): exige receita de antimicrobiano com retenção, não receita simples.`;
  return null;
}
