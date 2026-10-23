# Plano de homologações externas

- **Versão:** 1.0 (2026-10-23)
- **Regra:** cada item só vira "homologado" com **evidência do órgão ou do parceiro externo** (relatório, protocolo, certificado, e-mail oficial). Teste interno verde não conta.

Status possíveis: `NÃO INICIADO` · `EM PREPARO` · `SUBMETIDO` · `HOMOLOGADO (evidência: …)` · `BLOQUEADO (motivo)`.

## 2.1 Assinatura PAdES ICP-Brasil — validador oficial do ITI

| | |
|---|---|
| **O que já existe** | `POST /prescriptions/:id/sign-pades`. Cadeia validada contra o trust store oficial (`certs/icp-brasil`), CMS embarcado com ByteRange, OIDs do Guia ITI, OCSP opcional, ACT opcional. Rota do validador `/verify/:id`. E2E com CA de teste. |
| **O que falta** | Certificado ICP-Brasil **real** (A1 ou A3/nuvem) de um médico voluntário, emissão de um PDF sintético e validação em https://validar.iti.gov.br |
| **Passos** | 1) Adquirir o certificado (A3 em nuvem recomendado: a chave não sai do HSM). 2) Integrar a assinatura remota com o provedor (substituir o envio de PEM da chave, que é só para MVP). 3) Emitir uma receita sintética ("PACIENTE FICTÍCIO"). 4) Validar no ITI e salvar o relatório em PDF em `docs/estudo/evidencias/`. 5) Testar com certificado revogado e expirado (deve recusar). |
| **Critério de aceite** | Relatório do ITI "assinatura válida" + conformidade com a política, e recusas corretas nos casos negativos. |
| **Dono / prazo** | Engenharia + médico voluntário · 2–4 semanas após o certificado. |

## 2.2 Carimbo do tempo (ACT credenciada)

| | |
|---|---|
| **O que existe** | Cliente RFC 3161 (`pki/tsa.ts`) configurável por env; falha fechada. |
| **Falta** | Contrato com ACT credenciada na ICP-Brasil, credencial, teste real, e o carimbo reconhecido pelo validador do ITI. |
| **Aceite** | PDF com carimbo reconhecido no relatório do ITI. |

## 2.3 SNCR — Anvisa (receita de controle especial)

| | |
|---|---|
| **O que existe** | Bloqueio em 409 de `controlled_special`, guarda por substância (Portaria 344) e readiness em `docs/regulatory/SNCR_ANVISA_READINESS.md`. |
| **Falta** | Cadastro do software/empresa conforme as regras vigentes do SNCR, ambiente de homologação, credenciais, integração (numeração, emissão, cancelamento) e testes de concorrência e idempotência da numeração. |
| **Atenção** | Conferir a norma **vigente na data** (a transição eletrônica começou em 30/09/2026). Até homologar, o controle especial continua desligado. |
| **Aceite** | Receitas emitidas em homologação aceitas pelo SNCR, com numeração única sob concorrência. |

## 2.4 RNDS — Ministério da Saúde

| | |
|---|---|
| **O que existe** | Mappers FHIR R4, validador oficial no CI (7 fixtures + gate negativo), identificadores CPF/CNS com NamingSystems da RNDS. |
| **Falta** | Credenciamento do estabelecimento (CNES), certificado digital da instituição, ambiente de homologação, perfis BR exigidos pelo caso de uso (ex.: RAC, resultado de exame) e envio e consulta reais. |
| **Aceite** | Bundle aceito em homologação com o identificador de retorno arquivado. **Aceite de transporte ≠ aceite semântico:** conferir o status de processamento. |

## 2.5 Certificação SBIS (S-RES)

| | |
|---|---|
| **O que existe** | `docs/regulatory/MATRIZ_NGS2_SRES.md` e `MATRIZ_NGS2_EVIDENCIAS_STARMED.md`. |
| **Passos** | 1) Escolher a categoria (Consultório / Clínica-Ambulatório; Receita Digital depende do 2.1). 2) Baixar o manual **vigente** no portal da SBIS e refazer o gap analysis requisito a requisito. 3) Fechar os gaps NGS1/NGS2. 4) Auditoria de pré-certificação (consultoria). 5) Submissão. |
| **Aceite** | Certificado SBIS emitido. Até lá, é **proibido** dizer "certificado SBIS". |

## 2.6 Pentest independente

| | |
|---|---|
| **Escopo** | API, web, portal do paciente, rotas públicas (`/rx-verify`, `/verify`), teleconsulta, autenticação/MFA/SSO, multi-tenant (BOLA/IDOR cruzado), upload e PDF, rate limit. |
| **Regras** | Ambiente de **staging** com dados sintéticos; janela, contatos e limites por escrito; nada contra produção ou terceiros. |
| **Entregáveis do fornecedor** | Relatório com CVSS + **impacto clínico**, provas de conceito, e **reteste** das correções. |
| **Aceite** | 0 crítico/alto aberto; médios com dono e prazo. |
| **Seleção** | Empresa sem conflito de interesse, com experiência em saúde e referência verificável. |

## 2.7 Outros (conforme o modelo de negócio)

- **TISS/ANS:** homologação com cada operadora contratante (XSD já validado no CI).
- **NFS-e:** por município.
- **LGPD:** não há "certificação". Exige parecer jurídico, RIPD e checklist (`docs/regulatory/CHECKLIST_LGPD_ANPD.md`).
- **ANVISA/SaMD:** avaliar com especialista se alguma função de apoio à decisão (alertas de segurança, IA) enquadra o software como dispositivo médico **antes** de anunciá-la como função clínica.
