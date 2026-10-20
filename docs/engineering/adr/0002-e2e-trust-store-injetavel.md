# ADR-0002 — E2E Playwright com trust store INJETÁVEL (fixture PAdES positiva de teste)

**Data:** 21/10/2026 · **Status:** Aceito · **Decisor:** engenharia
**Contexto:** o aceite C1 pedia "assinatura PAdES POSITIVA" — mas a cadeia fechada do
repositório só aceita raízes ICP-Brasil reais (`certs/icp-brasil/roots`), e o
certificado ICP real + validação no `validar.iti.gov.br` são **pendência externa**
(sessão humana/homologação). Sem isso, o caminho positivo do endpoint
`POST /prescriptions/:id/sign-pades` nunca era exercitado de ponta a ponta — só o
negativo (J1 #8, certificado fora do trust store).

## Decisão

Usar o parâmetro **já existente** `ICP_BRASIL_TRUST_STORE` (`pki/trust-store.ts`) como
ponto de injeção: as jornadas E2E sobem a API com esse env apontando para um diretório
`.e2e/trust/` contendo **apenas a raiz de uma CA de teste gerada na preparação do run**
(`scripts/e2e/gen-e2e-ca.ts`, a partir do mesmo `test-pki.ts` da suíte unitária).

- O positivo E2E vale para **banco descartável** (guard `STARMED_TEST_DB=true`).
- A chave da CA de teste vive em `.e2e/` (**gitignorado**) — política do repo de não
  comitar chave privada preserva.
- J1 #8 (negativo) continua coberto: a raiz rogue **não** está em `.e2e/trust` → 400.
- O caminho com **certificado ICP real** continua **EXTERNO/BLOQUEADO** — este ADR
  não homologa nada; a declaração "não apto a uso clínico real" permanece.

## Consequências

- CI ganha o job `E2E — Playwright (3 jornadas)` (runner `scripts/e2e/run-e2e.mjs`).
- O job E2E roda a API como dono (não exercita RLS — isolamento é do job `api` + drill
  cross-tenant; registrado no comentário do workflow).
- `TrustStore.cached` é por processo: o env precisa estar presente **antes** do
  primeiro `sign-pades` — o runner garante (env na subida da API).
