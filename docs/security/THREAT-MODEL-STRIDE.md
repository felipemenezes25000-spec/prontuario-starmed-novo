# Threat Model STRIDE — StarMed

**Data:** 20/10/2026 · **Base:** `main` @ `20b801249b5c5d84e939b4ee1ca3ae1a46f2edf0` · **Escopo:** prontuário eletrônico StarMed (API NestJS + web React + PostgreSQL).

> **Status de execução honesto:** esta é uma revisão ESTÁTICA de código. Nenhum teste,
> scan ou pentest foi executado nesta rodada (diretriz de execução: sem execução de
> testes). Nada aqui deve ser lido como "vulnerabilidade eliminada" — apenas
> "controle presente no código, não validado em execução".

**Legenda de status:**

| Status | Significado |
|---|---|
| `mitigado-código` | Controle implementado e localizável no código; sem prova de execução |
| `parcial` | Existe mas há caminho conhecido incompleto |
| `aberto` | Não há controle no código |
| `bloqueado-externo` | Depende de terceiro (IdP, ITI, TSA, LIS/PACS, órgão) |

## 1. Ativos e fronteiras de confiança

**Ativos:** PHI (prontuário, prescrições, exames, documentos assinados); identidade
profissional (papéis, CRM/UF, MFA); material de PKI e `AUTH_SECRET`; cadeia de entrega
(GitHub Actions, npm); disponibilidade clínica (RTO/RPO).

**Fronteiras:** navegador↔API; API↔PostgreSQL; API↔IdP OIDC (SSO); API↔TSA/OCSP/validador
ITI; portal do paciente↔API; teleconsulta↔par WebRTC; GitHub Actions↔repositório;
operador de infraestrutura↔banco/backup.

## 2. Modelo por domínio (STRIDE)

### 2.1 Identificação, MFA e SSO — `apps/api/src/auth-mfa.ts`, `sso.ts`, `totp.ts`, `security.ts`

| Ameaça | Cenário | Controle atual | Status |
|---|---|---|---|
| (S) Spoofing | Furar o segundo fator | TOTP RFC 6238 com step-up: `mfaToken` (5 min) **não** abre sessão clínica; recovery codes single-use com hash (`auth-mfa.ts`) | `mitigado-código` |
| (S) Spoofing | Replay de TOTP | Janela ±1 passo + cache de nonce (`totp.ts`/`auth-mfa.ts`) | `mitigado-código` |
| (S) Spoofing | Account takeover via e-mail não verificado no OIDC | Vínculo por `(issuer, sub)` exclusivo; fallback de e-mail condicionado (`sso.ts`) | `parcial` — homologação de IdP real pendente (externo) |
| (E) Elevation | Obter sessão plena sem MFA | `mfaToken` rejeitado como sessão; recuperação com rate limit (`main.ts` `/auth/mfa/recovery`) | `mitigado-código` |
| (E) Elevation | Conta criada por auto-provision do SSO ganhar papel clínico | `SSO_DEFAULT_ROLE` não clínico, opt-in (`sso.ts`) | `mitigado-código` |
| (D) DoS | Brute force de senha/código | Rate limit em memória por IP nas rotas de auth (`main.ts`) | `parcial` — em memória; em implantação multi-instância precisa de rate limit distribuído |
| (R) Repudiation | Negação de login/MFA | Falta conferir: eventos de auth em `audit_events` sem credenciais | `parcial` — cobrir nos testes P0-06 |

### 2.2 Autorização e multi-tenant — `security.ts`, `controllers.ts`, `014_rls_optin.sql`

| Ameaça | Cenário | Controle atual | Status |
|---|---|---|---|
| (E) Elevation | Ler tenant B pela URL (IDOR/cross-tenant) | Queries filtram `org_id` a partir do token; RLS opt-in 014 como defesa em profundidade | `parcial` — RLS sem `FORCE` e com bypass do table owner; GUC `starmed.org_id` **não** é definida na pool (`db.ts`) |
| (E) Elevation | Token do portal acessando rotas staff | `purpose:'portal'` rejeitado pelo `JwtGuard` (`portal.ts`, `security.ts`) | `mitigado-código` — ampliar matriz de testes negativos |
| (E) Elevation | Sessão de usuário desativado/revogado permanece válida | `auth_version` bump em revogação; conferir enforcement no guard para **todos** os caminhos | `parcial` — revisão em andamento (P0-05) |
| (E) Elevation | Rotas `@Public()` expõem PHI | `@Public` em `controllers.ts`, `fhir-extra.ts`, `signature.ts:327`, `teleconsult.ts:114`, `ai-clinical.ts:89,93`, `lgpd.ts`, `sso.ts`, `auth-mfa.ts` | `parcial` — inventário e endurecimento em andamento (P0-05); nenhum desses caminhos pode devolver PHI |
| (E) Elevation | Acesso sem vínculo assistencial com o paciente | Vínculo paciente↔profissional / break-glass com justificativa | `aberto` — implementação em andamento (P0-05) |
| (I) Info Disclosure | `CapabilityStatement`/metadata FHIR anônimo com PHI | discovery/@Public em `fhir-extra.ts` deve anunciar só capability | `parcial` — validar que search exige token |

### 2.3 Notas clínicas e imutabilidade — `domain.ts`, `addenda.ts`, `00X`/`schema.sql:181`

| Ameaça | Cenário | Controle atual | Status |
|---|---|---|---|
| (R) Repudiation | Alterar nota assinada | Trigger `forbid_signed_note_mutations()` (`schema.sql:181`) + `status/version` CHECK + 409 por concorrência otimista | `mitigado-código` (trigger é camiso, não prova de imutabilidade absoluta — ver 2.9) |
| (T) Tampering | Assinar a versão errada sob concorrência | `expectedVersion` obrigatório; adendo separado do original | `mitigado-código` |
| (E) Elevation | Admin assinar nota de médico | Assinatura exige habilitação do autor/papel clínico | `parcial` — matriz papel×assinatura em revisão (P0-05/P0-06) |

### 2.4 Prescrição eletrônica — `prescriptions` (em implantação: `prescriptions.ts`, `016_prescriptions_flow.sql`)

| Ameaça | Cenário | Controle atual | Status |
|---|---|---|---|
| (E) Elevation | Não-médico emite receita final | Assinatura exige papel `doctor` ativo (403 para demais, inclusive admin) | em implementação (P1-04) |
| (I) Info Disclosure | Prescrever para paciente errado | Identificação + `encounter_id` obrigatório; confirmação de paciente antes de prescrever na UI | `parcial` — UI pendente |
| (T) Tampering | Dose sem unidade/via | Validação server-side bloqueia emissão (J1 #5) | em implementação (P1-04) |
| (E) Elevation | Alergia grave ignorada | `block` sem override para `criticality='high'`; override auditado nos demais níveis | em implementação (P1-04) |
| (R) Repudiation | Reenvio duplica receita (rede) | `operationId` idempotente na assinatura (J1 #9) | em implementação (P1-04) |
| (I) Info Disclosure | Base de conhecimento farmacológico inventada | Fonte licenciada marcada como pendência externa; sem monografias fabricadas | `bloqueado-externo` — licença/clínica |
| — | Receita controlada/antimicrobiano fora da regulamentação | Classe especial desabilitada por padrão (409) até configuração/regulamentação versionada | `bloqueado-externo` — regulação ANS/Anvisa/conselho |

### 2.5 Assinatura digital e PKI — `signature.ts`, `pki/*`, `certs/icp-brasil/*`

| Ameaça | Cenário | Controle atual | Status |
|---|---|---|---|
| (S) Spoofing | Apresentar atestação como "assinatura válida" | Separação de status (attested/signed/pades_verified/…) | em implementação (P0-06) |
| (T) Tampering | PDF alterado 1 byte após assinar | ByteRange + hash + CMS detached na verificação | `mitigado-código` — validação externa no ITI pendente |
| (E) Elevation | Certificado expirado/revogado errado assina | Rejeição dura de cadeia inválida/expirada/revogada | em implementação (P0-06) |
| (D) DoS / (I) | TSA indisponível → documento com atributo enganoso | Falha da TSA vira estado explícito `external_block` | em implementação (P0-06) |
| — | Validação no validador oficial do ITI | — | `bloqueado-externo` — validar.iti.gov.br + homologação ACT/TSA |
| (S) Spoofing | Chave privada no backend (PFX/P12) | Proibido como fluxo padrão; assinatura remota/HSM é a direção | `parcial` — migração KMS documentada em `docs/references/CERTIFICATE_KMS_SETUP.md` |

### 2.6 Portal do paciente — `portal.ts`, `010_portal.sql`

| Ameaça | Cenário | Controle atual | Status |
|---|---|---|---|
| (S) Spoofing | Parar URL = ver prontuário | Tokens `purpose=portal` com escopo de paciente; rotas staff negadas | `mitigado-código` |
| (I) | Link de documento expirável/enumerável | Links temporários com expiração e controle de acesso | `parcial` — UI/fluxo completo do portal pendente (D8) |
| (E) | Paciente acessar outro paciente | `patient` claim fixo no token (não escolhido na requisição) | `mitigado-código` |

### 2.7 Interoperabilidade — `interop/*`, `fhir-mappers.ts`, `fhir-extra.ts`

| Ameaça | Cenário | Controle atual | Status |
|---|---|---|---|
| (E)/(I) | Endpoint FHIR anônimo com PHI | Search exige token; metadata pública só capability | `parcial` — testes negativos obrigatórios |
| (T) | Mensagem HL7 v2/TISS malformada ou replay | Validação de schema, ACK/NAK, idempotência, DLQ por design | `parcial` — adapters desabilitados sem credencial |
| — | RNDS/LIS/PACS reais | — | `bloqueado-externo` — homologação de credenciais |
| (D) | Adapter instável derruba a API | Circuit breaker/retry/DLQ previstos; adapters off por padrão | `parcial` |

### 2.8 IA clínica — `ai-clinical.ts`, `009_ai_clinical.sql`

| Ameaça | Cenário | Controle atual | Status |
|---|---|---|---|
| (S) | Prompt injection em transcrição/PDF altera política | Instrução de sistema anti-injeção (`controllers.ts:272`) + revisão humana obrigatória | `parcial` — sem teste adversarial executado |
| (T) | IA preenche alergia/dose/diagnóstico falso | Sugestão nunca autossalva; `requires_physician_review`; nada de autoaceite | `mitigado-código` |
| (I) | Vazamento de PHI ao fornecedor de LLM | Opt-out de treinamento/DPA/fornecedor — configuração externa | `bloqueado-externo` — contrato/fornecedor |
| (E) | IA assina/alta/prescreve sozinha | Assinatura sempre controlada por profissional | `mitigado-código` (manter invariantes em revisões) |

### 2.9 Banco, auditoria e operação

| Ameaça | Cenário | Controle atual | Status |
|---|---|---|---|
| (T) | Admin de banco reescrever auditoria | Trigger append-only + `audit_events`; WORM/encadeamento externo | `parcial` — append-only é camiso, não imutabilidade; cadeia digest externa pendente |
| (I) | Logs com PHI | Revisão de `console.log` sem texto clínico (P0-05/P0-09) | em revisão |
| (D) | Perda de disco/ransomware | `docs/BACKUP_RUNBOOK.md`, `scripts/backup/*`, drills | `parcial` — restore não revalidado em infra-alvo nesta rodada |
| (T) | Migração corrompe base | Runner versionado com checksum/drift fail-closed (`apps/api/src/migrate.ts`) | `mitigado-código` — execução pendente |

### 2.10 Cadeia de entrega — `.github/workflows/*`

| Ameaça | Cenário | Controle atual | Status |
|---|---|---|---|
| (S) | Segredo no histórico | Gitleaks como job **bloqueante** (sem `continue-on-error`), `gitleaks.toml` + `.gitleaksignore` | `mitigado-código` |
| (E) | Merge direto/force push em `main` | Branch protection: PR + 1 aprovação + checks obrigatórios + sem force push/deleção (aplicada em 20/10/2026) | `mitigado-código` |
| (T) | Dependência comprometida | SCA (`npm audit --audit-level=critical` como gate), Dependabot, lockfile + `npm ci`, SBOM (`scripts/security/generate-sbom.mjs`) | `mitigado-código` |
| (I) | Ação de terceiro maliciosa | Revisar publisher e fixar versão/digest das actions críticas | `parcial` |

## 3. OWASP ASVS / API Security — cobertura prevista (execução pendente)

| Área | Cenário obrigatório (J1) | Ferramente | Status de execução |
|---|---|---|---|
| A01 Controle de acesso | #13 vínculo, #14 cross-tenant, #15 portal vs staff, #16 admin assinando | testes de integração negativos + ZAP autenticado | **não executado nesta rodada** |
| A02 Criptografia | TLS, KMS, backups | revisão de config + scan | **não executado** |
| A03 Injeção | SQL/XSS/prompt injection (#21) | CodeQL + testes adversariais | CodeQL ativo no repo; demais **não executado** |
| A04 Design inseguro | #17 imutabilidade, #18 concorrência, #19 idempotência | testes de integração | **não executado** |
| A05 Falha errônea | #24 disco/banco | drill de restore | **não executado (infra-alvo)** |
| A07 Autenticação | MFA bypass, sessão | smoke MFA (CI) | roda no CI após o merge deste change |
| A08 Integridade | #10 PDF alterado, #9 replay | testes PAdES | **não executado** |
| A09 Monitoramento | auditoria sem PHI | revisão de logs | em revisão (P0-05/P0-09) |
| API Top 10 | IDOR/BOLA/BFLA/mass assignment | ZAP + testes negativos | **não executado** |

## 4. Pendências externas (não resolvidas por código)

1. Homologação OIDC de um IdP real (state/nonce/PKCE/JWKS em produção).
2. Validação de PDF PAdES no validador oficial do ITI + relatório datado.
3. Homologação de ACT/TSA real e revogação OCSP/CRL em operação.
4. Pentest externo independente com reteste (somente em ambiente autorizado).
5. Credenciais e homologação RNDS, LIS/PACS, TISS com a ANS, NFSe municipal.
6. Licença de base de conhecimento farmacológico para o motor de segurança.
7. WORM/encadeamento de auditoria fora do alcance do DBA (segregação real).

## 5. Regras mantidas nesta rodada

- Nenhum teste de carga, pentest intrusivo ou falha induzida em produção.
- Dados 100% sintéticos; nenhum segredo/PHI no repositório ou nos logs.
- Nenhuma função de risco desligada para deixar CI verde; bloqueios são declarados.
