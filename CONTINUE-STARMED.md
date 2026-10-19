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

1. **Qual stack é oficial?** Repo = NestJS (`apps/api`) + React (`apps/web`);
   `ehr-platform` = Express + React mais completo funcionalmente. As 7 frentes podem
   (a) entrar em ehr-platform e virar produto, ou (b) ser reimplementadas em apps/api.
   Recomendação técnica: (b) se o repo é a fonte de verdade; (a) se velocidade importa mais.
2. Escopo do próximo marco: P0 (estabilidade/segurança) vs. as 7 frentes.

## COMANDOS ÚTEIS

```powershell
# repo oficial
cd C:\Users\Felipe\Documents\deepseek-harness\default-workspace\.starmed-inspect
npm install; npm test; npm run build          # baseline esperada: 9/9 + build verde
docker compose up -d                          # Postgres do StarMed (compor POSTGRES_PASSWORD)

# plataforma paralela
cd C:\Users\Felipe\Documents\deepseek-harness\default-workspace\ehr-platform
cd backend;  $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/ehr'; npm run migrate; npm run seed; npm run dev
cd frontend; npx vite --port 5273             # 5173 está ocupada
# contas: admin@ehr.local/admin123 · ana@ehr.local/medico123
```

## LIÇÕES DE OPERAÇÃO

- **Subagentes morrem em repositórios grandes** (4 quedas em 6.475 arquivos). Mandato
  enxuto: amostrar, classificar por pasta, jamais listar arquivo a arquivo.
- `git push` funciona via GitHub CLI (`credential.https://github.com.helper = gh`).
- Commits relevantes: `c2fdca5` (MVP), `6495811` (integração do legado + fix build).
- Rode `npm test` + `npm run build` antes de qualquer push e registre o resultado aqui.
