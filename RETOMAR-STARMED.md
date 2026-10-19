# Prompt de retomada — StarMed (cole este bloco inteiro na nova sessão)

```markdown
# STARMED — RETOMADA DE SESSÃO (contexto completo — nada foi omitido)

Você está continuando o desenvolvimento do StarMed, prontuário eletrônico (EHR) brasileiro.
Trabalhe com precisão de engenharia: verifique antes de afirmar, rode testes antes de commit,
e atualize o arquivo de estado ao concluir cada marco.

## 1. REPOSITÓRIOS

- OFICIAL (fonte de verdade): https://github.com/felipemenezes25000-spec/prontuario-starmed-novo
  - Branch main. Último commit relevante: `6495811` (integração do legado + fix de build da web).
  - Antes dele: `c2fdca5` (MVP: NestJS 10 + React 18 + PostgreSQL 16, npm workspaces).
- LEGADO (auditoria e resgate CONCLUÍDOS — não refazer): https://github.com/felipemenezes25000-spec/starmed
  - Produto RenoveJa (~6.475 arquivos) com specs StarMed por cima. Resgate já integrado ao oficial.

## 2. CAMINHOS NESTA MÁQUINA (Windows)

| O quê | Caminho |
|---|---|
| Clone de trabalho do repo oficial | `C:\Users\Felipe\Documents\deepseek-harness\default-workspace\.starmed-inspect` |
| Clone do legado (só referência) | `C:\Users\Felipe\Documents\deepseek-harness\default-workspace\.starmed-old` |
| Plataforma EHR paralela (Express+React, NÃO está no repo) | `C:\Users\Felipe\Documents\deepseek-harness\default-workspace\ehr-platform` |
| Cópia entregue da plataforma | `C:\Users\Felipe\Downloads\prontuario perfeito` |
| Arquivo de estado (LER PRIMEIRO) | `C:\Users\Felipe\Documents\deepseek-harness\default-workspace\.starmed-inspect\CONTINUE-STARMED.md` |

Portas ocupadas por terceiros: 5432 (backend-dotnet), 5173 (processo alheio). Usar 5433 (Postgres) e 5273 (Vite).
Serviços que podem estar ativos: container `ehr-platform-db-1` (PG16 :5433), API :3001, UI :5273.

## 3. O QUE JÁ ESTÁ FEITO (NÃO REFAZER)

1. **Auditoria completa do legado** (6.475 arquivos) com mapa ESTRELA/REFERÊNCIA/DESCARTAR.
   Regulatório mapeado: CFM 2.314/2022 (telemedicina), CFM 2.454/2026 (IA — decisão final é do
   médico), SBIS/NGS2 S-RES, LGPD/ANPD, ICP-Brasil/PAdES, RNDS (FHIR R4), TISS/TUSS, SNCR/Anvisa,
   RDC 471/2021, RDC 657/2022.
2. **Resgate integrado no repo oficial** (commit `6495811`, 57 arquivos):
   - `docs/STARMED-MASTER-SPEC.md` — especificação normativa (46 capítulos: modelo clínico
     canônico, MPI, packs SUS/hospitalar, interop, IA, UX, segurança, roadmap, DoD).
   - `docs/regulatory/` — registry de compatibilidade, matriz NGS2/S-RES, roadmap de
     certificações, conformidade jurídica PAdES, governança de IA, checklist LGPD, políticas
     de backup/acesso/criptografia/incidentes, SNCR, interoperabilidade.
   - `docs/BUSINESS_RULES.md` (~60 regras RX/EX/DC), `MEDICATION_SAFETY_ENGINE.md`,
     `FLUXO_RECEITA_TELAS_E_STATUS.md`.
   - `docs/references/` — Health OS, PAdES/ICP-Brasil, fluxo de receita e IA, KMS,
     design-system legado (tokens + guia), documentos-modelo de receita com QR.
   - `scripts/` — `rnds/validate-fhir.mjs`, `dr/local-restore-drill.mjs`, `security/`
     (SBOM, ZAP autenticado, triagem de segredos), `icp-brasil/` (raízes + políticas PAdES),
     `sql/purge_transactional_data.sql` (LGPD).
   - `.github/` — ci.yml (testes+build+smoke), codeql.yml, dependabot mensal, PR template,
     gitleaks.toml.
3. **Fix de build**: `apps/web/src/main.tsx` (React UMD). BASELINE VERIFICADA:
   `npm install` ok · `npm test` **9/9 verdes** · `npm run build` **API+Web fechando**.
4. **Plataforma paralela `ehr-platform`** — core clínico completo e verificado (typechecks
   limpos, smoke de 11 fluxos passou): schema PG16 (imutabilidade de documento assinado,
   prescrição append-only, agenda com exclusion constraint, sync, auditoria), API Express
   (scrypt+JWT, pacientes com SDoH, atendimentos, templates por especialidade em JSONB,
   documentos assináveis, faturamento TUSS/NFSe, estoque, sync offline idempotente, IA),
   frontend React com design system "instrumento clínico" (tema claro/escuro, ⌘K, offline).
   Contas: `admin@ehr.local/admin123`, `ana@ehr.local/medico123`.

## 4. EM ABERTO (continuar daqui)

### A. Sete frentes para superar todos os concorrentes — contrato pronto, implementação pendiente
Em `ehr-platform` existem STUBS montados e contrato travado (ver `ehr-platform/frontend/DESIGN.md`):
- Backend (exports já montados em `src/index.ts`, migrações numeradas 002–009 por frente):
  `routes/fhir.ts` (FHIR R4 + SMART/CDS) · `routes/interop.ts` (HL7 v2 MLLP + TISS XML + NFSe) ·
  `routes/lgpd.ts` (ICP-Brasil/PAdES + direitos LGPD) · `routes/teleconsult.ts` (WebRTC) ·
  `routes/cds.ts` (IA: CID-10/TUSS, dictation, resumo de alta) · `routes/portal.ts`
  (portal do paciente + CRM/WhatsApp) · `routes/hospital.ts` (leitos/ADT/344/LIS-PACS) ·
  `routes/product.ts` (editor de templates, importadores, multi-tenant/RBAC, métricas).
- Frontend (stubs já rotulados em `App.tsx`): `pages/Teleconsult.tsx`, `Hospital.tsx`,
  `TemplateEditor.tsx`, `Portal.tsx`, `Import.tsx`, `Admin.tsx`, `Metrics.tsx`.
- Primitivos de UI prontos: `components/ui.tsx`, `components/CommandPalette.tsx`.
- Regra: todo agente de tela lê `DESIGN.md` primeiro; estados loading/erro/vazio/sucesso
  obrigatórios; tokens do `styles.css`, nunca valor cru.

### B. Plano P0 de produto (avaliação anterior)
Build validado + testes E2E · MFA/SSO, backup/DR testado · assinatura ICP-Brasil + matriz NGS2 ·
prontuário 360° (linha do tempo, vitals, medicações) · prescrição eletrônica · exames/LIS/PACS ·
FHIR R4/RNDS/TISS · IA com revisão humana obrigatória.

### C. Dívidas conhecidas
- `npm run smoke` só em banco descartável (`STARMED_TEST_DB=true`).
- Trust store ICP-Brasil SEM raízes e TSA desligado no legado — NÃO herdar; implementar com
  validação em validar.iti.gov.br.
- TISS: buscar XSD oficial da ANS (ausente no legado).

## 5. DECISÕES PENDENTES — PERGUNTAR AO USUÁRIO ANTES DE IMPLEMENTAR

1. **Stack oficial das 7 frentes**: (a) `ehr-platform` (Express, mais completo, pronto) e depois
   migrar, ou (b) reimplementar em `apps/api` (NestJS) do repo oficial. Recomendação: (b) se o
   repo é fonte de verdade; (a) se velocidade importa mais.
2. **Escopo do próximo marco**: estabilidade/segurança (P0) vs. as 7 frentes.

## 6. REGRAS DE OPERAÇÃO (lições desta máquina)

- **SEM SUBAGENTES** — decisão do usuário (19/10/2026): execute tudo diretamente, sem
  delegar a agentes filhos nesta máquina (os 6 de auditoria foram encerrados).
- `git push` funciona via GitHub CLI (credencial já configurada). Commits na main são permitidos.
- Antes de TODO commit: `npm test` + `npm run build` no repo oficial (baseline: 9/9 + verde) e
  registrar o resultado em `CONTINUE-STARMED.md`.
- Atualizar `CONTINUE-STARMED.md` a cada marco concluído (o que fez, o que falta, decisões).
- Portas: 5432 e 5173 estão ocupadas por outros projetos; usar 5433/5273.

## 7. PRIMEIRO PASSO DESTA SESSÃO

1. Ler `CONTINUE-STARMED.md` por completo.
2. Confirmar comigo as duas decisões do item 5.
3. Executar o marco escolhido com verificação (testes/build) e commit na main.
```
