/**
 * Gera a CA de TESTE das jornadas E2E (fixture PAdES POSITIVA com trust store
 * injetável via ICP_BRASIL_TRUST_STORE — o positivo real com certificado ICP
 * continua EXTERNO, pendente de homologação).
 *
 * Uso: npx tsx scripts/e2e/gen-e2e-ca.ts [.e2e]
 * Saída (TODA em diretório gitignorado — chave privada de teste NUNCA no repo):
 *   <out>/trust/root.pem  → ICP_BRASIL_TRUST_STORE da API do E2E (única raiz)
 *   <out>/ca/root.pem     → cadeia opcional (chainPems)
 *   <out>/ca/leaf.pem     → signerCertPem de POST /prescriptions/:id/sign-pades
 *   <out>/ca/leaf-key.pem → privateKeyPkcs8Pem (PKCS#8 PEM)
 *
 * Dados 100% sintéticos. NÃO usar fora de banco descartável.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeCertificate, pem, pkcs8Pem } from '../../apps/api/src/pki/test-pki';

async function main(): Promise<void> {
  const outDir = resolve(process.argv[2] ?? '.e2e');
  const root = await makeCertificate({ subjectCn: 'StarMed E2E Test Root CA', ca: true, notBeforeDays: -2, notAfterDays: 3650 });
  const leaf = await makeCertificate({ subjectCn: 'Dr E2E Teste CRM 12345/SP', issuer: root, ca: false, notBeforeDays: -1, notAfterDays: 825 });

  mkdirSync(join(outDir, 'trust'), { recursive: true });
  mkdirSync(join(outDir, 'ca'), { recursive: true });
  writeFileSync(join(outDir, 'trust', 'root.pem'), pem(root));
  writeFileSync(join(outDir, 'ca', 'root.pem'), pem(root));
  writeFileSync(join(outDir, 'ca', 'leaf.pem'), pem(leaf));
  writeFileSync(join(outDir, 'ca', 'leaf-key.pem'), await pkcs8Pem(leaf.privateKey));
  console.log(`E2E test CA em ${outDir} (trust: trust/root.pem · signer: ca/leaf.pem)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
