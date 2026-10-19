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

## EM ABERTO (continuar daqui)

### A. Sete frentes para passar os concorrentes — CONTRATO PRONTO, IMPLEMENTAÇÃO NÃO

Estavam agendadas 13 subagentes quando a sessão foi interrompida. Os STUBS e o contrato
existem em `ehr-platform`:

- Backend (stubs com exports travados, já montados em `src/index.ts`):
  `routes/fhir.ts` (FHIR R4+SMART), `routes/interop.ts` (HL7 v2 MLLP + TISS + NFSe),
  `routes/lgpd.ts` (ICP-Brasil/PAdES + LGPD), `routes/teleconsult.ts` (WebRTC),
  `routes/cds.ts` (IA clínica: CID-10/TUSS, dictation, CDS Hooks), `routes/portal.ts`
  (portal do paciente + CRM/WhatsApp), `routes/hospital.ts` (leitos/ADT/344/LIS-PACS),
  `routes/product.ts` (editor de templates, importadores, multi-tenant/RBAC, métricas).
  Migrações numeradas 002–009 (uma por frente).
- Frontend (stubs registrados no roteador): `pages/Teleconsult.tsx`, `Hospital.tsx`,
  `TemplateEditor.tsx`, `Portal.tsx`, `Import.tsx`, `Admin.tsx`, `Metrics.tsx`.
- **Contrato de UI**: `ehr-platform/frontend/DESIGN.md` (obrigatório para qualquer agente
  de tela). Primitivos prontos em `src/components/ui.tsx` + `CommandPalette.tsx`.
- Fundação verificada: typecheck backend e frontend limpos com os stubs.

### B. Plano P0 do outro assistente (avaliação de produto, presente no histórico)

Build validado + E2E · MFA/SSO/backup testado · ICP-Brasil + NGS2 · prontuário 360° ·
prescrição eletrônica · exames/imagens · FHIR R4/RNDS/TISS · IA clínica com revisão humana.

### C. Dívidas conhecidas do repo oficial

- Smoke (`npm run smoke`) só em banco descartável com `STARMED_TEST_DB=true`.
- Trust store ICP-Brasil sem raízes e TSA desligado NÃO foram herdados — implementar certo.
- TISS: XSD oficial da ANS precisa ser buscado (ausente no legado).

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
npm install; npm test; npm run build          # baseline atual: 21/21 + build verde
npm run smoke -w @starmed/api                 # só com STARMED_TEST_DB=true (banco descartável)
npm run smoke:mfa -w @starmed/api             # E2E do MFA (idem: banco descartável)
docker compose up -d                          # Postgres do StarMed (compor POSTGRES_PASSWORD)
# banco descartável para smoke nesta máquina: container ehr-platform-db-1 (:5433),
# criar database p.ex. starmed_p0a_scratch e aplicar database/schema.sql + 002..005

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
- `git push` funciona via GitHub CLI (`credential.https://github.com.helper = gh`).
- Commits relevantes: `c2fdca5` (MVP), `6495811` (integração do legado + fix build).
- Rode `npm test` + `npm run build` antes de qualquer push e registre o resultado aqui.
