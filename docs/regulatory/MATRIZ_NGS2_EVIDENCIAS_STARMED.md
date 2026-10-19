# Matriz NGS2 / SRES — evidências StarMed

**Data-base:** 19/10/2026
**Escopo:** repo `prontuario-starmed-novo`, API `apps/api` (NestJS) + `apps/web`.
**Objetivo:** mapear cada família de controle do S-RES/NGS2 aos artefatos EXECUTADOS neste
repositório, distinguindo "código versionado" de "evidência de ambiente" (portão de
produção — mesma regra da matriz de referência em `MATRIZ_NGS2_SRES.md`).

> Este documento é uma matriz de evidências, não um certificado SBIS. Não declara
> certificação formal que não tenha sido obtida.

## Matriz de controles

| Família | Controle | Evidência no StarMed | Estado (executado) |
|---|---|---|---|
| Identidade | conta nominal + autenticação scrypt | `apps/api/src/security.ts` (scrypt, JWT HS256 com `auth_version`), smoke `src/smoke.ts` | **executado** — smoke E2E real (2026-10-19) |
| Segundo fator | MFA TOTP + códigos de recuperação | `src/totp.ts` (RFC 6238/4226), `src/auth-mfa.ts`, vetores RFC nos testes | **executado** — `smoke:mfa` real: enroll→activate→step-up→recovery single-use→regenerate→disable |
| SSO | OIDC authorization code + PKCE | `src/sso.ts` (state single-use, nonce, JWKS, arco de credenciais) | código + testes; provedor externo pendente de homologação |
| Autorização | RBAC por papel + matriz explícita | `src/product.ts` (`RBAC_MATRIX`, 16 permissões × 4 papéis), teste de completude | **executado** — teste puro + smoke `/product/admin/rbac/matrix` |
| Menor privilégio | exigência de papel por rota | `requireRole` aplicado em todos os controllers (guard global JwtGuard) | **executado** — tsc + 107 testes |
| Isolamento | escopo `org_id` em todas as queries | padrão `WHERE org_id=$n` verificado em controllers (patients, encounters, fhir, portal, hospital…) | código + revisão; RLS em PostgreSQL fica para implantação (ver dívida) |
| Auditoria | eventos de acesso/mutação | `audit_events` + `audit()` em todos os módulos novos | **executado** — smoke confirma inserções |
| Integridade de auditoria | append-only real | triggers `forbid_audit_change()` (schema base) reaproveitados em sinais/consentimentos/assinaturas | **executado** — migrações 008/006/013 aplicadas em PG16 |
| Criptografia em trânsito | HTTPS na borda | helm + CORS restrito; TLS do endpoint é da implantação | comprovar no ambiente |
| Criptografia em repouso | segredos e certificados | TOTP secrets selados AES-256-GCM (`sealSecret`, HKDF de `AUTH_SECRET`); recuperação de senha por hash | **executado** — teste de tamper-detection |
| Assinatura clínica | PAdES + OIDs ITI | `src/pki/pades.ts` (atributos ITI exatos, ESSCertIDv2, LPA), evidência tri-estado | código + 24 testes; **PDF real pendente de validar.iti.gov.br** (dívida declarada) |
| Cadeia de confiança | trust store ICP-Brasil | `certs/icp-brasil/roots/` (allowlist v4–v7,v12,v13 + manifest.tsv), `fetch-roots.mjs` (TLS via AIA, hash auditado), `pki/trust-store.ts` falha-fechada | **executado** — 6 raízes materializadas e revisadas |
| Carimbo de tempo | ACT RFC 3161 | `src/pki/tsa.ts` (taxonomia 4 categorias, arco 2.16.76.1 obrigatório, SERPRO Basic+Bearer), capacidade nasce desligada | código + 11 testes com fake-TSA; ativação pendente de credencial real |
| Consentimento | registro auditável | `lgpd_consents` append-only (`013`), portal e staff, revogação em lote | **executado** — migração aplicada + testes |
| Retenção clínica | proteção contra exclusão indevida | triggers de imutabilidade de notas assinadas + `document_signatures` append-only | **executado** — smoke clássico prova 409 em edição de nota assinada |
| Direitos do titular | pedidos com prazo e trilha | `lgpd.ts` (acesso/portabilidade/correção/exclusão com recusa art. 16/I) | **executado** — migração 013 + 4 testes puros |
| Backup/continuidade | backup e DR | `scripts/backup/pg-backup.mjs` + `restore-verify.mjs`, `docs/BACKUP_RUNBOOK.md` | **executado** — drill real PASSOU (2026-10-19, PG16.15) |
| Segurança de sessão | token com expiração + revogação | JWT 4h com `auth_version` (bump revoga tudo — usado no disable de MFA) | **executado** — smoke:mfa |
| Rate limiting | por endpoint sensível | `main.ts`: login, MFA, SSO, `/verify` (ITI) | **executado** — configuração ativa na API |
| Segurança de IA | revisão humana obrigatória | `ai-clinical.ts` (sugestões `pending` → só médico aceita/rejeita, trigger de revisão única) + MSE de interações | **executado** — 6 testes + smoke CDS (warfarina+AINA → warning) |
| Interoperabilidade | HL7 v2 / TISS / NFSe | `src/interop/` (parser/ACK/MLLP, TISS, ABRASF), ledger `inbound_messages` | **executado** — 10 testes + smoke real (ACK AA, XML TISS); XSD ANS pendente (dívida) |
| Disponibilidade | health checks | `/health` + smoke | executado |

## Portão de produção (regra herdada da matriz de referência)

Uma linha só é "comprovada" com **evidência do ambiente executado**:

- ✅ MFA: `smoke:mfa` executado de ponta a ponta em PG16 descartável (2026-10-19).
- ✅ Backup/DR: `restore-verify` executado com dump real (2026-10-19).
- ✅ Trust store: 6 raízes ICP-Brasil materializadas com manifest e revisão de subjects.
- ⏳ PAdES: aguardando PDF real submetido ao `validar.iti.gov.br` (dívida P0-B).
- ⏳ SSO/ACT: aguardando provedor OIDC e credencial SERPRO.
- ⏳ TLS em produção e RLS em PostgreSQL: da implantação, não deste repo.

## Evidências a arquivar por release

- SHA/versão implantada · resultado de `npm test` (hoje: **107/107**) e `npm run build` ·
  migrações aplicadas (schema+002–013 em PG16) · relatório de dependências (dependabot) ·
  teste de MFA · teste de restauração (drill) · PDF assinado + relatório ITI quando
  disponível · homologações RNDS/e-SUS/SNCR quando aplicáveis.

## Regra de redação

"Atende ao requisito por meio de [controle] e a evidência está em [artefato]".
Nunca "100% NGS2/SBIS" sem certificação correspondente.
