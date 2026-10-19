#!/usr/bin/env node
/**
 * Executa gitleaks no histórico e transforma o relatório em uma lista sanitizada
 * para triagem humana. O artefato NÃO preserva o valor do segredo.
 *
 * Decisões humanas ficam em security/secret-history-review.json, por fingerprint.
 * Exit 0 = limpo ou todos os achados classificados como resolvidos.
 * Exit 2 = há achados sem revisão ou marcados needs-rotation.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(root, 'artifacts', 'security');
mkdirSync(outDir, { recursive: true });
const rawPath = join(outDir, '.gitleaks-history-raw.json');
const outputPath = join(outDir, 'secret-history-triage.json');
const reviewPath = join(root, 'security', 'secret-history-review.json');
const allowedStatuses = new Set(['false-positive', 'public-client-config', 'rotated', 'revoked', 'needs-rotation']);
const resolvedStatuses = new Set(['false-positive', 'public-client-config', 'rotated', 'revoked']);

function loadReviewLedger() {
  if (!existsSync(reviewPath)) return new Map();
  const parsed = JSON.parse(readFileSync(reviewPath, 'utf8'));
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const map = new Map();
  for (const decision of decisions) {
    const fingerprint = String(decision.fingerprint ?? '').trim();
    const status = String(decision.status ?? '').trim();
    const justification = String(decision.justification ?? '').trim();
    const providerActionReference = String(decision.providerActionReference ?? '').trim();
    if (!fingerprint) throw new Error('secret-history-review.json: decisão sem fingerprint.');
    if (map.has(fingerprint)) throw new Error(`secret-history-review.json: fingerprint duplicado ${fingerprint}.`);
    if (!allowedStatuses.has(status)) throw new Error(`secret-history-review.json: status inválido '${status}' para ${fingerprint}.`);
    if (justification.length < 20) throw new Error(`secret-history-review.json: justificativa curta para ${fingerprint}.`);
    if ((status === 'rotated' || status === 'revoked') && providerActionReference.length < 5)
      throw new Error(`secret-history-review.json: ${status} exige providerActionReference sanitizado para ${fingerprint}.`);
    map.set(fingerprint, { status, justification, providerActionReference: providerActionReference || null });
  }
  return map;
}

let reviewByFingerprint;
try {
  reviewByFingerprint = loadReviewLedger();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(4);
}

const result = spawnSync(
  'gitleaks',
  ['git', '--no-banner', '--redact', '--report-format', 'json', '--report-path', rawPath, '.'],
  { cwd: root, encoding: 'utf8' },
);
if (result.error?.code === 'ENOENT') {
  console.error('gitleaks não encontrado. Instale a versão usada pelo CI antes da triagem.');
  process.exit(127);
}
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (![0, 1].includes(result.status ?? -1)) {
  console.error(result.stderr || `gitleaks terminou com ${result.status}`);
  process.exit(result.status ?? 1);
}

const raw = existsSync(rawPath) ? JSON.parse(readFileSync(rawPath, 'utf8') || '[]') : [];
const knownSynthetic = [/FieldEncryptionServiceTests\.cs$/i, /docs[\\/]security[\\/]pentest-2026-04-28[\\/]/i];
const publicClientConfig = [/google-services\.json$/i, /GoogleService-Info\.plist$/i];

const findings = raw.map((item) => {
  const file = String(item.File ?? item.file ?? '');
  const fingerprint = item.Fingerprint ?? null;
  let reviewHint = 'manual-review-required';
  if (knownSynthetic.some((pattern) => pattern.test(file))) reviewHint = 'likely-synthetic-test-or-pentest';
  else if (publicClientConfig.some((pattern) => pattern.test(file))) reviewHint = 'public-client-config-verify-scope';
  const decision = fingerprint ? reviewByFingerprint.get(String(fingerprint)) : undefined;
  return {
    ruleId: item.RuleID ?? item.RuleId ?? item.ruleID ?? null,
    file,
    startLine: item.StartLine ?? null,
    commit: item.Commit ?? null,
    fingerprint,
    reviewHint,
    reviewStatus: decision?.status ?? 'unreviewed',
    reviewJustification: decision?.justification ?? null,
    providerActionReference: decision?.providerActionReference ?? null,
    resolved: decision ? resolvedStatuses.has(decision.status) : false,
  };
});

const byRule = {};
const byHint = {};
const byStatus = {};
for (const finding of findings) {
  byRule[finding.ruleId ?? 'unknown'] = (byRule[finding.ruleId ?? 'unknown'] ?? 0) + 1;
  byHint[finding.reviewHint] = (byHint[finding.reviewHint] ?? 0) + 1;
  byStatus[finding.reviewStatus] = (byStatus[finding.reviewStatus] ?? 0) + 1;
}
const currentFingerprints = new Set(findings.map((f) => String(f.fingerprint ?? '')).filter(Boolean));
const staleDecisions = [...reviewByFingerprint.keys()].filter((fingerprint) => !currentFingerprints.has(fingerprint));
const unresolved = findings.filter((finding) => !finding.resolved);
const report = {
  generatedAt: new Date().toISOString(),
  gitSha: process.env.GITHUB_SHA || null,
  total: findings.length,
  resolved: findings.length - unresolved.length,
  unresolved: unresolved.length,
  byRule,
  byHint,
  byStatus,
  staleDecisionFingerprints: staleDecisions,
  findings,
  remediation: 'Credencial real: revogar/rotacionar no provedor e registrar referência sanitizada. Falso positivo/config público: justificar por fingerprint. Remover arquivo do Git não revoga segredo.',
  redactionBoundary: 'Nenhum campo Secret/Match foi copiado do relatório bruto ou do ledger de revisão.',
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
rmSync(rawPath, { force: true });
console.log(`Triagem sanitizada: ${findings.length} achado(s), ${unresolved.length} pendente(s).`);
console.log(`Por regra: ${JSON.stringify(byRule)}`);
console.log(`Por status: ${JSON.stringify(byStatus)}`);
console.log(`Saída: ${relative(root, outputPath)}`);
if (staleDecisions.length) console.warn(`Ledger contém ${staleDecisions.length} fingerprint(s) fora da varredura atual; revisar antes de remover.`);
process.exit(unresolved.length ? 2 : 0);
