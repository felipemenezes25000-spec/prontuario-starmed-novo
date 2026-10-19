import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as asn1js from 'asn1js';
import { OIDS } from './iti-oids';

/**
 * Carrega o hash da Política de Assinatura (LPA PAdES) do ICP-Brasil para o
 * atributo signature-policy-identifier. Espelha o resolvedor do legado:
 * lê `signPolicyHash` (3º elemento opcional da SEQUENCE raiz da PA); se a PA
 * não trouxer, usa o SHA-256 do próprio arquivo DER.
 * O hash de cada arquivo conferido contra o publicado pelo ITI em
 * `scripts/icp-brasil/fetch-policies.mjs` (sidecar .sha256).
 */
export type PolicyProfile = 'ad-rb' | 'ad-rt';

const PROFILE: Record<PolicyProfile, { oid: string; file: string }> = {
  'ad-rb': { oid: OIDS.PADES_AD_RB, file: 'PA_PAdES_AD_RB_v1_3.der' },
  'ad-rt': { oid: OIDS.PADES_AD_RT, file: 'PA_PAdES_AD_RT_v1_3.der' }
};

export type LoadedPolicy = { oid: string; hash: Buffer };

function readSignPolicyHash(der: Buffer): Buffer | null {
  try {
    const root = asn1js.fromBER(new Uint8Array(der));
    if (!(root.result instanceof asn1js.Sequence)) return null;
    const elements = (root.result as asn1js.Sequence).valueBlock.value;
    if (elements.length < 3) return null;
    const third = elements[2];
    if (!(third instanceof asn1js.OctetString)) return null;
    const value = Buffer.from(third.valueBlock.valueHexView);
    return value.length === 32 ? value : null;
  } catch {
    return null;
  }
}

export function loadPolicy(profile: PolicyProfile, dir?: string): LoadedPolicy {
  const definition = PROFILE[profile];
  const base = dir ?? process.env.ICP_BRASIL_POLICIES_DIR ?? resolve(__dirname, '..', '..', '..', '..', 'certs', 'icp-brasil', 'policies');
  const der = readFileSync(join(base, definition.file));
  const embedded = readSignPolicyHash(der);
  const hash = embedded ?? createHash('sha256').update(der).digest();
  return { oid: definition.oid, hash };
}
