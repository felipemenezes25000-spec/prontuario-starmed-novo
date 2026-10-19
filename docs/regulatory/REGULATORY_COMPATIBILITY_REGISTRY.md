# Registro de compatibilidade regulatória

> Gerado de `docs/compliance/regulatory-compatibility-registry.json` por `scripts/health-os-registry.mjs --write` — não edite à mão.
> Atualizado em 2026-09-25. Estados do §0.1 da especificação-mãe; `IMPLEMENTADO` nunca é `HOMOLOGADO`.

| Id | Padrão / integração | Estado | Homologado | Produção | Bloqueio | Validade | Conferir até |
|---|---|---|---|---|---|---|---|
| `rnds.transport` | RNDS — transporte FHIR R4 (POST de Bundle, protocolo pelo Location) | TESTADO | não | não | credenciamento RNDS por estabelecimento, certificado ICP-Brasil e perfis homologados | não publicada | 2026-12-31 |
| `rnds.model.RAC` | RNDS — RAC (Registro de Atendimento Clínico) | PARCIAL | não | não | RNDS_OFFICIAL_MODEL_REQUIRED — mapper do perfil oficial não incorporado | não publicada | 2026-12-31 |
| `rnds.model.REL` | RNDS — REL (Registro de Exame Laboratorial) | PARCIAL | não | não | RNDS_OFFICIAL_MODEL_REQUIRED | não publicada | 2026-12-31 |
| `rnds.model.RIA` | RNDS — RIA (Registro de Imunobiológico Administrado) | PLANEJADO | não | não | vacinação segue local_only; perfil oficial e credencial RNDS | não publicada | 2026-12-31 |
| `rnds.model.RIRA` | RNDS — RIRA (Registro de Informação de Regulação Assistencial) | PARCIAL | não | não | RNDS_OFFICIAL_MODEL_REQUIRED | não publicada | 2026-12-31 |
| `esus.ledi.4.0` | e-SUS APS — LEDI família 4.0 (PEC 4.0–4.5) | PARCIAL | não | não | LEDI_OFFICIAL_ARTIFACT_REQUIRED — serializador oficial da versão contratada | não publicada | 2026-12-31 |
| `esus.ledi.5.0` | e-SUS APS — LEDI família 5.0 (PEC 5.0–5.2) | PARCIAL | não | não | LEDI_OFFICIAL_ARTIFACT_REQUIRED | não publicada | 2026-12-31 |
| `esus.ledi.5.3` | e-SUS APS — LEDI família 5.3 (PEC 5.3–5.4) via API para sistemas próprios | PARCIAL | não | não | credencial do PEC de cada município (API de recebimento) e identificação da instalação (Ledi:Instalacao: contra-chave, CPF/CNPJ, razão social); dados da finalização do atendimento (local, turno, tipo, conduta) ainda não chegam ao mapeador da FAI | não publicada | 2026-12-31 |
| `cadsus.pdq` | CADSUS — consulta PDQ de identidade (CNS) | TESTADO | não | não | credencial de homologação/produção do ente | não publicada | 2026-12-31 |
| `cnes.soa` | CNES — barramento SOA público (estabelecimento, profissional, vínculo) | TESTADO | não | não | — | não publicada | 2026-12-31 |
| `sigtap.soa` | SIGTAP — consulta de competência e procedimentos (SOA) | IMPLEMENTADO | não | não | — | não publicada | 2026-12-31 |
| `obm` | OBM — Ontologia Brasileira de Medicamentos | IMPLEMENTADO | não | não | — | não publicada | 2026-12-31 |
| `bnafar` | SI-BNAFAR — transmissão D-1 de entradas, saídas e dispensações | NÃO COMPROVADO | não | não | contrato técnico e credencial do ente; circuito completo ainda não construído | não publicada | 2026-12-31 |
| `sia.bpa` | SIA — BPA-C / BPA-I | NÃO COMPROVADO | não | não | gerador e pré-glosa ainda não construídos | não publicada | 2026-12-31 |
| `sia.apac_raas` | SIA — APAC / RAAS | NÃO COMPROVADO | não | não | não construído | não publicada | 2026-12-31 |
| `sih.aih` | SIH — AIH | NÃO COMPROVADO | não | não | não construído | não publicada | 2026-12-31 |
| `regulation.sisreg` | SISREG / e-SUS Regulação — leitura e reconciliação do protocolo externo | TESTADO | não | não | ENVIO da solicitação depende de credencial e contrato de interface | não publicada | 2026-12-31 |
| `pec.external` | PEC de terceiro — lançamento assinado (launch_only) | IMPLEMENTADO | não | não | leitura/escrita dependem do contrato técnico do PEC do município | não publicada | 2026-12-31 |
| `si-pni` | SI-PNI — registro oficial de vacinação | PLANEJADO | não | não | fronteira declarada; vacinação segue local_only | não publicada | 2026-12-31 |
| `tiss` | ANS — Padrão TISS (componentes organizacional, conteúdo, comunicação) | NÃO COMPROVADO | não | não | não construído; XSD oficial da versão vigente não está no repositório | não publicada | 2026-12-31 |
| `tuss` | ANS — TUSS (terminologia) | NÃO COMPROVADO | não | não | não construído | não publicada | 2026-12-31 |
| `icp-brasil.pades` | ICP-Brasil — assinatura PAdES e validação de cadeia | TESTADO | não | não | validação externa (ITI) da implementação não registrada | não publicada | 2026-12-31 |
| `serpro.tsa` | SERPRO — carimbo de tempo (ACT) | IMPLEMENTADO | não | não | credencial da ACT | não publicada | 2026-12-31 |
| `anvisa.sncr` | Anvisa SNCR — numeração de receituário controlado | IMPLEMENTADO | não | não | homologação conforme SNCR_HOMOLOGATION_RUNBOOK.md | não publicada | 2026-12-31 |
| `dicomweb.pacs` | DICOMweb / PACS — telediagnóstico | TESTADO | não | não | PACS do contratante | não publicada | 2026-12-31 |
| `hl7v2` | HL7 v2 (ADT/ORM/ORU) | PLANEJADO | não | não | fronteira declarada; contrato técnico do parceiro | não publicada | 2026-12-31 |
| `sbis.sres` | SBIS S-RES — certificação do PEP | NÃO COMPROVADO | não | não | avaliação externa; MATRIZ_NGS2_SRES.md registra a aderência pretendida | não publicada | 2026-12-31 |
| `anvisa.samd` | ANVISA RDC 657/2022 — enquadramento de Software como Dispositivo Médico | NÃO COMPROVADO | não | não | avaliação regulatória por funcionalidade de IA clínica antes de release (§13.7) | não publicada | 2026-12-31 |

## Fontes oficiais

- https://integracao.esusaps.bridge.ufsc.tech/v530/
- https://sbis.org.br/certificacoes/certificacao-software/categorias-e-modalidades-certificaveis/
- https://sisaps.saude.gov.br/sistemas/esusaps/docs/manual/APOIO/API_transmissao/
- https://sisaps.saude.gov.br/sistemas/esusaps/docs/versoes/versao_5_3/
- https://wiki.saude.gov.br/sia/index.php/P%C3%A1gina_principal
- https://wiki.saude.gov.br/sigtap/index.php/Gerais
- https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss
- https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/codigos-da-tuss
- https://www.gov.br/anvisa/pt-br/centraisdeconteudo/publicacoes/produtos-para-a-saude/manuais/software-como-dispositivo-medico-perguntas-e-respostas
- https://www.gov.br/saude/pt-br/acesso-a-informacao/gestao-do-sus/programacao-regulacao-controle-e-financiamento-da-mac/sistemas-de-informacao-em-saude
- https://www.gov.br/saude/pt-br/composicao/saps/publicacoes/notas-tecnicas-e-informativas/nota-tecnica-no-32-2026-cgsb-desf-saps-ms
- https://www.gov.br/saude/pt-br/composicao/sectics/daf/bnafar/faq/faq
- https://www.gov.br/saude/pt-br/composicao/sectics/daf/bnafar/faq/faq/o-que-foi-estabelecido-pela-1
- https://www.gov.br/saude/pt-br/composicao/seidigi/rnds/estrutura-do-projeto
