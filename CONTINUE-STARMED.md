# CONTINUAR — estado da sessão (StarMed)

Documento de retomada. Uma nova sessão deve ler este arquivo inteiro antes de qualquer
coisa e continuar da seção "EM ABERTO". Atualize este arquivo a cada marco concluído.

---

## RETOMADA EM UMA LINHA

"Leia `CONTINUE-STARMED.md` no repositório do StarMed e continue do ponto A.1 da seção EM ABERTO."

## O QUE É ISTO

- **StarMed** — prontuário eletrônico (EHR). Repositório oficial:
  `https://github.com/felipemenezes25000-spec/prontuario-starmed-novo` (branch main).
- **Repo legado** (auditoria concluída, resgate concluído):
  `https://github.com/felipemenezes25000-spec/starmed` — produto RenoveJa + specs StarMed.

## CAMINHOS NESTA MÁQUINA

| O quê | Onde |
|---|---|
| Clone de trabalho do repo oficial | `C:\Users\Felipe\Documents\deepseek-harness\default-workspace\.starmed-inspect` |
| Clone do legado (auditoria) | `C:\Users\Felipe\Documents\deepseek-harness\default-workspace\.starmed-old` |
| Plataforma EHR paralela (Express+React, NÃO está no repo) | `C:\Users\Felipe\Documents\deepseek-harness\default-workspace\ehr-platform` |
| Cópia entregue da plataforma | `C:\Users\Felipe\Downloads\prontuario perfeito` |
| Serviços rodando | Postgres 16 container `ehr-platform-db-1` (porta 5433); API :3001; UI :5273 |

Portas ocupadas por terceiros: 5432 (backend-dotnet), 5173 (processo alheio). Usar 5433/5273.

## O QUE ESTÁ FEITO (verificado)

1. **Auditoria do legado** — mapa ESTRELA/REFERÊNCIA/DESCARTAR de 6.475 arquivos.
   Núcleo regulatório mapeado: CFM 2.314/2022, CFM 2.454/2026 (IA), SBIS/NGS2 S-RES,
   LGPD/ANPD, ICP-Brasil/PAdES, RNDS, TISS, SNCR (Anvisa), RDC 471, RDC 657.
2. **Resgate integrado ao repo oficial** — commit `6495811` na main (57 arquivos):
   `docs/STARMED-MASTER-SPEC.md` (spec normativa 46 capítulos), `docs/regulatory/` (13
   docs), `docs/BUSINESS_RULES.md`, `MEDICATION_SAFETY_ENGINE.md`,
   `FLUXO_RECEITA_TELAS_E_STATUS.md`, `docs/references/` (Health OS, PAdES, KMS,
   design-system, documentos-modelo com QR), `scripts/` (validate-fhir RNDS, restore-drill
   DR, SBOM, ZAP autenticado, triagem de segredos, ICP-Brasil, purge LGPD), `.github/`
   (CI, CodeQL, Gitleaks, dependabot mensal, PR template).
3. **Fix de build da web** — `apps/web/src/main.tsx` (React UMD). Baseline verificada:
   `npm test` 9/9 verdes, `npm run build` API+Web fechando.
4. **Plataforma paralela ehr-platform** — core clínico completo e verificado: schema PG 16
   (triggers de imutabilidade, sync, auditoria), API Express (auth scrypt+JWT, pacientes,
   atendimentos, documentos assináveis, prescrições append-only, agenda com exclusão de
   double-booking, faturamento TUSS/NFSe, estoque, sync offline idempotente, IA),
   frontend React com design system próprio ("instrumento clínico"), tema claro/escuro,
   command palette ⌘K, offline-first. Smoke test de 11 fluxos passou.
5. **Marco P0-A concluído** — autenticação forte no `apps/api` (NestJS) do repo oficial:
   - MFA TOTP (RFC 6238/4226, base32 RFC 4648) com secret selado AES-256-GCM (HKDF de
     `AUTH_SECRET`), step-up login (`mfaToken` 5min que NÃO abre sessão), 10 códigos de
     recuperação single-use (hash SHA-256), regeneração e desativação com revogação de
     sessões (bump de `auth_version`).
   - SSO OIDC (authorization code + PKCE S256, state single-use em `sso_flows`, nonce,
     verificação de id_token por JWKS RS256/PS256/ES256/EdDSA, link por (issuer,subject)
     com fallback de e-mail, auto-provision opt-in `SSO_AUTO_PROVISION` com role padrão
     não clínica). Desabilitado quando `OIDC_*` não configurado (409 em /auth/sso/start).
   - Guard JWT reescrito com `@Public()` (Reflector) + rejeição de step-up tokens como
     sessão; rate limit em login/MFA/SSO; auditoria de todos os eventos de autenticação.
   - Arquivos: `apps/api/src/{totp.ts,auth-mfa.ts,sso.ts,security.ts,smoke-mfa.ts,
     auth-mfa.test.ts}`, `database/005_auth_mfa_sso.sql`, `.env.example`.
   - **Verificação (registrada por regra)**: `npm test` **21/21 verdes** (9 baseline + 12
     novos com vetores RFC 4226/6238/4648), `npm run build` API+Web **verde**. Migrações
     schema+002–005 aplicadas num PG16 descartável. E2E real: `npm run smoke:mfa`
     (enroll→activate→step-up→recovery single-use→regenerate→disable) **passou**; smoke
     clássico **passou** (sem regressão de login/fluxo clínico). Commit: (ver git log).
6. **Marco P0-B (núcleo) concluído** — infraestrutura de assinatura ICP-Brasil/PAdES no
   `apps/api` (dependência `pkijs`+`asn1js`, sem TLS inseguro em lugar nenhum):
   - Trust store ICP-Brasil: allowlist fixa (raízes v4–v7, v12, v13) materializada e
     **revisada** (`certs/icp-brasil/roots/` + manifest.tsv), falha FECHADA se vazio,
     comparação por fingerprint (nunca por nome — lição do legado).
   - Validação de cadeia própria (node X509Certificate): assinatura, validade com data
     injetável, CA:TRUE, ancoragem obrigatória no trust store.
   - PAdES/CMS detached: atributos ITI exatamente na codificação do container de
     referência (OID de documento = UTF8String VAZIO, CRM/UF = UTF8String, ESS
     signing-certificate-v2, signature-policy-identifier com LPA, SEM signingTime),
     carimbo como unsigned attribute.
   - Cliente RFC 3161 com taxonomia CredencialInvalida/AutoridadeIndisponivel/
     RequisicaoRecusada/RespostaInvalida, política obrigatória sob o arco 2.16.76.1,
     certReq=true, nonce, SERPRO (Basic token + Bearer carimbo) — capacidade nasce
     DESLIGADA (sem TSA_URL não há bytes na rede).
   - LPA (AD-RB/AD-RT v1.3) baixada e conferida contra o SHA-256 oficial do ITI
     (`certs/icp-brasil/policies/`); scripts cross-plataforma `fetch-roots.mjs` e
     `fetch-policies.mjs` com cadeia TLS completada via AIA.
   - **Verificação**: `npm test` **45/45 verdes** (24 novos, PKI em runtime — zero chaves
     fixas), `tsc --noEmit` limpo, `npm run build` API+Web **verde**.
     Pendente (próximo passo): integração API (endpoints de assinatura/validação +
     migração de `document_signatures`).
7. **Sete frentes + P0-B API + P0-C concluídos** (fan-out com subagentes + execução
   direta; 4 subagentes entregaram: FHIR, assinatura PAdES, interop, produto; os demais
   — teleconsulta, IA, portal, hospitalar, backup — foram implementados diretamente
   após quedas dos agentes, reconfirmando a lição de instabilidade desta máquina):
   - **FHIR R4 + SMART**: `fhir-extra.ts` (CapabilityStatement, /.well-known/
     smart-configuration na raiz, 7 buscas Bundle searchset org-scoped).
   - **Assinatura PAdES API**: `signature.ts` (sign-pades com cadeia validada,
     requireTimestamp explícito, evidência tri-estado; rota pública /verify/:id do
     Guia ITI Cap. IV); migração 006 (`document_signatures` append-only +
     `signature_verify_codes`).
   - **Interop**: `interop/` (HL7v2 parser/ACK/MLLP, TISS consulta+lote, NFSe ABRASF,
     ledger `inbound_messages`); migração 007. XSD ANS pendente (declarado).
   - **Teleconsulta**: `teleconsult.ts` (salas waiting/open/closed, signaling
     append-only com seq, convite single-use, consent gate); migração 008.
   - **IA clínica**: `ai-clinical.ts` (CDS Hooks, dictation/discharge-summary/codes
     com `ai_suggestions` pending→só médico revisa, MSE de interações); migração 009.
   - **Portal**: `portal.ts` (convites, activate, JWT portal purpose:'portal',
     /portal/me/*, crm_outbox nasce desligado); migração 010. Fix de integração:
     rotas /portal/me/* precisam de @Public() (o guard global rejeita purpose).
   - **Hospitalar**: `hospital.ts` (wards/beds com EXCLUDE gist, ADT admit/transfer/
     discharge, 344 com justificativa ≥20 chars, pedidos lab/imaging); migração 011
     (com UNIQUE(id,org_id) exigido pelas FKs compostas).
   - **Produto**: `product.ts` (templates versionados, importador CSV tudo-ou-nada,
     matriz RBAC, org_settings, métricas); migração 012.
   - **P0-C**: `scripts/backup/` (pg-backup + restore-verify) e **drill real PASSOU**
     (PG16.15 via container); runbook em docs/BACKUP_RUNBOOK.md.
   - **Verificação**: `npm test` **103/103 verdes** (todas as 11 suítes), tsc limpo,
     build API+Web verde, migrações 002–012 aplicadas em PG16 descartável, smoke E2E
     real em :3102 (capability, SMART, CDS warfarina+AINA, HL7 ack AA, TISS XML,
     portal invite→activate→login→documents, RBAC, métricas).
8. **Frente 3 (LGPD) concluída** — `lgpd.ts` + `database/013_lgpd.sql`: pedidos de
   direitos do titular (acesso/portabilidade com pacote de exportação, correção de
   campos permitidos, exclusão/anonimização com recusa auditada quando há prontuário
   assinado — art. 16/I, revogação de consentimento), consentimento versionado
   append-only por finalidade, endpoints staff (/lgpd/*) e do próprio titular
   (/portal/me/consents e /portal/me/lgpd/requests). `npm test` **107/107 verdes**.
9. **Matriz NGS2/SRES do StarMed** — `docs/regulatory/MATRIZ_NGS2_EVIDENCIAS_STARMED.md`:
   cada família de controle mapeada ao artefato executado neste repo, com portão de
   produção (executado vs. pendente: PAdES→validar.iti.gov.br, SSO/ACT→credencial,
   TLS/RLS→implantação).

## ESTADO FINAL DESTA SESSÃO (19/10/2026)

**Todo o objetivo foi implementado**: P0 (MFA/SSO, PKI/PAdES/TSA com trust store e ACT,
backup/DR testado, matriz NGS2, E2E) e as 7 frentes (FHIR+SMART/CDS Hooks, HL7v2/TISS/
NFSe, LGPD/PAdES, teleconsulta, IA com revisão humana, portal, hospitalar, produto) —
tudo em `apps/api` do repo oficial. **107/107 testes, tsc limpo, build API+Web verde,
migrações 002–013 aplicadas em PG16, smoke E2E real e drill de restore real.**

Commits: `6db2e0a` (P0-A MFA/SSO) · `845d964` (P0-B núcleo PKI) · `b1e4888` (FHIR +
backup/DR) · `263a978` (7 frentes + API assinatura) · `998a599` (LGPD) · este commit
(matriz NGS2).

**Dívidas declaradas para os próximos marcos**: PDF PAdES validado no validar.iti.gov.br;
XSD oficial ANS do TISS; provedor OIDC e credencial SERPRO reais; worker de envio
CRM/WhatsApp (outbox nasce desligado); RLS em PostgreSQL na implantação; frontend das
frentes em `apps/web` (o objetivo desta sessão foi `apps/api`); testes cross-tenant.

## CONTINUAÇÃO (19/10/2026, mesma data) — dívidas sendo fechadas

10. **TISS fechado** — XSDs oficiais ANS 4.01.00 em `schemas/tiss/4.01.00/` (7 arquivos,
    FONTE.md com hashes conferidos), builder `tiss.ts` reescrito para `mensagemTISS`
    4.01.00 e **validado de verdade** contra o esquema (`scripts/tiss/validate-tiss.ps1`,
    positivo VALIDO + negativo INVALIDO exit=1). Commit `ae02ca6`.
11. **Worker CRM fechado** — `scripts/crm/dispatch-outbox.mjs` (FOR UPDATE SKIP LOCKED;
    2xx→sent, 429/5xx→retry, 4xx→failed; nasce desligado sem CRM_PROVIDER_URL) + 3 testes
    puros; modo desligado verificado contra banco real (reportou fila, enviou zero).
12. **RLS opt-in fechado** — `database/014_rls_optin.sql` (ENABLE sem FORCE + policies
    org_id em 30 tabelas; comportamento do owner não afetado) + **drill E2E real**
    `scripts/rls/cross-tenant-drill.mjs`: org A→404 no recurso da org B; org B→200 no
    próprio e 404 no da org A. PASSOU. Commit `5eb8348`.
13. **Submissão ITI preparada** — `scripts/icp-brasil/prepare-iti-submission.mjs` monta
    o pacote (doc + CMS + manifest.sha256 + INSTRUÇÕES.md). A submissão ao portal
    `validar.iti.gov.br` é passo humano (exige navegador/sessão) — declarada como
    pendência externa. Commit `7057415`.
14. **Frontend das frentes fechado** — `apps/web/src/pages/Fronts.tsx` com 5 páginas no
    design system existente (teleconsulta: salas/convite/consentimento; hospitalar:
    métricas de leitos, alas, pedidos lab/imagem; templates: rascunho→publicar;
    métricas/admin: summary, RBAC, ajustes; LGPD: pedidos art. 18 + consentimento),
    plugadas no App.tsx (View/Nav/breadcrumb com permissões por papel). Build web
    verde. Commit `7912eaa`.

**Pendências externas declaradas (não implementáveis sem credencial/sessão real)**:
provedor OIDC real (config via OIDC_* no .env.example), credencial ACT SERPRO
(TSA_* env; capacidade nasce desligada) e a submissão humana ao validar.iti.gov.br
(pacote pronto pelo script acima).

## EM ABERTO (continuar daqui)

### A. RODADA 20/10/2026 — execução do `STARMED_PROMPT_MESTRE_EXECUCAO_V2` (SEM rodar testes, por diretriz do usuário)

Diretriz do usuário nesta rodada: **"execute tudo direto sem testa nada"** — nenhum
`npm test`/build rodou **localmente**. Tudo abaixo é **IMPLEMENTADO, NÃO VALIDADO**
localmente; após o push (autorizado pelo usuário em 20/10) o **CI do GitHub Actions
executou e ficou VERDE em 3 execuções consecutivas** (runs `39460685945` + re-run +
run do push dos docs; evidência completa em `docs/engineering/EXECUCAO_2026-10-20.md` §0).

Feito (commits locais, branch `main`, a partir de `20b8012`):

1. `c5edfe7` **CI completo (P0-01/02/03)**: `npm ci`; runner versionado
   `apps/api/src/migrate.ts` (schema_migrations + sha256 + fail-closed em drift +
   `--adopt`/`--dry-run`); bootstrap de admin sintético; start da API com espera de
   `/health`; smoke **e** smoke:MFA no CI; Gitleaks sem `continue-on-error`
   (+`GITLEAKS_CONFIG`); job SCA com `npm audit --audit-level=critical` + SBOM;
   CODEOWNERS; PR template com gates do DoD; compose parou de aplicar initdb parcial
   (runner é a fonte única); getting-started/README/.env.example atualizados.
2. `bc74ffd` **docs P0-07/P0-12**: `docs/security/THREAT-MODEL-STRIDE.md` (STRIDE por
   domínio, status e bloqueios externos) e `docs/clinical/HAZARD-LOG-FMEA.md` (27
   perigos, J1 mapeado, gates NO-GO).
3. `e3fb692` **D5**: resultado crítico com reconhecimento auditado
   (`POST /hospital/orders/:id/critical-ack`, fila `/orders/critical/pending`,
   migração `017_critical_results.sql`).
4. `2d4b049` **sec**: `POST cds-services/:hook` deixou de ser anônimo.
5. `794062c` **P0-04 web MFA**: etapa TOTP/recuperação no login, página Segurança
   (enroll/activate/códigos únicos/regenerar/desativar), SSO + callback, expiração de
   sessão tratada, logout que limpa estado.
6. `d05dd52` **P1-04 prescrição**: `apps/api/src/prescriptions.ts` (draft estruturado
   com dose/via obrigatórios, motor `info|review_required|block` com override
   auditado, só doctor ativo assina, PDF próprio com sha256, idempotência por
   operationId, cancelamento rastreado, trigger de imutabilidade) + migração
   `016_prescriptions_flow.sql`; CORS de main.ts agora inclui PATCH.
7. `a90dd5b` ci: `GITLEAKS_CONFIG` apontado para `.github/gitleaks.toml`.

Proteção de branch aplicada via API (PR + 1 aprovação + checks `API — testes, build e
smoke`/`Web`/`SCA`/`Gitleaks`, sem force push; `enforce_admins=false` para não travar
repo solo). `docs/engineering/EXECUCAO_2026-10-20.md` = matriz completa.

**ENCERRADOS na sessão:** P0-06 assinatura (agente interrompido por travamento; deltas
feitos pelo agente principal: código ITI de uso único atômico, `qualification`
tri-estado, honestidade de revogação) e P1-08 portal (agente concluiu: `PatientPortal.tsx`
com sessão segregada do staff). P0-05 ABAC: agente interrompido sem escrever; revisão
estática completa pelo agente principal — o núcleo (guard `purpose`/`active`/`ver`,
org em toda query, papéis por recurso) já era sólido; fechado `requestId` em todos os
`audit_events`. Nota: 7 de 12 subagentes morreram sem editar nada (ler a lição em
LIÇÕES DE OPERAÇÃO).

**SEGUNDA RODADA (mesmo dia, após o push autorizado) — prioridades do usuário
executadas e PROVADAS no CI (runs 39473520447 → 39482803902):**

1. `65a09b3`+`146442b` **RLS REAL (ST-P0-005)**: migração `018` — cobertura total por
   scan de `org_id`, modelo em dois níveis (dado clínico estrito + credencial/
   capabilidade pré-auth), `FORCE` no dado, papel `starmed_app` NÃO-owner; contexto
   transacional `starmed.org_id` via `AsyncLocalStorage` (módulo `context.ts` — o
   ciclo db↔security derrubava o guard, o CI pegou); **a API no CI roda como
   `starmed_app`** e o **drill cross-tenant prova o isolamento ponta a ponta**.
2. `3d48460`+`384b36a` **VÍNCULO DE CUIDADO + BREAK-GLASS (J1 #13)**: `020` adiciona
   `patients.created_by`; `requireCareContext` exige encontro/agendamento/cadastro OU
   `X-Break-Glass-Reason` ≥20 auditado — porta em paciente detalhe, alergias,
   problemas, encontros, notas e FHIR (403 sem os dois; 404 continua para cross-tenant).
3. `e834044` **UI DE PRESCRIÇÃO**: `pages/Prescriptions.tsx` — rascunho estruturado,
   alertas com override auditado, assinar/cancelar com status honesto.
4. `31a93c4`+`0fcc3eb` **PAdES DA PRESCRIÇÃO + OCSP**: `019` persiste os BYTES do PDF
   (antes só o sha256 ficava — artefato assinável perdido!); `GET /:id/pdf` com
   re-hash honesto; `POST /:id/sign-pades` (cadeia fechada, ACT com falha explícita,
   CMS em `document_signatures`, corrida→409); OCSP `REVOCATION_MODE=off|soft|hard`
   (padrão off; hard bloqueia revoked/unknown); UI de download+certificado.
   **ByteRange (embarque no PDF) segue PENDENTE e está declarado em toda resposta.**

**ABERTO (próximos passos, ordem de risco):**
- CI: verde em 3 execuções consecutivas (feito); próximo passo é ampliar o smoke
  (tenant duplo, auditoria readback, fixture de assinatura) e manter todo push sob gate.
- `controllers.ts`: transições de agenda (check-in/no-show/cancel — enums já existem
  no schema, endpoints não).
- P0-05 residual: GUC `starmed.org_id` por transação + papel de app não-owner + RLS
  `FORCE` com preflight (não declarar isolamento por RLS antes disso).
- Smoke ampliado: tenant duplo, auditoria readback, fixture de assinatura (aceite C1
  ainda parcial).
- Prescrição: UI web (contrato pronto em `prescriptions.ts`) e integração PAdES real
  (hoje `signature_status='attested'` com nota honesta no PDF/resposta).
- Fronteiras externas inalteradas: IdP OIDC, ITI/ACT/TSA, RNDS/LIS/PACS, base
  farmacológica licenciada, pentest, nomeação dos responsáveis clínicos/DPO.

### B. Plano P0 do outro assistente (avaliação de produto, presente no histórico)

Build validado + E2E · MFA/SSO/backup testado · ICP-Brasil + NGS2 · prontuário 360° ·
prescrição eletrônica · exames/imagens · FHIR R4/RNDS/TISS · IA clínica com revisão humana.

### C. Dívidas conhecidas do repo oficial

- Smoke (`npm run smoke`) só em banco descartável com `STARMED_TEST_DB=true` — agora
  rodando também no CI (job `api`), com smoke:MFA junto.
- Trust store ICP-Brasil sem raízes e TSA desligado NÃO foram herdados — implementar certo.
  (Raízes/políticas públicas em `certs/icp-brasil/` já estão; falta homologação real.)
- ~~TISS: XSD oficial da ANS precisa ser buscado~~ — **QUITADA**: `schemas/tiss/4.01.00/`
  está no repo e o CI valida fixture sintética + gate negativo (job `interop`).

## DECISÕES PENDENTES (perguntar ao retomar)

1. **Qual stack é oficial?** DECIDIDA (retomada desta sessão): **(b) repo oficial**
   `apps/api` (NestJS) + `apps/web`. As 7 frentes serão implementadas/reimplementadas
   no repo oficial; `ehr-platform` vira referência de contrato/UX.
2. Escopo do próximo marco: DECIDIDO — **"tudo"**: P0 (estabilidade/segurança) + as 7
   frentes, em marcos verificáveis com commit cada. Ordem de execução: P0-A (feito),
   P0-B (ICP-Brasil/PAdES), P0-C (backup/DR + E2E), depois frentes 1–8.

## COMANDOS ÚTEIS

```powershell
# repo oficial
cd C:\Users\Felipe\Documents\deepseek-harness\default-workspace\.starmed-inspect
npm install; npm test; npm run build          # baseline: 21/21 local (19/10) e CI 108/108 (run 39343627970, 20/10, antes da rodada V2)
npm run smoke -w @starmed/api                 # só com STARMED_TEST_DB=true (banco descartável)
npm run smoke:mfa -w @starmed/api             # E2E do MFA (idem: banco descartável)
docker compose up -d                          # Postgres do StarMed (compor POSTGRES_PASSWORD)
npm run migrate                               # runner versionado: schema.sql + 002..017
npm run migrate -- --dry-run                  # só planejar; --adopt registra base antiga
# banco descartável para smoke nesta máquina: container ehr-platform-db-1 (:5433),
# criar database p.ex. starmed_p0a_scratch e rodar `npm run migrate` apontando DATABASE_URL para ele

# plataforma paralela
cd C:\Users\Felipe\Documents\deepseek-harness\default-workspace\ehr-platform
cd backend;  $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/ehr'; npm run migrate; npm run seed; npm run dev
cd frontend; npx vite --port 5273             # 5173 está ocupada
# contas: admin@ehr.local/admin123 · ana@ehr.local/medico123
```

## LIÇÕES DE OPERAÇÃO

- **SUBAGENTES: liberados pelo usuário (nova decisão)** — em 19/10/2026 havia a regra
  "sem subagentes" (4 quedas em repo de 6.475 arquivos); o usuário autorizou novamente
  a paralelização. Mandato enxuto: cada subagent recebe os arquivos exatos a ler/criar,
  proibição de listar árvore inteira, de instalar dependências e de tocar em arquivos
  compartilhados (`main.ts`, `domain.ts`, `package.json`, migrações de outros) — a
  integração/verificação/commit é feita pelo agente principal.

- **Subagentes morrem em repositórios grandes** (4 quedas em 6.475 arquivos). Mandato
  enxuto: amostrar, classificar por pasta, jamais listar arquivo a arquivo.
  **Replicado em 20/10/2026**: 7 das 12 tentativas morreram sem editar nada (o padrão
  é morrer na fase de leitura). O que funcionou: mandato com **ordem de leitura em
  blocos curtos** (arquivos pequenos primeiro, grep nos grandes), **lista exata de
  arquivos proibidos** (conflito entre agentes) e **retry** — o agente morto não deixa
  sujeira (git status limpo = não escreveu nada).
- `git push` funciona via GitHub CLI (`credential.https://github.com.helper = gh`).
- Commits relevantes: `c2fdca5` (MVP), `6495811` (integração do legado + fix build).
- Rode `npm test` + `npm run build` antes de qualquer push e registre o resultado aqui.
