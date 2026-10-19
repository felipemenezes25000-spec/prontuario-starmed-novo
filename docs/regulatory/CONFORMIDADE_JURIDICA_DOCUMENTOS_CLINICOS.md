# Conformidade jurídica — Documentos clínicos digitais

**Referências:** ICP-Brasil (ITI), regras sanitárias, conselhos profissionais, jurisprudência e boas práticas de prova.

---

## 1. Assinatura digital ICP-Brasil (PAdES/ITI)

| Requisito | Status | Implementação |
|-----------|--------|---------------|
| PAdES (ISO/ETSI) | ✅ | `DigitalCertificateService.SignPdfWithBouncyCastle` — PKCS#7/CMS, SHA256 |
| OIDs ITI nos atributos | ✅ | `ItiHealthOidsSignatureContainer` — prescrição/exame, CRM, UF |
| DocMDP (P=2) | ✅ | Evita "Assinatura Indeterminada" no validar.iti.gov.br |
| Validação de cadeia contra AC Raiz | ⚠️ **código pronto, trust store vazio** | `IcpBrasilTrustStore` usa `CustomRootTrust` sobre as raízes carregadas de `IcpBrasilSignature:TrustStorePath`. `infra/icp-brasil/roots/` contém **só um `README.md`, zero raízes** → `TrustStoreNotConfigured` → falha fechada. **Nenhum certificado de médico pode ser cadastrado hoje** |
| Carimbo do tempo (TSA/ACT) | ⚠️ **suportado, não ativado** | Há integração com a ACT **SERPRO**, credenciada ICP-Brasil (política `2.16.76.1.6.2`, arco `2.16.76.1`). A capacidade nasce desligada: `IcpBrasilSignature:TimestampProvider` está **vazio**, `TimestampAuthorityUrl` **vazia** e `RequireTimestamp = false` no `appsettings.json`, então a emissão atual é **AD-RB**. Ativar exige as credenciais no SSM. Não há, neste repositório, evidência de documento emitido com carimbo |
| Aceito pelo validar.iti.gov.br | ❓ **não comprovado** | Não há, neste repositório, registro de nenhum PDF gerado por este código submetido ao validador do ITI. `docs/guides/CONFIG_ITI.md` é configuração, não evidência de validação |

> ⚠️ **Correção de 22/08/2026.** Duas linhas com ✅ ("Cadeia completa + TSA" e
> "Aceito pelo validar.iti.gov.br") viraram as três acima. A primeira juntava
> dois controles de estados diferentes e afirmava um TSA que a configuração
> desmente; a segunda era afirmação de intenção do desenho, não de resultado
> observado. A distinção decide um edital: PAdES com
> OIDs ITI **escrito** é uma coisa; documento **validado** no
> `validar.iti.gov.br` é outra, e é a segunda que o avaliador pede.
> Ver achado 2 de
> [`../security/AUDITORIA_OFENSIVA_2026-08-17.md`](../security/AUDITORIA_OFENSIVA_2026-08-17.md).

---

## 2. Trilha de auditoria imutável

### 2.1 O que já existe

| Dado | Onde | Observação |
|------|------|------------|
| Quem gerou | `audit_logs.user_id`, `user_email`, `user_role` | Via `AuditMiddleware` e `AuditService.LogModificationAsync` |
| Quem assinou | `requests.doctor_id`, `signed_at`; `audit_logs` action "Sign" em `MedicalDocument` | `SignedRequestClinicalSyncService` |
| Quando | `audit_logs.event_timestamp`, `created_at`; `prescriptions.issued_at` | |
| IP / device | `audit_logs.ip_address`, `user_agent`; `prescription_verification_logs.ip`, `user_agent` | Verificação pública registra IP/UA |
| Hash do código de verificação | `prescriptions.verify_code_hash` (SHA256 do código 6 dígitos) | Não é hash do PDF |
| Hash de assinatura | `medical_documents.signature_hash` | Baseado em `signedDocumentUrl + signatureId`, não no conteúdo do PDF |
| old_values / new_values | `audit_logs.old_values`, `new_values` (JSONB) | Para auditoria de edições no prontuário |
| correlation_id | `audit_logs`, `prescription_verification_logs` | Rastreamento de requisições |

### 2.2 Lacunas recomendadas

| Lacuna | Status | Implementação |
|--------|--------|---------------|
| **Hash do PDF (conteúdo)** | ✅ | Coluna `pdf_hash` em `prescriptions` (`MigrationRunner.cs`). `DigitalCertificateService` calcula SHA-256 **sobre os bytes do PDF já assinado** e devolve em `DigitalSignatureResult.SignedPdfHash`; `PrescriptionVerifyRepository` persiste. Ou seja: o hash cobre o conteúdo, não a URL — que era exatamente a lacuna original |
| **Imutabilidade dos logs** | ✅ | Grupo de migration `audit_append_only`: `prevent_audit_log_modification()` + triggers BEFORE UPDATE/DELETE em `audit_logs`, `audit_events` e `prescription_verification_logs`. Único carve-out: `user_id` → NULL (anonimização do direito ao esquecimento, LGPD Art. 18, VI), com o resto da linha inalterado. Vale a partir do primeiro startup após o deploy. |
| **Device fingerprint** | ⚠️ | Opcional: em cenários de alto risco, registrar fingerprint do dispositivo em `metadata` do audit. |

---

## 3. Verificação pública (QR + página)

| Requisito | Status | Implementação |
|-----------|--------|---------------|
| QR Code no PDF | ✅ | URL codificada: `/verify/<id>?v=<token>` |
| Página de verificação | ✅ | `frontend-web` rota `/verify/:id`; `POST /api/prescriptions/verify` |
| Código de 6 dígitos | ✅ | `verify_code_hash` (SHA256) em `prescriptions` |
| Log de tentativas | ✅ | `prescription_verification_logs` — outcome, IP, user_agent |
| Download 2ª via | ✅ | Signed URL do Storage ou endpoint `/api/verify/{id}/document?code=xxx` |
| Integração ITI | ✅ | `GET /api/verify/{id}?type=prescricao&_format=application/validador-iti+json&_secretCode=CODIGO` |

---

## 4. Política anti-fraude

### 4.1 Validação de identidade do paciente

| Nível de risco | O que existe | Recomendação |
|----------------|--------------|--------------|
| Receita simples | CPF em `users`; triagem por IA | Documentar fluxo de verificação de CPF (ex.: validação em cadastro). |
| Receita controlada | Mesmo fluxo | **Reforçar:** validação de CPF obrigatória antes de aprovar controlados; possível 2FA ou confirmação de identidade. |
| Receita azul | Ainda não liberada | Definir requisitos antes de lançar. |

### 4.2 Bloqueios para receitas indevidas

| Controle | Status | Observação |
|----------|--------|------------|
| Triagem por IA | ✅ | `OpenAiReadingService` — `signs_of_tampering`, `prescription_type_detected`, `has_doubts` |
| Tipo de receita obrigatório | ✅ | `prescriptionType` obrigatório (simples/controlado) |
| Validação de certificado | ✅ | Certificado ICP-Brasil obrigatório para assinar |
| Bloqueio por medicamento controlado | ⚠️ | Não há lista de medicamentos controlados (Portaria 344) para validação automática |

---

## 5. Atenção especial: controlados (Portaria 344/98)

### 5.1 Contexto regulatório

- **Portaria 344/98** e normativas correlatas (RDC 66/2016, etc.) regulam medicamentos sujeitos a controle especial.
- Regras de dispensação em farmácia podem exigir:
  - Receita em 2 vias (1ª e 2ª via)
  - Validade específica (ex.: 30 dias para alguns controlados)
  - Retenção da 1ª via na farmácia
  - Notificação em sistemas de controle (SNGPC)

### 5.2 O que o sistema já faz

- `prescription_type = 'controlado'` com layout e avisos específicos no PDF
- Orientação ao paciente sobre retorno regular ao médico
- Preço diferenciado e fluxo de aprovação

### 5.3 Recomendação

> **Revisão jurídica específica** para o fluxo de receitas controladas. É o ponto com maior risco regulatório e onde mais surgem questionamentos. Sugestões:
>
> 1. Consultar advogado especializado em direito sanitário/farmacêutico.
> 2. Validar conformidade com RDC 44/2009 (receita em meio eletrônico) e normativas vigentes.
> 3. Avaliar necessidade de integração com SNGPC ou sistemas de notificação.
> 4. Documentar política de retenção e arquivamento de receitas controladas.

---

## 6. Resumo executivo

| Área | Situação | Ação sugerida |
|------|----------|---------------|
| Assinatura ICP-Brasil | ⚠️ **Bloqueada** (corrigido em 22/08/2026; dizia "✅ Conforme") | Popular `infra/icp-brasil/roots/` com as AC Raiz e registrar os thumbprints; ativar a ACT SERPRO (credenciais no SSM + `TimestampProvider=serpro` — o código já suporta, está desligado); **então** validar um PDF real no validar.iti.gov.br e guardar o comprovante |
| Trilha de auditoria | ✅ Conforme | As duas lacunas da seção 2.2 foram fechadas: `pdf_hash` sobre o conteúdo e imutabilidade por trigger. Resta o *device fingerprint*, que é opcional |
| Verificação pública | ✅ Conforme | Manter |
| Anti-fraude / identidade | ⚠️ Parcial | Documentar fluxo de validação de CPF; reforçar para controlados |
| Controlados (Portaria 344) | ⚠️ Atenção | **Revisão jurídica específica** antes de ampliar oferta. Segue sem lista local de substâncias para bloqueio automático — [PENDENCIAS_TI.md §4.3](../PENDENCIAS_TI.md) |

> **Correção de 01/08/2026.** Esta tabela ainda mandava "adicionar `pdf_hash`" e
> "avaliar imutabilidade dos logs" — as duas coisas que a seção 2.2, logo acima,
> já marcava como ✅. O resumo executivo estava mais desatualizado que o corpo do
> documento, que é o pior lugar para a defasagem estar: resumo é o que se lê.

---

## 7. Arquivos de referência no projeto

> **Estes caminhos foram reescritos em 01/08/2026.** Três deles estavam
> corrompidos por uma substituição em massa mal-feita, no formato
> `.../MigrationRunner.cs20260219000001_create_prescriptions_and_logs.sql` —
> concatenação do arquivo novo com o nome do arquivo antigo. Os `.sql` avulsos
> deixaram de existir quando o schema passou a ter fonte única no
> `MigrationRunner.cs`; não há mais um arquivo por migration para citar.

- `backend-dotnet/src/RenoveJa.Infrastructure/Certificates/DigitalCertificateService.cs` — assinatura PAdES, OIDs ITI e cálculo do `pdf_hash`
- `backend-dotnet/src/RenoveJa.Api/Controllers/VerificationController.cs` e `DocumentVerifyController.cs` — verificação pública (`POST /api/prescriptions/verify`, `POST /api/documents/verify`)
- `backend-dotnet/src/RenoveJa.Infrastructure/Data/Postgres/MigrationRunner.cs` — schema **canônico**, executado no boot: `prescriptions`, `audit_logs` (com `old_values`/`new_values`), `prescription_verification_logs` e os grupos `audit_append_only` e `clinical_record_retention`. ⚠️ **Corrigido em 22/08/2026: não é "fonte única".** Há três fontes divergentes — este runner, o SQL manual de `infra/migrations/` (56 arquivos, incluindo a ativação de RLS que roda **fora** do runner) e `infra/schema.sql`, dump do banco em 17/03/2026 já defasado. Conferir as três antes de afirmar estrutura de tabela
- `backend-dotnet/src/RenoveJa.Infrastructure/Repositories/PrescriptionVerifyRepository.cs` — persistência do `pdf_hash` e do `verify_code_hash`
- `docs/guides/CONFIG_ITI.md` — configuração ITI
