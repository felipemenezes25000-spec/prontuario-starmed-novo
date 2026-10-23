/**
 * Conformidade da prescrição por TIPO de receita (lote 2 do porte do repositório
 * de referência: PrescriptionKind.cs + PrescriptionComplianceValidator.cs).
 *
 * Funções PURAS (sem banco), testáveis. O fluxo HTTP vive em prescriptions.ts.
 *
 * Decisões (ADR-0005):
 *  - Todo tipo exige o prescritor identificado por CRM/UF (CFM). Sem registro
 *    profissional cadastrado e válido, a assinatura é recusada (422) em vez de
 *    emitir documento com "CRM pendente".
 *  - 'antimicrobial' (RDC Anvisa 471/2021): nasce DESLIGADO
 *    (FEATURE_ANTIMICROBIAL_RX). Exige sexo do paciente informado e endereço
 *    profissional do prescritor; validade de 10 dias contados da emissão.
 *  - 'controlled_special' (Portaria SVS/MS 344/1998 + SNCR): SEMPRE recusado
 *    aqui. Receita eletrônica de controle especial depende de integração SNCR
 *    homologada pela Anvisa (BLOCKED_EXTERNAL) — nada é emitido "como se".
 *  - O CPF do paciente NÃO é exigido (o repositório de referência exigia por
 *    política da própria plataforma, não por norma).
 *
 * Nada aqui substitui revisão regulatória: as regras estão versionadas em
 * RX_RULES_VERSION e precisam de parecer antes de uso clínico real.
 */
import { checkCrm } from './br-identifiers';

export const RX_RULES_VERSION = 'rx-kinds-2026-10-23';
export const PRESCRIPTION_KINDS = ['simple', 'antimicrobial', 'controlled_special'] as const;
export type PrescriptionKind = typeof PRESCRIPTION_KINDS[number];

export const KIND_LABEL: Record<PrescriptionKind, string> = {
  simple: 'Receita simples',
  antimicrobial: 'Receita de antimicrobiano (RDC 471/2021)',
  controlled_special: 'Receita de controle especial (Portaria 344/1998)',
};

/** Pura: só liga com valores explícitos ('1'/'true'/'on'/'yes'), como as demais flags. */
export function antimicrobialRxEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ['1', 'true', 'on', 'yes'].includes(String(env.FEATURE_ANTIMICROBIAL_RX || '').toLowerCase().trim());
}

export type KindAvailability = { kind: PrescriptionKind; label: string; enabled: boolean; reason: string | null };

export function kindAvailability(env: Record<string, string | undefined> = process.env): KindAvailability[] {
  return PRESCRIPTION_KINDS.map(kind => {
    const reason = kindBlockReason(kind, env);
    return { kind, label: KIND_LABEL[kind], enabled: reason === null, reason };
  });
}

/** null = tipo liberado; string = motivo honesto da recusa (409 na API). */
export function kindBlockReason(kind: PrescriptionKind, env: Record<string, string | undefined> = process.env): string | null {
  if (kind === 'simple') return null;
  if (kind === 'antimicrobial') {
    return antimicrobialRxEnabled(env) ? null
      : 'Receita de antimicrobiano desligada neste ambiente (FEATURE_ANTIMICROBIAL_RX ausente — aguarda revisão regulatória)';
  }
  return 'Receita de controle especial exige integração SNCR homologada pela Anvisa (pendência externa): nada é emitido sem ela';
}

export type PrescriberRegistration = {
  councilNumber: string;
  councilState: string;
  rqe?: string | null;
  specialty?: string | null;
  professionalAddress?: string | null;
  professionalPhone?: string | null;
};

export type ComplianceInput = {
  kind: PrescriptionKind;
  patient: { administrativeGender: string | null; birthDate: string | null };
  registration: PrescriberRegistration | null;
};

export type MissingField = { field: string; message: string };

export function complianceMissing(input: ComplianceInput): MissingField[] {
  const missing: MissingField[] = [];
  const reg = input.registration;
  if (!reg) {
    missing.push({ field: 'prescritor.crm', message: 'Prescritor sem registro profissional (CRM/UF) cadastrado.' });
  } else if (!checkCrm(reg.councilNumber, reg.councilState).ok) {
    missing.push({ field: 'prescritor.crm', message: 'Registro profissional (CRM/UF) do prescritor é inválido.' });
  }
  if (!input.patient.birthDate)
    missing.push({ field: 'paciente.data_nascimento', message: 'Data de nascimento do paciente é obrigatória.' });
  if (input.kind === 'antimicrobial') {
    const g = input.patient.administrativeGender;
    if (!g || g === 'unknown')
      missing.push({ field: 'paciente.sexo', message: 'Sexo do paciente é obrigatório na receita de antimicrobiano (RDC 471/2021).' });
    if (!reg?.professionalAddress)
      missing.push({ field: 'prescritor.endereco', message: 'Endereço profissional do prescritor é obrigatório na receita de antimicrobiano (RDC 471/2021).' });
  }
  return missing;
}

/** Data civil (AAAA-MM-DD) no fuso de Brasília: a validade conta em dias de
 *  calendário locais, não em UTC (erro clássico das ~21h–24h). */
export function brazilDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export const ANTIMICROBIAL_VALIDITY_DAYS = 10;

/** Último dia de validade, contando o dia da emissão como o 1º dos 10 (leitura
 *  conservadora de "10 dias a contar da emissão"; ver ADR-0005). null = o tipo
 *  não tem validade regulatória fixa tratada aqui. */
export function validUntil(kind: PrescriptionKind, signedAt: Date): string | null {
  if (kind !== 'antimicrobial') return null;
  const [y, m, d] = brazilDate(signedAt).split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1, d + ANTIMICROBIAL_VALIDITY_DAYS - 1));
  return last.toISOString().slice(0, 10);
}

/** Idade em anos completos na data de referência (impressa na receita de antimicrobiano). */
export function ageInYears(birthDate: string, at: Date): number {
  const [by, bm, bd] = birthDate.slice(0, 10).split('-').map(Number);
  const [y, m, d] = brazilDate(at).split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

export function brDate(iso: string): string {
  return iso.slice(0, 10).split('-').reverse().join('/');
}

export function formatPhone(digits: string | null | undefined): string {
  const d = String(digits ?? '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}
