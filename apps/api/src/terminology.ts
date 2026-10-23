/**
 * Terminologia CID-10 (lote 6 do porte do repositório de referência —
 * Cid10Database.cs; dados em ./data/cid10-aps.json com procedência).
 *
 *   GET /terminology/cid10?q=<texto ou código>&limit=  — autocomplete (equipe clínica)
 *
 * É um SUBCONJUNTO de atenção primária: serve para sugerir, nunca para recusar
 * um código válido fora da lista. A regra dura é só o FORMATO do CID-10 quando o
 * sistema informado é o CID-10 da RNDS.
 */
import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import catalog from './data/cid10-aps.json';
import { Actor, requireRole } from './security';

export const CID10_SYSTEM: string = catalog._meta.system;
export const CID10_CATALOG_VERSION: string = catalog._meta.version;
/** Letra + 2 dígitos, subcategoria opcional de 1 dígito (formato usado no SUS). */
export const CID10_PATTERN = /^[A-Z][0-9]{2}(\.[0-9])?$/;

type Cid = { code: string; display: string };
const fold = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const INDEX: Array<Cid & { folded: string }> = (catalog.codes as Cid[]).map(c => ({ ...c, folded: fold(c.display) }));
const BY_CODE = new Map(INDEX.map(c => [c.code, c]));

/** Aceita "e119", "E11.9", " i10 " → forma canônica (ou null se não for CID-10). */
export function normalizeCid10(code: string): string | null {
  const c = code.trim().toUpperCase().replace(/^([A-Z][0-9]{2})([0-9])$/, '$1.$2');
  return CID10_PATTERN.test(c) ? c : null;
}

export function lookupCid10(code: string): Cid | null {
  const n = normalizeCid10(code);
  const hit = n ? BY_CODE.get(n) : undefined;
  return hit ? { code: hit.code, display: hit.display } : null;
}

/** Código como prefixo OU todas as palavras da busca na descrição (sem acento). */
export function searchCid10(q: string, limit = 20): Cid[] {
  const query = fold(q.trim());
  if (query.length < 2) return [];
  const codeQ = query.toUpperCase().replace(/\s+/g, '');
  const words = query.split(/\s+/).filter(Boolean);
  const out: Cid[] = [];
  for (const c of INDEX) {
    if (c.code.replace('.', '').startsWith(codeQ.replace('.', '')) || words.every(w => c.folded.includes(w)))
      out.push({ code: c.code, display: c.display });
    if (out.length >= limit) break;
  }
  return out;
}

@Controller('terminology')
export class TerminologyController {
  @Get('cid10')
  cid10(@Req() req: { actor: Actor }, @Query('q') q = '', @Query('limit') rawLimit?: string) {
    requireRole(req.actor, ['admin', 'doctor', 'nurse']);
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('limit entre 1 e 50');
    return { system: CID10_SYSTEM, catalogVersion: CID10_CATALOG_VERSION, scope: 'subconjunto de atenção primária', items: searchCid10(String(q).slice(0, 80), limit) };
  }
}
