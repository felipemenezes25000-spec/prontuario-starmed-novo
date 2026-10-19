# StarMed — Prontuário Eletrônico

MVP original de EHR/EMR para equipes clínicas, inspirado em boas práticas públicas de mercado, **sem copiar software proprietário**.

**Não apto a uso clínico real.** O projeto ainda exige homologação, testes integrados, segurança e conformidade antes de processar dados pessoais sensíveis.

## O que já existe neste repositório
- React 18 + TypeScript + Tailwind com dashboard, pacientes, agenda e formulário de prontuário por especialidade.
- NestJS 10 + PostgreSQL 16: login próprio para demonstração, RBAC por organização, agenda, pacientes, atendimentos e notas clínicas.
- Rascunhos versionados com controle de concorrência, idempotência e atestação imutável.
- Fila offline cifrada no navegador (Dexie/IndexedDB + AES-GCM), sincronização manual e conflitos sem sobrescrita silenciosa.
- Recursos FHIR R4 parciais de leitura: `Patient`, `Encounter`, `AllergyIntolerance` e `Condition` (não é servidor FHIR certificado).
- Alergias e lista de problemas estruturados; agenda com prevenção de colisões e adendos imutáveis após atestação.
- Estrutura inicial de faturamento, prescrições, documentos, estoque e auditoria no banco.
- Extração por IA configurável, desativada por padrão; nada é assinado ou registrado automaticamente.

## Início rápido
1. Requisitos: Node.js 22+, npm e Docker Compose.
2. `cp .env.example .env` (PowerShell: `Copy-Item .env.example .env`).
3. Atualize `AUTH_SECRET` com um segredo aleatório >=32 caracteres; defina senhas diferentes para o PostgreSQL e o bootstrap. Ajuste a URL do banco.
4. `docker compose up -d`
5. `npm install`
6. `npm run bootstrap`
7. Em terminais separados: `npm run dev:api` e `npm run dev:web`
8. Acesse http://localhost:5173; autentique como admin, cadastre um médico em **Equipe**, e entre como médico para criar evoluções.

Execute `npm test` e `npm run build` antes de uso local; `npm run smoke` requer um banco **descartável** e a flag `STARMED_TEST_DB=true`. Os testes não foram executados neste ambiente.

Consulte [instruções detalhadas](docs/getting-started.md), [arquitetura e roadmap](docs/architecture.md), [sincronização offline](docs/offline-sync.md) e [prompt de extração clínica](prompts/clinical-extraction.md).

## Organização do código

```text
apps/
  api/src/          # Controllers NestJS, domínio, segurança, banco
  web/src/          # UI React, templates clínicos, cliente HTTP, offline
database/           # Esquema SQL e índice de login
docs/               # Arquitetura, instalação, limites do MVP
prompts/            # Especificação de IA clínica
docker-compose.yml  # PostgreSQL local
```

## Ativos resgatados do legado (repo `starmed`)

Integração de material aproveitado do repositório anterior (produto RenoveJa + trabalhos
StarMed), curado — nada foi copiado em bloco:

- `docs/STARMED-MASTER-SPEC.md` — especificação normativa do produto (46 capítulos):
  modelo clínico canônico, MPI, packs SUS/hospitalar, interoperabilidade, IA, UX,
  segurança, roadmap e definition of done.
- `docs/regulatory/` — registro de compatibilidade regulatória (RNDS, TISS, ICP-Brasil,
  SNCR, SBIS/NGS2, SaMD), matriz NGS2/S-RES, roadmap de certificações, conformidade
  jurídica de documentos clínicos (PAdES), governança de IA (CFM 2.454/2026), checklist
  LGPD/ANPD, políticas de backup, acesso, criptografia e resposta a incidentes.
- `docs/` — regras de negócio (RX/EX/DC), motor de segurança medicamentosa,
  máquina de estados da receita.
- `docs/references/` — arquitetura Health OS, guias legados de PAdES/ICP-Brasil, fluxo de
  receita e IA, KMS; `design-system/` (tokens + guia de telas) e documentos-modelo de
  receita/pedido/atestado com QR.
- `scripts/` — `rnds/validate-fhir.mjs`, `dr/local-restore-drill.mjs`, `security/`
  (SBOM, ZAP autenticado, triagem de histórico de segredos), `icp-brasil/` (raízes e
  políticas PAdES), `sql/purge_transactional_data.sql` (LGPD).
- `.github/` — CI (testes + build + smoke), CodeQL, Gitleaks, dependabot mensal,
  template de PR.

Dívidas do legado deliberadamente **não** herdadas: trust store ICP-Brasil sem raízes e
TSA desligado, workflows de deploy AWS/RenoveJa, branding e material comercial.

## Estado de verificação (linha de base desta integração)

- `npm install` — ok (npm workspaces).
- `npm test` (API) — 9/9 testes de domínio passando.
- `npm run build` — API + Web compilando (corrigido `React` UMD em `apps/web/src/main.tsx`).

## Próximas etapas prioritárias
- Login corporativo via OIDC/MFA, sessões e revogação, rate limit distribuído, gestão de acesso clínico e infraestrutura com TLS.
- Migrações versionadas, testes Postgres e E2E, backup/restore, observabilidade, segurança ofensiva e proteção dos dispositivos.
- Validação FHIR por perfis aplicáveis, DICOMweb/LIS, TISS, assinatura digital legal, fluxos de prescrição e aditamentos pós-assinatura.
- Revisão clínica, jurídica, LGPD, HIPAA (quando aplicável) e certificações pertinentes.

## Referências abertas
HL7 FHIR R4: https://hl7.org/fhir/R4/  
HHS HIPAA Security Rule: https://www.hhs.gov/hipaa/for-professionals/security/index.html  
Lei Geral de Proteção de Dados: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm

## Aviso sobre a funcionalidade de assinatura
A ação de “atestar” neste MVP grava usuário, data e bloqueia edição no banco. **Não é uma assinatura ICP-Brasil, nem substitui requisitos médico-legais de assinatura eletrônica.**
