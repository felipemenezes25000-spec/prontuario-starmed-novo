# MATRIZ DE TESTES — StarMed (requisito → caso → evidência)

**Atualizado:** 21/10/2026 · **Base:** `main` (marco Fase 1 — qualidade e testes)
**Regra desta matriz:** nada é "concluído" sem execução. "Evidência" = comando
executado + resultado observado (local ou run ID do GitHub Actions). Dados são
**100% sintéticos** em todos os casos.

**Legenda de status:** `EXECUTADO` (execução observada) · `PENDENTE` (implementado,
aguardando execução) · `BLOQUEADO EXTERNO` (depende de credencial/homologação/sessão
humana).

## 1. Suítes unitárias/de domínio (`npm test` — `apps/api`)

Runner: `tsx --test` sobre os arquivos abaixo. Última execução local: **115/115
verdes** (21/10/2026); histórico de CI: ver `docs/engineering/EXECUCAO_2026-10-20.md` §0.

| Arquivo | Requisito coberto | Caso (dados sintéticos) | Esperado | Evidência |
|---|---|---|---|---|
| `domain.test.ts` | Notas imutáveis, schemas | draft/adendo inválidos (`operationId` não-uuid, versão negativa) | rejeição no domínio | 115/115 local |
| `auth-mfa.test.ts` | MFA RFC 4226/6238/4648 | vetores TOTP/base32 oficiais, janela de drift | códigos corretos aceitos, fora de janela não | idem |
| `pki/pki.test.ts` | Trust store, cadeia, PAdES/CMS, ACT, embarque | raízes ICP por fingerprint; rogue root; expirado com `at` injetável; round-trip CMS; adulteração; ByteRange; **regressão do flaky (PEM sem linha vazia, serial mínimo)** | 30 execuções consecutivas sem falha | **0/30 falhas** (21/10) + fuzz 0/1000 |
| `signature.test.ts` | Qualificação tri-estado, OIDs ITI | `qualifySignature` true/NULL | nunca false silencioso | 115/115 local |
| `fhir-extra.test.ts` | FHIR R4 | buscas Bundle searchset, CapabilityStatement | contrato FHIR | idem |
| `interop/interop.test.ts` | HL7v2/TISS/NFSe | parser, ACK, XML | parse/ACK corretos | idem |
| `teleconsult.test.ts` | Sala de teleconsulta | máquina waiting/open/closed, seq monotônica, convite single-use | transições inválidas rejeitadas | idem |
| `ai-clinical.test.ts` | IA com revisão humana | sugestões pendentes exigem revisão | nunca assina/diagnostica sozinha | idem |
| `portal.test.ts` | Portal do paciente | sessão segregada purpose:portal | rejeição em rota staff | idem |
| `hospital.test.ts` | Hospitalar/344 | validações | regras hospitalares | idem |
| `product.test.ts` | Templates/RBAC | matriz de papéis | recusa por papel | idem |
| `lgpd.test.ts` | LGPD | recusa sem base legal | recusa auditada | idem |

## 2. Smoke E2E de API (`npm run smoke` / `smoke:mfa` — banco descartável)

Guard: `STARMED_TEST_DB=true`; API previamente de pé; execução local **e** CI (job `api`).

| Jornada no smoke | Dados iniciais | Esperado | Evidência |
|---|---|---|---|
| Auth + criação de médico/paciente/alergia/problema | nonces `@example.invalid` | 201/200 | local 21/10 ✓ · CI |
| Nota: draft → replay `operationId` → assinatura → 409 de edição | atendimento sintético | replay = mesmo id; imutabilidade 409 | local ✓ · CI |
| Adendo: payload repetido (replay) | `operationId` idem | mesmo id, sem duplicar | local ✓ · CI |
| FHIR (Patient/Encounter/Allergy/Condition) | ids acima | resources corretos | local ✓ · CI |
| Agenda: conflito de slot | 2 POST no mesmo horário | 1º 201, 2º 409 | local ✓ · CI |
| **Prescrição: rascunho → REPLAY de `operationId` (mesma prescrição, lista sem duplicar, chave cruzada em outro encontro → 409) → atestação → REPLAY do sign (mesmo documento) → sign novo → 409 → PDF** | medicamento fictício | idempotência ponta a ponta sem duplicar documento | **local 21/10 ✓** · CI (marco F1) |
| J1 #8: certificado fora do trust store → 400 | CA de teste rogue | 400, sem emissão | local ✓ · CI |
| J1 #12: crítico → fila → ack auditado → fila vazia | pedido lab sintético | ack esvazia fila | local ✓ · CI |
| Readback de auditoria com `requestId` | evento `prescription.signed` | requestId string no evento | local ✓ · CI |
| Smoke MFA: enroll → activate → step-up → recovery single-use → regenerate → disable | usuário sintético | cada etapa conforme RFC | local 21/10 ✓ · CI |

## 3. Drill multi-tenant (RLS real)

| Caso | Esperado | Evidência |
|---|---|---|
| Org A lê recurso da org B / Org B lê o próprio e o estrangeiro | 404 / 200 / 404 | CI job `api` (`scripts/rls/cross-tenant-drill.mjs`), runs em EXECUCAO_2026-10-20 §0 |

## 4. Interoperabilidade (CI job `interop`)

| Caso | Esperado | Evidência |
|---|---|---|
| Lote TISS sintético contra XSD ANS 4.01.00 | VÁLIDO | CI |
| Gate negativo: XML sem `tipoTransacao` | REJEITADO (exit≠0) | CI |

## 5. E2E de UI (Playwright — job `e2e`, `tests/e2e/*`)

Ambiente: `scripts/e2e/run-e2e.mjs` (CA de teste + `ICP_BRASIL_TRUST_STORE` injetável,
migrações, bootstrap, API :3001, web :5174). Detalhes das jornadas: ver os specs.

| Jornada | Cenário (sintético) | Esperado | Evidência |
|---|---|---|---|
| `login-mfa.spec.ts` | login + etapa TOTP (código errado → erro sem sessão; certo → dashboard) | sessão só após 2º fator | **local 3/3 ✓** + **CI `39515333383` job `E2E — Playwright` ✓** (re-run ✓) |
| `prescription-pades.spec.ts` | rascunho → alerta de segurança → override → atestar → PDF → **PAdES positivo (CA de teste)** → verify-pades → **adulteração detectada em 2 camadas** (re-hash + CMS com sha256 forjado) + restauração | `signatureValid:false` após adulteração; true após restaurar | **local 3/3 ✓** + **CI `39515333383` ✓** |
| `break-glass.spec.ts` | 403 sem vínculo → painel → justificativa ≥20 → prontuário + auditoria `access.breakglass` | evento auditado com requestId | **local 3/3 ✓** + **CI `39515333383` ✓** |
| `record360.spec.ts` (F2) | **UI:** timeline com status honesto (prescrição/alergia/documento), alto risco com alergia+medicação+alerta, **aviso `none_recorded` explícito** ("NÃO significa ausência de alergia"), documentos com **v1 pelo gatilho do 022**. **Backend:** `types=foo`→400, meta `signatureStatus:'attested'`, candidatas MPI (mesmo nome+nascimento), **merge de corrente** (movedCounts.encounters=1, encontro movido, perdedor preservado, re-merge→409, auditoria `patient.merged` com requestId) | jornada 4 completa | **local 5/5 ✓** (21/10) · CI `39519009009` ✓ |
| `specialties.spec.ts` (F2b) | **6 jornadas sintéticas**: geral (nota→timeline com autor+versão) · cardiologia (duplicidade→409→override→`duplicate_therapy`) · pediatria (`dose_per_kg` informativo 13.79 mg/kg com declaração de "sem faixa licenciada" + sem peso→sem alerta) · psiquiatria (403→break-glass auditado→nota completa→**timeline sem seções sensíveis**) · ginecologia (especialidade nova na UI, **zero teratogenicidade**) · ortopedia (lateralidade preservada, sem vazamento) | cenários por especialidade | **local 11/11 ✓** + **CI `39521450670` ✓** |
| `results.spec.ts` (F3) | **Ciclo de exames**: transições ilegais→409, `resultValue`/`communicatedTo` obrigatórios→409 de domínio, ciclo feliz até communicated; **escalação J1 #12**: crítico sem ack→409, ack→comunicado, auditoria `result.communicated`+requestId; **PDF**: 404 antes → gerar → `%PDF` → `exam_result` com **v1 pelo gatilho 022** → timeline `exam/final`; **LIS desligado**: 409 honesta + drenagem `{drained:0,sent:0}` | jornada6 completa | **local 14/14 ✓** + **CI `39525441728` ✓ (E2E 1m12s)** |
| `teleconsult.spec.ts` (F4) | **Pareamento UI real**: consentimento obrigatório (bloqueio UI+409 servidor) → mídia fake → **WebRTC Conectado com trilha remota** → `setOffline` → **Reconectando…** (canal de sinais) → recuperação → `bye` fecha nos dois lados; **regras de servidor**: convite single-use (reuso→401), join recusado NÃO queima convite, token de sala (sem→401, ICE config vazio=P2P) | jornada7 completa | **local 16/16 ✓** (21/10) · CI no push do marco F4 |

## 6. Segurança de dependências/segredos (CI)

| Gate | Esperado | Evidência |
|---|---|---|
| SCA (`npm audit --audit-level=critical` + SBOM) | sem críticas | job `sca` |
| Gitleaks (histórico inteiro, sem `continue-on-error`) | zero segredos | job `security` |
| CodeQL | sem alertas novos bloqueantes | workflow CodeQL |

## 7. Pendências NÃO cobertas por esta matriz (nomeadas)

- **PAdES positivo com certificado ICP REAL + validação no ITI** — externo (sessão
  humana + credencial ACT). Quem decide/executa: engenharia + ITI (homologação).
- Base farmacológica licenciada — farmacêutico/direção.
- Pentest externo, IdP OIDC homologado, RNDS/LIS/PACS — bloqueios externos já
  registrados em `docs/engineering/EXECUCAO_2026-10-20.md` §7.
