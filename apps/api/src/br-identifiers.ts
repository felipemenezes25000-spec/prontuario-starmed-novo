/**
 * Identificadores brasileiros: CPF, CNS (Cartão Nacional de Saúde), CNPJ e CRM.
 *
 * Portado do repositório de referência (RenoveJá+: `frontend-mobile/lib/validation/
 * {cpf,cns}.ts`, `CrmValidator.cs`, `CnpjValidator.cs`) com as mesmas regras, para
 * que o dígito verificador seja conferido aqui antes de gravar ou de gastar uma
 * consulta externa (RNDS/CADSUS/Anvisa).
 *
 * O que estas funções NÃO fazem: provar que o documento pertence à pessoa, nem
 * que o CRM está ativo no conselho. Dígito verificador correto só descarta erro
 * de digitação; identidade continua exigindo conferência humana (FL-01).
 */

const onlyDigits = (v: unknown): string => String(v ?? '').replace(/\D/g, '');
const allSame = (d: string): boolean => d.length > 0 && /^(\d)\1*$/.test(d);

export function normalizeCpf(v: unknown): string { return onlyDigits(v); }
export function normalizeCns(v: unknown): string { return onlyDigits(v); }

export function isValidCpf(v: unknown): boolean {
  const d = onlyDigits(v);
  if (d.length !== 11 || allSame(d)) return false;
  const dv = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/** 15 dígitos; começa com 1/2 (definitivo) ou 7/8/9 (provisório); soma ponderada
 *  (pesos 15..1) múltipla de 11 — regra do CNS usada pelo DATASUS. */
export function isValidCns(v: unknown): boolean {
  const d = onlyDigits(v);
  if (d.length !== 15 || !'12789'.includes(d[0])) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += Number(d[i]) * (15 - i);
  return sum % 11 === 0;
}

export function isValidCnpj(v: unknown): boolean {
  const d = onlyDigits(v);
  if (d.length !== 14 || allSame(d)) return false;
  const calc = (len: number, weights: number[]): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i];
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return calc(12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[12])
    && calc(13, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[13]);
}

export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'] as const;

export type CrmCheck =
  | { ok: true; number: string; state: string }
  | { ok: false; error: string };

/** CRM não tem dígito verificador nacional: valida formato (3–7 dígitos, sem
 *  sequência uniforme) e UF entre as 27. Aceita "CRM/SP 123.456". */
export function checkCrm(number: unknown, state: unknown): CrmCheck {
  const uf = String(state ?? '').trim().toUpperCase();
  if (!(UFS as readonly string[]).includes(uf)) return { ok: false, error: 'UF do CRM inválida' };
  const d = onlyDigits(number);
  if (d.length < 3 || d.length > 7) return { ok: false, error: 'CRM deve ter de 3 a 7 dígitos' };
  if (allSame(d)) return { ok: false, error: 'CRM em sequência uniforme não é aceito' };
  return { ok: true, number: d, state: uf };
}

/** Exibição conservadora (convenção brasileira): só os dois últimos dígitos. */
export function maskCpf(v: unknown): string | null {
  const d = onlyDigits(v);
  return d.length === 11 ? `***.***.***-${d.slice(-2)}` : null;
}

export function formatCpf(v: unknown): string {
  const d = onlyDigits(v).slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}

export function formatCns(v: unknown): string {
  const d = onlyDigits(v).slice(0, 15);
  return [d.slice(0, 3), d.slice(3, 7), d.slice(7, 11), d.slice(11)].filter(Boolean).join(' ');
}

/** Campo único de busca: 11 dígitos válidos → CPF; 15 válidos → CNS; senão null
 *  (a busca por documento não dispara com número incompleto ou inválido). */
export function identifyDocument(v: unknown): { kind: 'cpf' | 'cns'; value: string } | null {
  const d = onlyDigits(v);
  if (d.length === 15 && isValidCns(d)) return { kind: 'cns', value: d };
  if (d.length === 11 && isValidCpf(d)) return { kind: 'cpf', value: d };
  return null;
}

/** NamingSystems da RNDS para CPF e CNS (guia FHIR do Ministério da Saúde). */
export const FHIR_SYSTEM_CPF = 'http://rnds.saude.gov.br/fhir/r4/NamingSystem/cpf';
export const FHIR_SYSTEM_CNS = 'http://rnds.saude.gov.br/fhir/r4/NamingSystem/cns';

export function fhirPatientIdentifiers(p: { external_id?: string | null; cpf?: string | null; cns?: string | null }) {
  const out: { system: string; value: string }[] = [];
  if (p.cpf) out.push({ system: FHIR_SYSTEM_CPF, value: p.cpf });
  if (p.cns) out.push({ system: FHIR_SYSTEM_CNS, value: p.cns });
  if (p.external_id) out.push({ system: 'urn:starmed:external-id', value: p.external_id });
  return out;
}
