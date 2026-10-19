# STARMED — MASTER SPECIFICATION

> **Documento-mãe de produto, arquitetura, interoperabilidade, compliance, UX, IA, operação e qualidade**  
> **Branch de referência:** `PROJETO-STARMED`  
> **Data-base:** 23/09/2026  
> **Status:** especificação normativa de evolução do produto  
> **Objetivo:** transformar o STARMED em uma plataforma clínica universal — SUS + saúde suplementar + rede privada + hospitalar + diagnóstico + farmácia + gestão — com interoperabilidade nativa, segurança de nível crítico e uma experiência de uso radicalmente superior aos HIS/EHR tradicionais.

---

## 0. Como ler e usar este documento

Este arquivo não é um brainstorming, nem um roadmap comercial genérico. Ele deve funcionar como **constituição técnica e funcional do STARMED**.

Toda nova feature, refatoração, integração, tela, endpoint, migration ou decisão arquitetural deve responder a quatro perguntas:

1. **Qual requisito deste documento ela atende?**
2. **Qual risco clínico, operacional, regulatório ou técnico ela introduz?**
3. **Como ela será testada?**
4. **Qual evidência prova que está pronta?**

### 0.1 Estados oficiais de maturidade

Nenhuma capacidade poderá ser declarada “pronta” apenas porque existe código.

| Estado | Significado |
|---|---|
| `NÃO COMPROVADO` | não localizado ou não validado na leitura atual do repositório |
| `PLANEJADO` | especificado, mas sem implementação comprovada |
| `PARCIAL` | existe fundação, porém o fluxo completo ainda não foi comprovado |
| `IMPLEMENTADO` | implementação de código localizada |
| `TESTADO` | possui teste automatizado relevante executável |
| `INTEGRADO` | integração ponta a ponta demonstrada em ambiente controlado |
| `HOMOLOGADO` | homologação externa formal concluída quando aplicável |
| `PRODUÇÃO` | liberado, monitorado e operado em ambiente real |
| `CERTIFICADO` | certificado por entidade externa quando aplicável |

**Regra:** `IMPLEMENTADO` nunca deve ser usado como sinônimo de `HOMOLOGADO`, `PRODUÇÃO` ou `CERTIFICADO`.

### 0.2 Prioridades

- **P0 — Bloqueador de segurança/arquitetura/release.**
- **P1 — Essencial para operação clínica ou institucional séria.**
- **P2 — Diferencial relevante e expansão de cobertura.**
- **P3 — Otimização, inteligência e escala avançada.**

---

# 1. VISÃO: STARMED HEALTH OS

O STARMED não deve ser tratado como “mais um prontuário eletrônico”.

A visão de produto é um **Health Operating System** capaz de sustentar, no mesmo núcleo de dados e segurança:

- Atenção Primária à Saúde;
- UBS e USF;
- policlínicas e especialidades;
- UPA e pronto-socorro;
- hospitais públicos;
- hospitais privados;
- clínicas e redes ambulatoriais;
- laboratórios;
- radiologia e diagnóstico por imagem;
- telessaúde;
- telediagnóstico;
- assistência farmacêutica;
- estoque e supply chain;
- regulação;
- internação;
- UTI;
- centro cirúrgico;
- oncologia;
- hemodiálise;
- maternidade e neonatologia;
- reabilitação;
- atenção domiciliar;
- gestão populacional;
- gestão municipal/estadual;
- faturamento SUS;
- saúde suplementar/TISS;
- revenue cycle privado;
- auditoria;
- inteligência operacional;
- IA clínica assistiva;
- portais e aplicativos para pacientes/cidadãos.

## 1.1 Princípio estrutural

Não criar produtos independentes e duplicados como:

- “StarMed SUS”;
- “StarMed Hospital”;
- “StarMed Clínica”;
- “StarMed Convênio”.

Criar **um único núcleo canônico** e pacotes ativáveis por contexto:

```text
STARMED CORE
├── Public Health Pack
├── APS Pack
├── Hospital Pack
├── Emergency Pack
├── Ambulatory Pack
├── Diagnostic Pack
├── Pharmacy Pack
├── Supply Chain Pack
├── Private Billing Pack
├── SUS Billing Pack
├── Telehealth Pack
├── Telediagnostics Pack
├── Population Health Pack
├── Intelligence Pack
└── Developer / Interoperability Platform
```

## 1.2 Princípios inegociáveis

1. **Paciente/cidadão é o centro do modelo, não a tela ou o módulo.**
2. **O prontuário longitudinal é único.**
3. **Interoperabilidade é core, não plugin tardio.**
4. **Toda informação clínica relevante deve ser auditável e versionável.**
5. **Nenhum dado clínico pode ser perdido silenciosamente.**
6. **Nenhuma ação clínica gerada por IA deve ser executada silenciosamente.**
7. **Todo dado de IA que influencie decisão deve ser rastreável à evidência de origem.**
8. **Segurança deve ser aplicada em aplicação, banco, infraestrutura e operação.**
9. **Demo/mock/fake deve ser estruturalmente impossível em produção.**
10. **Acessibilidade é requisito de release.**
11. **Mobile não pode ser apenas uma versão espremida do desktop.**
12. **Toda integração regulatória deve ser versionada.**
13. **O sistema deve funcionar em redes com conectividade degradada onde o contexto permitir.**
14. **Cada profissão deve receber uma experiência adaptada ao seu trabalho.**
15. **Nenhuma feature nova deve piorar a carga cognitiva sem justificativa mensurável.**

---

# 2. BASELINE REAL DO REPOSITÓRIO EM 23/09/2026

A branch já contém fundações relevantes e não deve ser reescrita do zero.

## 2.1 Frontend comprovado

O `frontend-web/src` possui shells separados para:

- `App.tsx`;
- `DoctorApp.tsx`;
- `ManagerApp.tsx`;
- `PatientApp.tsx`;
- `ProfessionalApp.tsx`;
- `UbsApp.tsx`.

Também existem estruturas horizontais (`components`, `contexts`, `hooks`, `pages`, `services`, `types`) e uma evolução para arquitetura por feature em `features/`, hoje ainda parcial.

### Decisão arquitetural

Novos módulos de negócio devem preferir:

```text
src/features/<dominio>/
├── api/
├── components/
├── hooks/
├── pages/
├── schemas/
├── state/
├── types/
└── tests/
```

Shared code deve ir para `src/shared` ou equivalente claramente neutro.

## 2.2 Backend comprovado

A branch possui backend .NET 8 com controllers e stores específicos do STARMED, incluindo fundações para:

- APS;
- diretório profissional APS;
- prontuário clínico;
- FHIR Lite;
- laboratório;
- importação de legado;
- master data;
- operação;
- farmácia;
- atendimento presencial;
- regulação;
- fila UBS.

Também há infraestrutura concreta para:

- CADSUS/PDQ;
- CNES;
- DATASUS;
- e-SUS APS;
- RNDS;
- SIGTAP;
- OBM;
- ICP-Brasil/PAdES;
- carimbo de tempo SERPRO;
- DICOM/DICOMweb/PACS;
- Redis/distributed lock;
- SQS;
- S3;
- observabilidade;
- LGPD/retention;
- IA clínica;
- transcrição;
- vídeo;
- WhatsApp;
- auditoria pública.

## 2.3 Stores STARMED já encontrados

Entre outros:

- `StarMedApsStore`;
- `StarMedApsCareStore`;
- `StarMedApsProfessionalDirectoryStore`;
- `StarMedApsTerritoryHistoryStore`;
- `StarMedLaboratoryStore`;
- `StarMedPharmacyStockStore`;
- `StarMedPresentialCareStore`;
- `StarMedRegulationStore`;
- `StarMedUbsQueueStore`;
- `StarMedMasterDataQualityStore`;
- família `StarMedLegacy*` para migração e reconciliação.

## 2.4 Segurança e dados já encontrados

Existem fundações de RLS e isolamento no PostgreSQL, incluindo:

- `DatabaseSessionContext`;
- `RlsEnforcementProbe`;
- migrations RLS;
- RLS de interoperabilidade SUS;
- RLS de telediagnóstico;
- RLS de documentos profissionais.

Existem também:

- retenção de dados;
- planos de erasure LGPD;
- purge de storage;
- audit logs;
- access logs;
- MFA store;
- evidence ledger.

## 2.5 Testes já encontrados

Há suítes separadas de:

- unit tests;
- integration tests;
- architecture tests.

A suíte de integração já contém testes relacionados a:

- CADSUS;
- isolamento/session context;
- concorrência clínica;
- encaminhamento/contrarreferência;
- e-SUS targets;
- locks distribuídos;
- evidência;
- operação cidadã;
- fiscal/reconciliação;
- Health OS Intelligence.

## 2.6 CI/CD atual

O CI possui:

- gitleaks;
- Semgrep;
- OWASP rules;
- C#;
- TypeScript/React;
- secrets scanning;
- .NET restore/build/test;
- PostgreSQL real em integração;
- Redis real em integração;
- cobertura;
- frontend lint/build/test;
- Playwright E2E e acessibilidade em PR;
- mobile typecheck/lint/test/build;
- Terraform validate;
- Trivy/IaC.

### Gap P0

O workflow principal reage a PR e push em `main`; push direto em `PROJETO-STARMED` não é atualmente a mesma garantia. A branch consultada não possuía execução de Actions no histórico verificado.

**Requisito P0:** toda alteração destinada ao STARMED deve passar por PR ou a branch deve ser adicionada explicitamente ao gate de CI.

## 2.7 Dívidas arquiteturais localizadas

- `OpenAiReadingService.cs` está muito grande e deve ser decomposto por capacidade.
- `MigrationRunner.cs` está muito grande e deve evoluir para runner pequeno + migrations versionadas independentes.
- existem implementações `Demo` e `Fakes`; produção deve impedir seu carregamento por construção.
- frontend está entre arquitetura horizontal e feature-first; deve convergir.
- documentação e implementação precisam de uma única matriz de maturidade.

---

# 3. ARQUITETURA DE REFERÊNCIA

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                             EXPERIENCE LAYER                                 │
│ Web • Mobile • Patient • Citizen • Clinical • Nursing • Pharmacy • Manager │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼───────────────────────────────────────────┐
│                      CLINICAL / OPERATIONAL PLATFORM                        │
│ Patient • Encounter • Orders • Results • Medications • CarePlan • Tasks    │
│ ADT • Queue • Beds • Surgery • Lab • Imaging • Pharmacy • Regulation       │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼───────────────────────────────────────────┐
│                         HEALTH DATA FABRIC                                  │
│ MPI • MDM • Terminology • FHIR • HL7 • DICOM • Events • Consent • Audit   │
└────────────────────┬─────────────────────────┬───────────────────────────────┘
                     │                         │
        ┌────────────▼──────────┐   ┌─────────▼──────────────────────────────┐
        │ PUBLIC HEALTH BRASIL │   │ PRIVATE / HOSPITAL / ECOSYSTEM        │
        │ RNDS • e-SUS • CNES  │   │ TISS • TUSS • Payers • Devices       │
        │ CADSUS • BNAFAR      │   │ Labs • PACS • Partners • APIs        │
        │ SIGTAP • SIA/SIH     │   │                                      │
        └────────────┬──────────┘   └─────────┬──────────────────────────────┘
                     │                         │
┌────────────────────▼─────────────────────────▼───────────────────────────────┐
│                             PLATFORM CORE                                   │
│ AuthN/AuthZ • RBAC/ABAC • RLS • Audit • Event Bus • Jobs • Cache • Files  │
│ Observability • Feature Flags • Config • Tenant • Secrets • Resilience      │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 3.1 Estilo de backend

Preferência: **modular monolith rigoroso**, com bounded contexts claros e possibilidade de extração futura onde houver motivo operacional real.

Evitar microserviços prematuros.

### Bounded contexts propostos

- Identity & Access;
- Master Patient / Citizen;
- Clinical Record;
- Orders & Results;
- Medication & Pharmacy;
- Scheduling;
- APS;
- Emergency;
- Inpatient/ADT;
- Nursing;
- Surgery;
- Laboratory;
- Imaging;
- Regulation;
- Public Health Interop;
- Private Billing;
- SUS Billing;
- Supply Chain;
- Assets;
- Telehealth;
- Telediagnostics;
- Population Health;
- Intelligence;
- Audit & Compliance;
- Notifications;
- Documents & Signatures.

## 3.2 Regras de dependência

- Domain não depende de Infrastructure.
- Application depende de contratos, não de adapters concretos.
- API não acessa SQL diretamente.
- Integrações externas devem viver atrás de portas/adapters.
- Eventos críticos devem possuir idempotência.
- Escritas clínicas precisam de controle de concorrência.
- Cada bounded context possui ownership explícito de dados.

---

# 4. MODELO CLÍNICO CANÔNICO

O STARMED deve possuir um modelo interno estável e mapear padrões externos para ele. Não modelar a base inteira diretamente como payload de um parceiro externo.

## 4.1 Entidades nucleares

### Identity

- Person;
- Patient/Citizen;
- Practitioner;
- PractitionerRole;
- RelatedPerson;
- Organization;
- Location;
- HealthcareService;
- Device.

### Clinical

- Encounter;
- EpisodeOfCare;
- Problem/Condition;
- AllergyIntolerance;
- Observation;
- VitalSigns;
- Procedure;
- CarePlan;
- Goal;
- ClinicalNote;
- Questionnaire/Response;
- FamilyHistory;
- SocialHistory;
- RiskAssessment;
- ClinicalImpression.

### Orders

- ServiceRequest;
- MedicationRequest;
- DiagnosticOrder;
- Referral;
- ProcedureOrder;
- SupplyRequest.

### Results

- DiagnosticReport;
- ObservationResult;
- ImagingStudy;
- PathologyResult;
- DocumentReference.

### Medication

- Medication;
- MedicationKnowledge;
- Prescription;
- Dispense;
- Administration;
- MedicationReconciliation;
- PharmacyValidation.

### Administrative

- Appointment;
- Schedule;
- Slot;
- QueueTicket;
- Admission;
- Transfer;
- Discharge;
- BedAssignment;
- Claim;
- Invoice;
- Authorization.

## 4.2 Requisitos de prontuário longitudinal

`CLN-001` — Todo evento assistencial relevante deve integrar a timeline longitudinal.  
`CLN-002` — Toda alteração posterior a assinatura deve preservar versão anterior.  
`CLN-003` — Correção não pode destruir evidência original.  
`CLN-004` — Deve existir autor, horário, origem, contexto, estabelecimento e sessão.  
`CLN-005` — Conteúdo externo deve carregar provenance.  
`CLN-006` — Dados importados devem ser marcados como importados e ligados à origem.  
`CLN-007` — O sistema deve distinguir informação confirmada, referida, inferida e gerada por IA.  
`CLN-008` — Evidência clínica crítica deve possuir source link/ID interno.  
`CLN-009` — Assinaturas eletrônicas devem ser verificáveis.  
`CLN-010` — Informações clínicas devem ser exportáveis em formato estruturado e legível.

---

# 5. MPI — MASTER PATIENT INDEX E IDENTIDADE

Um prontuário universal não pode assumir que CPF sozinho identifica uma pessoa de forma perfeita.

## 5.1 Identificadores

Suportar múltiplos identificadores simultâneos:

- CPF;
- CNS;
- RG quando aplicável;
- passaporte/documento estrangeiro;
- identificador municipal;
- identificador hospitalar;
- identificador do convênio;
- identificadores legados;
- identificadores RNDS/FHIR;
- identificadores de sistemas externos.

## 5.2 Identity Resolution

`MPI-001` — matching determinístico e probabilístico configurável.  
`MPI-002` — detecção de duplicidade.  
`MPI-003` — fila de revisão manual.  
`MPI-004` — merge seguro com evidência.  
`MPI-005` — unmerge/reversão auditada.  
`MPI-006` — nunca apagar silenciosamente identidades antigas.  
`MPI-007` — regras especiais para recém-nascido, desconhecido e trauma.  
`MPI-008` — proteção contra associação incorreta de prontuário.  
`MPI-009` — reconciliação CADSUS/CNS.  
`MPI-010` — qualidade de master data com score e pendências.

---

# 6. TERMINOLOGIA CLÍNICA E MASTER DATA

Criar **Terminology Service** central e versionado.

Suportar, conforme contexto/licenciamento/uso permitido:

- CID-10;
- evolução para CID-11 quando exigida/adotada;
- CIAP-2;
- SIGTAP;
- TUSS;
- OBM;
- LOINC;
- DCB;
- RENAME;
- REMUME;
- RESME;
- ATC;
- RxNorm quando útil e permitido;
- SNOMED CT quando houver base legal/licença/adoção aplicável;
- catálogos locais;
- códigos de dispositivos/UDI quando aplicável.

## 6.1 Regras

- nunca hardcode de terminologia dentro de componente de UI;
- guardar código + sistema + versão + display original;
- permitir crosswalks versionados;
- manter histórico de depreciação;
- validar códigos no momento adequado;
- evitar alterar retrospectivamente o significado de registros históricos.

---

# 7. SUS — PUBLIC HEALTH PACK

O STARMED deve ser capaz de ser o sistema principal de uma rede municipal e evoluir para cenários estaduais/regionalizados.

## 7.1 APS / UBS / USF

### Cadastro territorial

- cidadão;
- família;
- domicílio;
- endereço/georreferência conforme política;
- território;
- microárea;
- equipe;
- ACS;
- condições de moradia;
- vulnerabilidades;
- população adscrita;
- histórico de mudança de território.

### Jornada APS

- recepção;
- demanda espontânea;
- agendamento;
- acolhimento;
- triagem;
- enfermagem;
- medicina;
- odontologia;
- vacinação;
- curativos;
- procedimentos;
- farmácia;
- exames;
- encaminhamento;
- retorno;
- visita domiciliar;
- atividade coletiva;
- eMulti;
- plano terapêutico;
- cuidado compartilhado;
- contrarreferência;
- busca ativa.

### Linhas de cuidado mínimas

- hipertensão;
- diabetes;
- obesidade;
- tabagismo;
- pré-natal;
- puerpério;
- planejamento reprodutivo;
- saúde da criança;
- saúde do adolescente;
- saúde do homem;
- saúde da mulher;
- saúde do idoso;
- saúde mental;
- tuberculose;
- hanseníase;
- IST;
- doenças respiratórias;
- pacientes acamados;
- cuidados paliativos;
- reabilitação;
- saúde bucal;
- vacinação.

### Population gap engine

O sistema deve responder não apenas “quem veio”, mas “quem deveria ter vindo”.

Exemplos:

- diabético sem HbA1c no período esperado;
- gestante sem consulta programada;
- criança com vacina pendente;
- hipertenso sem aferição recente;
- paciente com resultado crítico sem revisão;
- usuário com encaminhamento vencendo SLA;
- pessoa com medicação contínua e falha de retirada.

## 7.2 Fila UBS em tempo real

Estados de referência:

```text
CHECK-IN
→ RECEPÇÃO
→ ACOLHIMENTO
→ TRIAGEM
→ AGUARDANDO PROFISSIONAL
→ EM ATENDIMENTO
→ PROCEDIMENTO / EXAME / MEDICAÇÃO
→ FINALIZAÇÃO
```

Suportar:

- prioridades;
- PCD/idosos/gestantes conforme regras aplicáveis;
- demanda espontânea;
- agendado;
- encaixe;
- risco clínico;
- tempos por etapa;
- abandono;
- no-show;
- redistribuição de fila;
- painel anonimizado;
- analytics de gargalo.

## 7.3 e-SUS APS / LEDI / Siaps

`SUS-ESUS-001` — tratar integração de sistemas próprios como requisito de primeira classe.  
`SUS-ESUS-002` — manter modelos LEDI por versão.  
`SUS-ESUS-003` — suportar transmissão via API conforme especificação vigente.  
`SUS-ESUS-004` — validar campos obrigatórios antes do envio.  
`SUS-ESUS-005` — registrar recibo, rejeição e motivo.  
`SUS-ESUS-006` — replay idempotente.  
`SUS-ESUS-007` — dashboard de qualidade dos registros.  
`SUS-ESUS-008` — impedir duplicidade de produção.  
`SUS-ESUS-009` — acompanhar versões aceitas pelo Siaps.  
`SUS-ESUS-010` — alertar quando versão/modelo estiver próximo de perder validade.

## 7.4 RNDS / FHIR

A interoperabilidade RNDS deve ser tratada como **núcleo de plataforma**, com modelos versionáveis.

Capacidades:

- autenticação/certificados conforme especificação vigente;
- FHIR validation;
- profiles oficiais;
- bundles quando aplicável;
- provenance;
- retry/idempotency;
- circuit breaker;
- observabilidade;
- fila de erro;
- reprocessamento;
- trilha de evidência;
- segregação homologação/produção.

### Modelos

A arquitetura deve ser extensível a modelos vigentes e futuros. A baseline inclui, quando aplicável:

- RAC — Registro de Atendimento Clínico;
- REL — Registro de Exame Laboratorial;
- RIA — Registro de Imunobiológico Administrado;
- RIRA — Registro de Informação de Regulação Assistencial;
- demais modelos oficiais que venham a ser incorporados.

**Regra:** cada modelo deve possuir `mapper + validator + version + fixtures + contract tests`.

## 7.5 CADSUS / CNS

- consulta/validação de identidade;
- PDQ conforme credenciamento disponível;
- cache somente quando permitido;
- reconciliação de retorno;
- métricas sem PII;
- circuit breaker;
- homologação separada de produção;
- auditoria de consulta;
- proteção contra associação de cidadão errado.

## 7.6 CNES

- estabelecimento;
- serviço;
- habilitação;
- equipe;
- profissional;
- vínculo;
- CBO;
- carga horária quando aplicável;
- sincronização e detecção de divergências;
- validade por competência;
- regras que bloqueiem faturamento/produção inconsistente.

## 7.7 Regulação

Criar regulação end-to-end:

```text
APS
→ solicitação
→ protocolo/regra
→ classificação
→ fila regulatória
→ autorização
→ oferta
→ agendamento
→ atendimento
→ contrarreferência
→ APS
```

Recursos:

- fila única;
- prioridade clínica;
- SLA;
- protocolos;
- anexos;
- devolução com justificativa;
- pendência;
- autorização;
- overbooking controlado;
- absenteísmo;
- remanejamento;
- oferta regional;
- gestão de cotas;
- mapa de espera;
- auditoria;
- integração com sistemas regulatórios externos quando necessária.

## 7.8 SIGTAP + produção SUS

O sistema precisa possuir um **SUS Rules & Billing Engine**.

Validar, conforme competência:

- código de procedimento;
- instrumento de registro;
- CNES;
- CBO;
- CID;
- idade;
- sexo quando aplicável;
- habilitação;
- serviço/classificação;
- compatibilidades;
- incompatibilidades;
- quantidades;
- concomitâncias;
- sequência;
- OPM;
- regras de competência.

### Produção ambulatorial/hospitalar

Suportar o necessário para cenários aplicáveis de:

- BPA-C;
- BPA-I;
- APAC;
- RAAS;
- AIH;
- SIA;
- SIH;
- exportações/arquivos/serviços exigidos pela competência vigente.

### Pré-glosa SUS

Antes de fechar produção, mostrar:

- inconsistências;
- provável rejeição;
- habilitação faltante;
- CBO incompatível;
- procedimento incompatível;
- dados obrigatórios ausentes;
- duplicidade.

## 7.9 Assistência farmacêutica / BNAFAR

A farmácia municipal é domínio clínico-operacional de primeira classe.

### Modelo de estoque

- produto;
- medicamento;
- apresentação;
- princípio ativo;
- OBM;
- RENAME;
- REMUME;
- RESME;
- demanda judicial;
- lote;
- validade;
- fabricante;
- fornecedor;
- nota/documento de entrada;
- estabelecimento;
- depósito;
- posição;
- movimentação;
- transferência;
- dispensação;
- perda;
- ajuste;
- devolução;
- inventário;
- quarentena;
- recall.

### SI-BNAFAR

O sistema deve ser preparado para os modelos oficiais vigentes, incluindo transmissão diária D-1 quando exigida.

Requisitos:

- REPE;
- RESMPE;
- dispensação conforme modelo vigente;
- OBM como referência terminológica quando exigida;
- validação antes de transmitir;
- receipts;
- retry;
- DLQ;
- reconciliação D-1;
- painel de pendências;
- impossibilidade de duplicar envio sem idempotência.

### Inteligência farmacêutica

- dias de cobertura;
- previsão de ruptura;
- curva ABC/XYZ;
- consumo médio;
- sazonalidade;
- vencimento próximo;
- perdas;
- lote crítico;
- sugestão de redistribuição;
- excesso em uma unidade e falta em outra;
- demanda reprimida;
- adesão/retirada quando clinicamente apropriado;
- custo por linha de cuidado.

## 7.10 CEAF

Suportar fluxo de medicamentos especializados:

- solicitação;
- critérios;
- documentos;
- exames;
- LME quando aplicável;
- avaliação;
- autorização;
- renovação;
- dispensação;
- monitoramento;
- pendências;
- comunicação com paciente;
- auditoria.

## 7.11 Imunização

- calendário;
- campanhas;
- lote;
- fabricante;
- dose;
- via;
- local;
- vacinador;
- estabelecimento;
- cadeia fria quando integrada;
- evento adverso;
- recusa;
- atraso;
- busca ativa;
- registro oficial/RNDS conforme modelo vigente;
- contingência offline conforme regras aplicáveis.

## 7.12 Vigilância e saúde populacional

Preparar integrações/fluxos para:

- notificações compulsórias;
- surtos;
- agravos;
- investigação;
- acompanhamento;
- indicadores epidemiológicos;
- mapas territoriais;
- alertas por cluster;
- controle de infecção;
- endemias;
- ACS/ACE.

---

# 8. HOSPITAL & PRIVATE CARE PACK

## 8.1 ADT / internação

- pré-admissão;
- admissão;
- internação;
- transferência;
- alta;
- cancelamento;
- licença;
- evasão;
- óbito;
- acompanhante;
- isolamento;
- precauções;
- gestão de leitos;
- reserva;
- bloqueio;
- higienização;
- manutenção;
- giro de leito;
- previsão de alta.

### Bed board em tempo real

Estados mínimos:

- livre;
- reservado;
- ocupado;
- alta prevista;
- em higienização;
- manutenção;
- bloqueado;
- isolamento.

## 8.2 Pronto atendimento / emergência

- check-in;
- triagem;
- classificação de risco configurável;
- fila;
- fast track;
- sala de emergência;
- observação;
- medicação;
- procedimentos;
- reavaliação;
- transferência;
- internação;
- alta;
- protocolos tempo-dependentes;
- tempos porta-triagem, porta-médico, porta-exame, porta-medicação, porta-alta;
- alertas de deterioração;
- lotação e boarding.

**Observação:** protocolos com licença/copyright devem ser implementados apenas dentro das permissões aplicáveis.

## 8.3 Enfermagem

- SAE;
- avaliação;
- evolução;
- plano de cuidados;
- diagnóstico/intervenção de enfermagem conforme terminologia adotada/licenciada;
- checagem;
- sinais vitais;
- escalas;
- balanço hídrico;
- feridas;
- dispositivos;
- acessos;
- drenos;
- cateteres;
- prevenção de queda;
- lesão por pressão;
- dor;
- handoff;
- round;
- tarefas;
- MAR/eMAR;
- deterioração clínica;
- pendências por turno.

## 8.4 UTI

- flowsheet de alta frequência;
- sinais vitais;
- ventilação mecânica;
- gasometria;
- drogas vasoativas;
- infusões;
- sedação;
- balanço hídrico;
- nutrição;
- dispositivos;
- diurese;
- escalas clínicas validadas/licenciadas;
- resultados em tendência;
- integração de monitores e dispositivos;
- alertas configuráveis;
- round multidisciplinar;
- bundle de segurança.

## 8.5 Centro cirúrgico

- solicitação;
- autorização;
- mapa cirúrgico;
- sala;
- equipe;
- pré-operatório;
- risco;
- consentimentos;
- jejum;
- checklist de cirurgia segura;
- anestesia;
- materiais;
- medicamentos;
- OPME;
- instrumentação;
- tempos cirúrgicos;
- intercorrências;
- RPA/PACU;
- registro anestésico;
- laudo/descrição cirúrgica;
- rastreabilidade de implantes;
- serial/lote/UDI quando aplicável.

## 8.6 Closed-loop medication management

Fluxo-alvo:

```text
Prescrição
→ validação clínica
→ validação farmacêutica
→ separação
→ dispensação
→ barcode
→ identificação do paciente
→ administração
→ eMAR
→ estoque
→ farmacovigilância
```

Checagens possíveis, com governança clínica:

- alergia;
- interação;
- duplicidade terapêutica;
- dose;
- frequência;
- via;
- peso;
- idade;
- função renal/hepática;
- gravidez/lactação quando aplicável;
- limites institucionais;
- medicamentos de alta vigilância.

## 8.7 LIS — laboratório

- catálogo de exames;
- pedido;
- autorização;
- preparo;
- coleta;
- identificação por barcode;
- amostra;
- transporte;
- recebimento;
- rejeição;
- processamento;
- interface de equipamento;
- resultado preliminar;
- validação técnica;
- validação clínica;
- resultado crítico;
- comunicação e ack;
- laudo;
- retificação;
- histórico;
- LOINC quando apropriado;
- integração RNDS/REL quando aplicável.

## 8.8 RIS / PACS / imagem

- solicitação;
- autorização;
- agenda;
- preparo;
- protocolo;
- modality worklist quando aplicável;
- DICOM;
- DICOMweb;
- PACS;
- viewer;
- comparação com estudos anteriores;
- laudo;
- assinatura;
- achado crítico;
- distribuição;
- teleradiologia;
- armazenamento e lifecycle.

## 8.9 Anatomia patológica

- pedido;
- espécime;
- peça;
- cassete;
- lâmina;
- rastreabilidade;
- macroscopia;
- microscopia;
- imuno-histoquímica;
- laudo;
- revisão;
- segunda opinião;
- digital pathology quando aplicável.

## 8.10 Banco de sangue / hemoterapia

- solicitação;
- tipagem;
- testes;
- reserva;
- bolsa;
- compatibilidade;
- transfusão;
- bedside check;
- reação transfusional;
- rastreabilidade completa;
- hemovigilância;
- estoque.

## 8.11 Oncologia

- staging;
- protocolo;
- plano terapêutico;
- quimioterapia;
- imunoterapia;
- radioterapia;
- ciclos;
- dose por superfície/peso conforme política;
- validação multiprofissional;
- toxicidade;
- acompanhamento;
- APAC quando SUS;
- autorização privada quando convênio.

## 8.12 Hemodiálise

- prescrição dialítica;
- máquina;
- sessão;
- acesso;
- peso pré/pós;
- ultrafiltração;
- intercorrências;
- medicações;
- laboratório;
- consumíveis;
- agenda;
- APAC quando aplicável.

## 8.13 Obstetrícia / maternidade / neonatologia

- pré-natal;
- plano de parto;
- admissão obstétrica;
- partograma conforme modelo permitido;
- trabalho de parto;
- parto;
- cesárea;
- puerpério;
- vínculo mãe-bebê;
- nascimento;
- identificação segura;
- alojamento conjunto;
- UTI neonatal;
- aleitamento;
- triagens neonatais;
- vacinas;
- alta conjunta.

## 8.14 Pediatria

- curvas de crescimento;
- desenvolvimento;
- dose por peso;
- imunização;
- responsáveis;
- consentimentos;
- alertas pediátricos;
- unidades neonatais/pediátricas.

## 8.15 Saúde mental

- plano terapêutico singular;
- avaliação de risco;
- acompanhamento longitudinal;
- CAPS/RAPS quando SUS;
- RAAS quando aplicável;
- equipe multiprofissional;
- cuidado compartilhado;
- segurança e acesso altamente segmentado quando necessário.

## 8.16 Reabilitação e multiprofissional

- fisioterapia;
- terapia ocupacional;
- fonoaudiologia;
- nutrição;
- psicologia;
- serviço social;
- educação física;
- odontologia;
- metas;
- escalas;
- evolução;
- plano compartilhado;
- frequência;
- desfechos.

## 8.17 Home care / atenção domiciliar

- elegibilidade;
- plano;
- agenda de visitas;
- georreferência operacional quando permitido;
- equipe;
- materiais;
- medicamentos;
- equipamentos;
- evolução offline-first;
- assinatura;
- intercorrência;
- telemonitoramento;
- transição hospital-domicílio.

## 8.18 Controle de infecção

- culturas;
- antimicrobianos;
- resistência;
- precauções;
- dispositivos;
- infecções relacionadas à assistência;
- bundles;
- investigação;
- surto;
- stewardship antimicrobiano;
- dashboards CCIH.

## 8.19 CME / esterilização

- material;
- kit;
- lote de esterilização;
- equipamento;
- ciclo;
- indicador;
- validade;
- rastreabilidade;
- uso no procedimento/paciente;
- recall de lote.

---

# 9. SAÚDE SUPLEMENTAR E REDE PRIVADA

## 9.1 TISS/TUSS

A integração privada deve acompanhar a versão vigente do padrão TISS, sem hardcode rígido.

Criar:

```text
PrivateHealthInterop/
├── Tiss/<versao>/
├── Tuss/<competencia>/
├── Eligibility/
├── Authorization/
├── Claims/
└── Reconciliation/
```

Requisitos:

- componente organizacional;
- conteúdo/estrutura;
- terminologia TUSS;
- segurança e privacidade;
- comunicação;
- XML quando exigido pelo padrão vigente;
- validação XSD;
- versionamento;
- compatibilidade de versões;
- receipts;
- rejeições;
- auditoria;
- testes com fixtures oficiais.

## 9.2 Revenue Cycle Management

Fluxo completo:

```text
Agendamento
→ elegibilidade
→ pré-autorização
→ atendimento
→ captura de charges
→ materiais/medicamentos
→ auditoria da conta
→ codificação
→ TISS
→ envio
→ retorno
→ pagamento
→ glosa
→ recurso
→ conciliação
```

## 9.3 Convênios

- contrato;
- plano;
- cobertura;
- acomodação;
- carência quando informada;
- elegibilidade;
- autorização;
- senha;
- validade;
- pacote;
- tabela;
- regra por prestador;
- regra por unidade;
- coparticipação quando aplicável;
- particular;
- reembolso;
- auditoria concorrente;
- glosa;
- recurso.

## 9.4 OPME

- solicitação;
- justificativa;
- autorização;
- cotação;
- fornecedor;
- reserva;
- consignado;
- recebimento;
- rastreabilidade;
- lote/serial/UDI;
- uso no paciente;
- devolução;
- faturamento;
- conciliação.

---

# 10. SUPPLY CHAIN E ERP ASSISTENCIAL

O STARMED pode integrar-se a ERPs externos, mas precisa possuir domínio suficiente para garantir rastreabilidade assistencial.

## 10.1 Compras e suprimentos

- requisição;
- cotação;
- fornecedor;
- mapa comparativo;
- pedido;
- contrato;
- recebimento;
- conferência;
- lote;
- validade;
- armazenamento;
- depósito;
- subestoque;
- transferência;
- consumo;
- devolução;
- perda;
- inventário;
- consignação;
- curva ABC/XYZ;
- ponto de ressuprimento;
- previsão de demanda.

## 10.2 Patrimônio / engenharia clínica

- ativo;
- serial;
- patrimônio;
- localização;
- responsável;
- manutenção preventiva;
- corretiva;
- calibração;
- indisponibilidade;
- SLA;
- fornecedor;
- documentação;
- integração com agenda quando equipamento estiver indisponível.

## 10.3 Custo por paciente

Associar consumo real a:

- encounter;
- procedimento;
- cirurgia;
- internação;
- linha de cuidado;
- centro de custo.

---

# 11. INTEROPERABILITY FABRIC

## 11.1 Padrões prioritários

- HL7 FHIR;
- HL7 v2 onde necessário;
- DICOM;
- DICOMweb;
- REST/OpenAPI;
- webhooks;
- eventos assíncronos;
- SMART on FHIR quando aplicável;
- OAuth2/OIDC;
- formatos oficiais brasileiros.

## 11.2 API Gateway de saúde

- autenticação;
- authorization scopes;
- rate limiting;
- tenant binding;
- audit;
- schema validation;
- idempotency key;
- correlation ID;
- quotas;
- developer keys;
- rotation;
- webhook signing;
- replay protection.

## 11.3 Integration Engine

Cada integração deve possuir:

1. adapter;
2. config por ambiente;
3. health check;
4. metrics;
5. retries com backoff;
6. circuit breaker;
7. idempotência;
8. DLQ;
9. replay;
10. mapping versionado;
11. contract test;
12. fixture sanitizada;
13. documentação operacional;
14. dashboard de erro;
15. runbook.

## 11.4 Event backbone

Eventos candidatos:

- PatientRegistered;
- PatientMerged;
- EncounterStarted;
- EncounterClosed;
- OrderPlaced;
- ResultAvailable;
- CriticalResultDetected;
- PrescriptionSigned;
- MedicationDispensed;
- MedicationAdministered;
- AdmissionCreated;
- BedAssigned;
- PatientTransferred;
- PatientDischarged;
- ReferralCreated;
- ReferralAuthorized;
- RndsSubmissionAccepted;
- RndsSubmissionRejected;
- StockoutRiskDetected.

Eventos devem ser versionados e idempotentes.

---

# 12. DOCUMENTOS, ASSINATURA E PRESCRIÇÃO

## 12.1 Document engine

Suportar:

- receita;
- atestado;
- relatório;
- solicitação de exame;
- encaminhamento;
- laudo;
- termo;
- alta;
- sumário;
- declaração;
- documentos configuráveis.

## 12.2 Assinatura

- ICP-Brasil quando exigida/aplicável;
- PAdES;
- validação de cadeia;
- revogação;
- identidade do profissional;
- OIDs aplicáveis;
- carimbo de tempo;
- hash;
- QR/token de verificação;
- prova de integridade;
- lote/assinatura em massa com autorização segura;
- ledger de emissão.

## 12.3 Prescrição segura

- catálogo de medicamentos;
- busca tolerante a erro;
- princípio ativo;
- apresentação;
- concentração;
- dose;
- via;
- frequência;
- duração;
- quantidade;
- instruções;
- controlados conforme legislação vigente;
- alergias;
- interações;
- duplicidade;
- assinatura;
- verificação;
- dispensação;
- reconciliação medicamentosa.

---

# 13. SEGURANÇA, PRIVACIDADE E COMPLIANCE

## 13.1 Princípio

STARMED manipula dado de saúde, portanto segurança é característica clínica.

## 13.2 Controles obrigatórios

### Identity

- MFA;
- passkeys quando suportado;
- política de sessão;
- revogação;
- device/session inventory;
- proteção contra credential stuffing;
- rate limit;
- lockout seguro;
- recuperação de conta robusta.

### Authorization

Combinar:

- RBAC;
- ABAC;
- tenant scope;
- organization scope;
- location scope;
- relationship-to-patient;
- purpose of use;
- break-glass.

### Banco

- RLS onde aplicável;
- session context;
- least privilege;
- migration account separado;
- application account sem superuser;
- encryption;
- backup;
- PITR;
- restore tests.

## 13.3 Break Glass

Acesso emergencial deve:

- exigir motivo;
- exigir autenticação reforçada quando possível;
- ter prazo limitado;
- ser auditado;
- gerar alerta;
- permitir revisão posterior;
- nunca virar forma rotineira de contornar permissão.

## 13.4 Auditoria imutável

Registrar eventos críticos com:

- actor;
- tenant;
- organização;
- paciente;
- recurso;
- ação;
- timestamp;
- correlation ID;
- origem;
- IP/device quando adequado;
- motivo;
- before/after seguro quando permitido;
- resultado;
- break-glass flag.

Auditoria não deve vazar conteúdo clínico desnecessário em logs operacionais.

## 13.5 LGPD

- privacy by design;
- data minimization;
- purpose limitation;
- access control;
- consent quando a base legal depender dele;
- registro de base legal/processamento;
- DSAR workflow;
- retenção;
- anonimização/pseudonimização;
- erasure somente quando juridicamente aplicável;
- segregação de ambientes;
- DLP;
- incident response;
- evidence of deletion;
- tratamento de backups conforme política.

### Retenção de prontuário

A política deve observar a Lei nº 13.787/2018 e outras normas aplicáveis. A lei prevê prazo mínimo de 20 anos a partir do último registro antes de possível eliminação, observadas regras e exceções aplicáveis.

## 13.6 SBIS S-RES

Arquitetar para requisitos atuais de certificação, conforme escopo, incluindo:

- PEP Consultório Individual;
- PEP Clínica/Ambulatório;
- PEP Internação;
- PEP Pronto Atendimento;
- Telessaúde;
- Prescrição Eletrônica quando aplicável;
- SADT/RIS quando aplicável;
- NGS1/NGS2 e estágio de maturidade pertinente.

**Meta de engenharia:** ser capaz de perseguir o maior estágio de maturidade aplicável sem refatoração estrutural do core.

## 13.7 SaMD / ANVISA

Separar formalmente:

1. Administrative AI;
2. Documentation AI;
3. Clinical Decision Support;
4. Regulated Clinical AI.

Qualquer funcionalidade com finalidade médica potencialmente enquadrável como Software como Dispositivo Médico deve passar por avaliação regulatória antes de release. RDC 657/2022 e normas correlatas devem ser tratadas como requisitos versionáveis.

---

# 14. IA — STARMED INTELLIGENCE LAYER

A IA não será um chatbot colado no canto da tela.

Ela deve ser **contextual, verificável, observável e governada**.

## 14.1 Evidence-linked AI

Toda afirmação clínica relevante produzida por IA deve, sempre que tecnicamente possível, apontar a fonte:

```text
HbA1c aumentou 7,2 → 9,1
                         ↳ exame 23/09/2026
```

Nunca exibir opinião como fato sem indicar origem/incerteza.

## 14.2 Clinical Copilot

Capacidades-alvo:

- “O que mudou desde a última consulta?”;
- resumo longitudinal;
- timeline relevante;
- reconciliação de medicamentos;
- pendências;
- resultados críticos;
- comparação de exames;
- preparação de nota;
- estruturação SOAP;
- preenchimento assistido;
- busca clínica natural;
- preparação de pedidos para confirmação;
- identificação de gaps de cuidado;
- apoio a revisão, nunca substituição automática do profissional.

## 14.3 Ambient documentation

- consentimento/configuração institucional;
- captura segura;
- transcrição;
- diarização quando suportada;
- remoção de ruído;
- estruturação;
- rascunho;
- revisão humana;
- assinatura;
- política de retenção do áudio;
- trilha de provenance;
- exclusão conforme política.

## 14.4 Operational Copilot

Gestor poderá perguntar em linguagem natural:

- por que uma UBS está atrasada;
- onde há risco de ruptura;
- quais filas romperam SLA;
- quais unidades possuem ociosidade;
- quais indicadores pioraram;
- quais integrações estão rejeitando dados;
- quais contas têm risco de glosa.

A resposta deve ter links para métricas e dados fonte.

## 14.5 Pharmacy Intelligence

- previsão de demanda;
- ruptura;
- vencimento;
- redistribuição;
- anomalia de consumo;
- divergência de inventário;
- recall;
- adequação de retirada quando aplicável.

## 14.6 Guardrails

- human-in-the-loop;
- ações clínicas exigem confirmação explícita;
- prompt injection defenses;
- sanitização;
- output schema validation;
- grounded retrieval;
- avaliação offline;
- shadow mode antes de ação;
- feature flag;
- rollback;
- model/version tracking;
- cost tracking;
- redaction/minimização de PII;
- audit de interação;
- monitoramento de drift;
- datasets controlados;
- avaliação por especialidade quando necessário.

## 14.7 AI model gateway

Não acoplar domínio clínico diretamente a um fornecedor único.

```text
ClinicalUseCase
   ↓
AI Gateway
   ├── model routing
   ├── policy
   ├── PHI handling
   ├── cost
   ├── observability
   ├── fallback
   └── evals
```

---

# 15. UX — STARMED FLUID CLINICAL OS

## 15.1 Objetivo

Criar uma experiência clínica que não pareça ERP, que reduza navegação, memória operacional e retrabalho.

O objetivo não é “mais animação”. É **mais compreensão, menos fricção**.

## 15.2 Estrutura central

### Patient Spine

Coluna persistente contextual com:

- identidade;
- idade;
- sexo/gênero conforme política;
- alergias críticas;
- problemas ativos;
- medicamentos;
- riscos;
- alertas;
- equipe;
- contexto atual.

### Care Canvas

Área principal adaptativa onde o trabalho acontece.

### Intelligence Rail

Painel lateral contextual para:

- resumo;
- evidência;
- pendências;
- recomendações assistivas;
- alertas;
- explicações.

### Fluid Timeline

Timeline longitudinal navegável por eventos.

### Health Graph

Visualização relacional entre:

- condição;
- medicamento;
- exame;
- intervenção;
- especialista;
- internação;
- desfecho.

### Universal Command

`Ctrl/Cmd + K` com busca e ação contextual.

## 15.3 Regra de zero-context-loss

Abrir exame, medicamento, documento ou histórico não deve obrigar o profissional a abandonar o que está escrevendo.

Usar contextual peek/panels.

## 15.4 Role-adaptive UX

### Médico

- quadro clínico;
- timeline;
- problemas;
- notas;
- orders;
- resultados;
- plano;
- documentos.

### Enfermagem

- tarefas;
- medicação;
- sinais;
- dispositivos;
- pendências;
- cuidados;
- handoff.

### Farmácia

- validação;
- fila;
- estoque;
- dispensação;
- reconciliação;
- alertas.

### Recepção

- check-in;
- cadastro;
- elegibilidade;
- fila;
- agenda;
- documentos.

### Gestor

- command center;
- capacidade;
- SLA;
- operação;
- qualidade;
- financeiro;
- supply.

### Cidadão/paciente

- próximos passos;
- consultas;
- exames;
- medicamentos;
- documentos;
- notificações;
- teleatendimento;
- explicação em linguagem simples.

## 15.5 Clinical Inbox unificada

Centralizar:

- resultados críticos;
- resultados para revisão;
- assinaturas;
- encaminhamentos;
- mensagens;
- tarefas;
- documentos;
- alertas;
- retorno;
- pendências regulatórias.

Ordenação por:

- risco;
- SLA;
- urgência;
- contexto;
- relação com o profissional.

## 15.6 Voice-first, sem perder segurança

Comandos de voz podem:

- navegar;
- buscar;
- ditar;
- montar rascunhos;
- preparar ordens.

Qualquer ação de alto impacto exige revisão/confirm.

---

# 16. MOTION DESIGN SYSTEM

Motion deve explicar estado, não competir com o atendimento.

## 16.1 Camadas

- **Micro:** ~80–140 ms — press, hover, toggle.
- **Functional:** ~160–240 ms — painel, expand/collapse, context peek.
- **Spatial:** ~250–400 ms — mudança de workspace, drilldown, timeline.
- **Narrative:** apenas onboarding, explicação operacional e visualizações específicas.

Esses números são alvos iniciais e devem ser validados por pesquisa de UX/performance.

## 16.2 Princípios

- continuity of object;
- shared element transitions;
- state morphing;
- progressive disclosure;
- depth funcional;
- animation cancelable;
- nunca bloquear input clínico por animação;
- 60fps onde possível;
- GPU-friendly transforms;
- `prefers-reduced-motion` integral.

## 16.3 Exemplos funcionais

- pedido move de `solicitado → coletado → processando → resultado`;
- regulação mostra a jornada do pedido sem trocar de tela;
- leito transiciona entre estados;
- critical result chama atenção sem flash agressivo;
- painel clínico reorganiza-se ao iniciar atendimento.

---

# 17. DESIGN SYSTEM

## 17.1 Requisitos

- tokens únicos web/mobile;
- semantic colors;
- density modes;
- typography scale;
- spacing scale;
- elevation/depth;
- motion tokens;
- status tokens;
- clinical severity tokens;
- focus state forte;
- touch targets adequados;
- dark mode onde seguro;
- high contrast mode;
- accessible components;
- Storybook obrigatório para componentes base.

## 17.2 Não fazer

- semáforo usando somente cor;
- botão destrutivo sem confirmação contextual;
- modal para toda ação;
- card para qualquer conteúdo;
- dashboard com dezenas de KPIs sem hierarquia;
- tabela desktop espremida no mobile;
- ícones sem label onde há ambiguidade;
- animação longa para tarefas repetitivas.

---

# 18. ACESSIBILIDADE

Meta: WCAG vigente aplicável em nível AA como baseline do produto, considerando também requisitos públicos brasileiros aplicáveis.

Checklist:

- teclado completo;
- screen reader;
- landmarks;
- labels;
- heading hierarchy;
- focus management;
- contraste;
- zoom;
- reduced motion;
- erros acessíveis;
- live regions moderadas;
- tabelas semânticas;
- formulários claros;
- tamanho de alvo;
- conteúdo em linguagem simples para cidadão;
- E2E com axe;
- testes manuais periódicos.

---

# 19. MOBILE E OFFLINE

## 19.1 Mobile profissional

Casos prioritários:

- ACS/ACE;
- visita domiciliar;
- enfermagem bedside;
- checagem de medicamento;
- rounds;
- foto/documento clínico quando permitido;
- notificações críticas;
- gestão rápida de fila;
- teleatendimento.

## 19.2 Offline-first controlado

Para fluxos autorizados:

- encrypted local store;
- device binding;
- expiração;
- sync queue;
- conflito explícito;
- provenance offline;
- retry;
- wipe remoto quando possível;
- nada de cache indiscriminado de prontuário completo.

---

# 20. PORTAL DO PACIENTE / CIDADÃO

Experiência de padrão consumidor.

- login seguro;
- agenda;
- confirmação;
- check-in;
- resultados;
- documentos;
- receitas;
- medicamentos/retirada;
- fila regulatória quando a política permitir;
- vacinação;
- histórico;
- teleconsulta;
- notificações;
- dados cadastrais;
- consentimentos;
- solicitações LGPD;
- compartilhamento controlado;
- explicação de termos em linguagem simples;
- educação personalizada;
- acessibilidade.

### Princípio

Não exibir jargão cru quando uma explicação segura puder ser adicionada sem alterar o conteúdo clínico original.

---

# 21. POPULATION HEALTH & COMMAND CENTER

## 21.1 Municipal/estadual

Dashboards devem permitir drilldown:

- território;
- unidade;
- equipe;
- profissional;
- linha de cuidado;
- período.

## 21.2 Indicadores operacionais

- fila;
- tempo de espera;
- absenteísmo;
- capacidade;
- produtividade;
- ocupação;
- giro de leito;
- LOS;
- alta prevista;
- no-show;
- ruptura de estoque;
- vencimento;
- regulação/SLA;
- integração rejeitada.

## 21.3 Indicadores clínicos

Devem possuir definição formal, população, numerador, denominador, período e fonte.

Nunca produzir KPI “mágico” sem metodologia.

## 21.4 State Oversight

A fundação atual de `state-oversight` deve evoluir para uma superfície de governança, auditoria e transparência compatível com separação de escopo e dados.

---

# 22. DATA PLATFORM

Separar workloads clínicos transacionais de analytics pesado.

```text
Operational DB
   ↓ CDC / events
Health Data Platform
   ├── warehouse/lakehouse
   ├── semantic layer
   ├── quality rules
   ├── de-identification
   ├── feature datasets
   └── BI/AI
```

## 22.1 Data governance

- data catalog;
- owner;
- steward;
- classification;
- lineage;
- quality score;
- retention;
- masking;
- purpose;
- access approval;
- de-identification;
- research governance.

## 22.2 Não usar analytics diretamente sobre tabelas críticas sem controle

Consultas estratégicas pesadas não devem derrubar atendimento.

---

# 23. MIGRAÇÃO DE LEGADO

O projeto já possui boa fundação `StarMedLegacy*`; isso deve virar produto formal.

## 23.1 Pipeline

```text
Discovery
→ extract
→ normalize
→ identity match
→ terminology mapping
→ validation
→ dry run
→ import
→ reconciliation
→ exception queue
→ sign-off
```

## 23.2 Requisitos

- lote imutável;
- hash do arquivo;
- origem;
- versão do importador;
- total lido;
- total aceito;
- total rejeitado;
- total reconciliado;
- motivos;
- reprocessamento idempotente;
- dry-run;
- relatórios;
- rollback/compensação quando viável;
- amostragem clínica;
- aprovação institucional.

---

# 24. CONFIABILIDADE, SRE E OBSERVABILIDADE

## 24.1 SLOs

Definir SLO por capacidade, não um único “99.9” genérico.

Exemplo:

- autenticação;
- leitura de prontuário;
- escrita clínica;
- prescrição;
- assinatura;
- fila;
- resultados críticos;
- integração RNDS;
- PACS;
- teleconsulta.

## 24.2 Telemetria

- metrics;
- logs estruturados;
- traces;
- correlation ID;
- error tracking;
- synthetic checks;
- integration health;
- queue depth;
- DLQ;
- database saturation;
- cache saturation;
- external dependency latency;
- AI latency/cost/error.

## 24.3 Logs clínicos

Logs operacionais não podem conter prontuário completo, transcrição integral, documentos ou segredos por conveniência de debugging.

## 24.4 Resiliência

- timeout explícito;
- retry seletivo;
- circuit breaker;
- bulkhead;
- idempotência;
- backpressure;
- graceful degradation;
- fallback somente quando clinicamente seguro;
- feature kill switch.

---

# 25. BACKUP, DR E CONTINUIDADE

- backup automatizado;
- criptografia;
- cópia isolada/imutável;
- PITR;
- restore test recorrente;
- RPO/RTO formalizados;
- runbook;
- failover test;
- disaster simulation;
- cyber recovery;
- operação degradada;
- downtime procedures;
- impressão/consulta emergencial somente quando governada.

**Regra:** backup não é considerado funcional até que restore seja testado.

---

# 26. DEVSECOPS E SUPPLY CHAIN DE SOFTWARE

## 26.1 Gates mínimos

- lint;
- typecheck;
- unit tests;
- integration tests;
- architecture tests;
- contract tests;
- E2E;
- accessibility;
- SAST;
- secret scanning;
- dependency audit;
- IaC scan;
- SBOM;
- signed artifacts quando aplicável;
- container scan;
- migration verification.

## 26.2 CI da branch STARMED — P0

Todo merge deve possuir gate verde.

Não permitir merge quando:

- build falha;
- migration falha;
- teste de isolamento falha;
- teste crítico clínico falha;
- segredo é detectado;
- vulnerability crítica sem waiver formal;
- E2E crítico falha.

## 26.3 Cobertura

Não perseguir cobertura artificial. Criar baseline real e impedir regressão injustificada.

Cobertura de fluxos clínicos e segurança importa mais que percentual isolado.

---

# 27. TEST STRATEGY

## 27.1 Pirâmide ampliada

- unit;
- property-based onde útil;
- domain tests;
- integration DB;
- integration external adapters;
- contract;
- architecture;
- concurrency;
- security;
- E2E;
- accessibility;
- performance;
- resilience;
- migration;
- backup/restore;
- clinical scenario validation.

## 27.2 Testes clínicos de ouro

Criar cenários Golden Patient Journey:

1. APS simples;
2. crônico longitudinal;
3. gestante;
4. pediatria;
5. urgência;
6. internação;
7. cirurgia;
8. ICU;
9. medicamento closed-loop;
10. laboratório crítico;
11. regulação + contrarreferência;
12. SUS billing;
13. private billing;
14. migração legado;
15. RNDS round-trip.

## 27.3 Concorrência

Testar:

- dois profissionais editando encounter;
- prescrição concorrente;
- troca de leito;
- reserva de slot;
- estoque;
- dispensação;
- faturamento;
- importação;
- jobs duplicados.

---

# 28. PERFORMANCE

Metas devem ser validadas por ambiente, mas o UX deve buscar sensação de instantaneidade.

Categorias:

- shell initial load;
- patient lookup;
- chart open;
- save note;
- order search;
- medication search;
- timeline query;
- command palette;
- dashboard drilldown.

Estratégias:

- pagination/cursor;
- virtualization;
- prefetch contextual;
- caching com invalidation correta;
- optimistic UI somente onde seguro;
- streaming;
- query budgets;
- index review;
- N+1 detection;
- load testing.

---

# 29. MULTI-TENANCY E CONFIGURAÇÃO

## 29.1 Hierarquia

```text
Platform
└── Tenant
    └── Organization
        └── Facility
            └── Department
                └── Location
```

## 29.2 Configurável sem fork

- marca;
- unidade;
- horários;
- formulários;
- workflows;
- protocolos;
- catálogos locais;
- perfis;
- integrações;
- documentos;
- SLAs;
- feature flags.

Não criar branch de código por cliente.

---

# 30. MARKETPLACE / DEVELOPER PLATFORM

Para competir com ecossistemas globais, STARMED deve ser extensível.

- public APIs governadas;
- FHIR APIs;
- SMART-on-FHIR-ready quando aplicável;
- webhooks;
- sandbox;
- developer portal;
- API keys/OAuth clients;
- scopes;
- test patients;
- audit;
- rate limit;
- app registration;
- certification process de apps parceiros.

---

# 31. BENCHMARK INTERNACIONAL E BRASILEIRO

O objetivo não é copiar aparência. É aprender capacidades e remover os defeitos históricos dos EHRs.

## 31.1 Epic

Referências a observar:

- prontuário longitudinal;
- integração hospitalar profunda;
- patient engagement;
- interoperabilidade;
- clinical decision support;
- ambient/AI workflows;
- ecossistema.

### STARMED deve tentar superar em

- simplicidade visual;
- tempo até informação;
- implementação modular;
- transparência de IA;
- contexto SUS brasileiro nativo;
- menor dependência de navegação profunda.

## 31.2 Oracle Health

Referências:

- interoperabilidade;
- APIs;
- voice-forward AI;
- nursing AI;
- patient portal com explicação em linguagem natural.

## 31.3 MEDITECH Expanse

Referências:

- hospital workflow;
- mobilidade;
- interoperabilidade;
- ambient/AI.

## 31.4 InterSystems TrakCare

Referências:

- registro unificado;
- FHIR/SMART on FHIR;
- integração com legados;
- arquitetura de dados/interoperabilidade.

## 31.5 MV e Tasy

Referências essenciais para realidade brasileira:

- hospitalar;
- faturamento;
- materiais;
- estoque;
- saúde pública;
- integração de processos;
- conformidade local;
- operação em grandes redes.

## 31.6 HIMSS EMRAM

Usar como referência arquitetural de maturidade digital. Não declarar estágio HIMSS sem avaliação externa oficial.

---

# 32. DIFERENCIAIS STARMED

## 32.1 Universal Health Graph

Conectar problemas a:

- exames;
- medicamentos;
- internações;
- procedimentos;
- especialistas;
- metas;
- desfechos.

## 32.2 Patient Digital Twin operacional

Não no sentido de simulação médica não validada, mas como **representação computável da jornada**:

- identidade;
- contexto;
- timeline;
- problemas;
- medicamentos;
- care gaps;
- solicitações;
- tarefas;
- planos;
- interações com sistema.

## 32.3 Explainable Operations

Todo KPI deve responder:

- de onde veio;
- fórmula;
- população;
- período;
- filtros;
- atualização;
- dados excluídos.

## 32.4 “No dead ends” UX

Nenhuma tarefa crítica deve terminar em tela sem próximo passo explícito.

## 32.5 Universal Clinical Search

Uma busca única para:

- paciente;
- exame;
- documento;
- medicamento;
- procedimento;
- profissional;
- unidade;
- comando;
- ajuda.

Com escopo e permissão respeitados.

---

# 33. MATRIZ DE CAPACIDADES — ESTADO ATUAL X ALVO

Esta matriz é conservadora: “não comprovado” significa que não houve evidência suficiente na leitura atual, não necessariamente inexistência absoluta.

| Capacidade | Estado atual observado | Alvo |
|---|---|---|
| APS / território | IMPLEMENTADO/PARCIAL | PRODUÇÃO validada |
| Diretório APS | IMPLEMENTADO | PRODUÇÃO |
| Fila UBS | IMPLEMENTADO | PRODUÇÃO + analytics |
| Prontuário / Encounter | IMPLEMENTADO + testes de concorrência | núcleo canônico completo |
| Laboratório | IMPLEMENTADO/PARCIAL | LIS completo + RNDS |
| Farmácia/estoque | IMPLEMENTADO/PARCIAL | BNAFAR + closed-loop + supply |
| Regulação | IMPLEMENTADO/PARCIAL | jornada completa + RIRA |
| Migração legado | IMPLEMENTADO forte | produto de migração certificado internamente |
| CADSUS | IMPLEMENTADO + teste relevante | HOMOLOGADO/PRODUÇÃO conforme credencial |
| CNES | IMPLEMENTADO adapter/client | integração operacional validada |
| e-SUS APS | IMPLEMENTADO adapter/client | LEDI/Siaps versionado e validado |
| RNDS | IMPLEMENTADO adapter/client | modelos oficiais homologados individualmente |
| SIGTAP | IMPLEMENTADO adapter/client | rules engine completo |
| OBM | IMPLEMENTADO adapter/client | farmácia integrada |
| BNAFAR/SI-BNAFAR | NÃO COMPROVADO como circuito completo | obrigatório Public Health Pack |
| SIA/BPA/APAC/RAAS | PARCIAL/NÃO COMPROVADO ponta a ponta | billing SUS completo |
| SIH/AIH | NÃO COMPROVADO ponta a ponta | Hospital SUS completo |
| TISS/TUSS | NÃO COMPROVADO na leitura atual | obrigatório Private Pack |
| ADT/internação | NÃO COMPROVADO completo | Hospital Pack |
| Bed management | NÃO COMPROVADO completo | Hospital Pack |
| UTI | NÃO COMPROVADO completo | Hospital Pack |
| Centro cirúrgico | NÃO COMPROVADO completo | Hospital Pack |
| eMAR/closed-loop meds | NÃO COMPROVADO completo | Hospital Pack |
| RIS/PACS | base telediagnóstico DICOM/PACS IMPLEMENTADA | produto RIS/PACS integrado |
| Telediagnóstico | IMPLEMENTADO forte | validação clínica/regulatória completa |
| ICP/PAdES/TSA | IMPLEMENTADO forte | validação externa e operação |
| RLS | IMPLEMENTADO + testes relacionados | cobertura total de dados sensíveis |
| LGPD lifecycle | IMPLEMENTADO/PARCIAL | política jurídica + provas operacionais |
| IA clínica | IMPLEMENTADO forte | gateway + evals + governance + SaMD review |
| Voice assistant | IMPLEMENTADO/PARCIAL | experiência clínica segura |
| State oversight | IMPLEMENTADO como feature | governance-grade |
| CI/CD | IMPLEMENTADO forte | gate obrigatório STARMED |
| Coverage threshold | PARCIAL | baseline + no regression |
| Demo/fake isolation | RISCO EXISTENTE | impossível em produção |
| Feature-first frontend | PARCIAL | padrão obrigatório |
| Acessibilidade automatizada | IMPLEMENTADA no CI/Playwright | AA + validação manual |
| Portal paciente/cidadão | PARCIAL | experiência consumer-grade |
| Revenue Cycle privado | NÃO COMPROVADO completo | completo |
| Supply chain | PARCIAL via farmácia | enterprise-grade |
| Developer platform | NÃO COMPROVADO completo | APIs/FHIR/marketplace |

---

# 34. ROADMAP DE EXECUÇÃO

## FASE P0 — FOUNDATION HARDENING

Antes de expandir horizontalmente:

- [ ] CI obrigatório em toda alteração STARMED;
- [ ] todos testes verdes;
- [ ] baseline de cobertura;
- [ ] zero segredo;
- [ ] zero mock/fake em produção;
- [ ] RLS/tenant isolation tests ponta a ponta;
- [ ] usuário de uma UBS não acessa outra sem permissão;
- [ ] teste de concorrência de prontuário;
- [ ] restore real de backup;
- [ ] migrations em banco vazio;
- [ ] migrations em banco populado;
- [ ] rollback/forward-fix strategy;
- [ ] SLOs iniciais;
- [ ] threat model;
- [ ] pentest;
- [ ] load test;
- [ ] documentação de arquitetura;
- [ ] catalogar todos adapters externos;
- [ ] matriz real de homologações.

## FASE P1 — PUBLIC HEALTH COMPLETE

- [ ] MPI;
- [ ] APS completa;
- [ ] LEDI/Siaps atualizado;
- [ ] RNDS models;
- [ ] CADSUS;
- [ ] CNES;
- [ ] SIGTAP rules engine;
- [ ] produção SUS;
- [ ] regulação completa;
- [ ] contrarreferência;
- [ ] BNAFAR/SI-BNAFAR;
- [ ] OBM;
- [ ] CEAF;
- [ ] imunização;
- [ ] command center municipal;
- [ ] portal cidadão;
- [ ] ACS/ACE offline.

## FASE P1 — PRIVATE / AMBULATORY

- [ ] TISS versionado;
- [ ] TUSS;
- [ ] elegibilidade;
- [ ] autorização;
- [ ] faturamento;
- [ ] glosa/recurso;
- [ ] conciliação;
- [ ] particular;
- [ ] pacotes/tabelas;
- [ ] portal paciente.

## FASE P1/P2 — HOSPITAL CORE

- [ ] ADT;
- [ ] bed management;
- [ ] emergency;
- [ ] inpatient;
- [ ] nursing;
- [ ] eMAR;
- [ ] pharmacy validation;
- [ ] surgery;
- [ ] anesthesia;
- [ ] ICU;
- [ ] LIS;
- [ ] RIS/PACS;
- [ ] infection control;
- [ ] supply chain;
- [ ] SUS hospital billing;
- [ ] private hospital billing.

## FASE P2 — SPECIALTIES

- [ ] pathology;
- [ ] blood bank;
- [ ] oncology;
- [ ] dialysis;
- [ ] obstetrics;
- [ ] neonatal;
- [ ] pediatrics;
- [ ] mental health;
- [ ] rehab;
- [ ] home care;
- [ ] CME;
- [ ] dental hospital.

## FASE P2/P3 — NEXT-GEN EXPERIENCE

- [ ] Fluid Clinical OS redesign;
- [ ] Patient Spine;
- [ ] Care Canvas;
- [ ] Intelligence Rail;
- [ ] Fluid Timeline;
- [ ] Health Graph;
- [ ] universal command;
- [ ] unified inbox;
- [ ] contextual peeks;
- [ ] voice navigation;
- [ ] motion design system;
- [ ] adaptive density;
- [ ] consumer-grade portal.

## FASE P3 — INTELLIGENCE

- [ ] evidence-linked AI;
- [ ] ambient documentation;
- [ ] clinical search;
- [ ] operational copilot;
- [ ] pharmacy forecasting;
- [ ] glosa risk;
- [ ] queue optimization;
- [ ] care gap prediction;
- [ ] AI gateway;
- [ ] continuous evals;
- [ ] regulated-AI lifecycle.

---

# 35. DEFINITION OF DONE — FEATURE

Uma feature só está pronta quando:

- [ ] requisito funcional definido;
- [ ] risco clínico avaliado quando aplicável;
- [ ] threat model atualizado quando aplicável;
- [ ] autorização testada;
- [ ] tenant isolation testado;
- [ ] migration reversível/segura;
- [ ] unit tests;
- [ ] integration tests;
- [ ] E2E crítico;
- [ ] acessibilidade;
- [ ] observabilidade;
- [ ] sem PII indevida em logs;
- [ ] documentação;
- [ ] runbook;
- [ ] métricas;
- [ ] rollout/feature flag quando necessário;
- [ ] rollback;
- [ ] owner definido;
- [ ] aprovação clínica/regulatória quando exigida.

---

# 36. DEFINITION OF DONE — INTEGRAÇÃO EXTERNA

- [ ] documentação oficial versionada;
- [ ] ambiente de homologação separado;
- [ ] credentials em secret manager;
- [ ] certificado correto;
- [ ] mapper versionado;
- [ ] validator;
- [ ] contract tests;
- [ ] happy path;
- [ ] reject path;
- [ ] timeout;
- [ ] retry;
- [ ] idempotency;
- [ ] circuit breaker;
- [ ] metrics;
- [ ] alert;
- [ ] DLQ;
- [ ] replay;
- [ ] reconciliation;
- [ ] evidence receipt;
- [ ] runbook;
- [ ] homologação formal registrada quando aplicável.

---

# 37. DEFINITION OF DONE — STARMED HEALTH OS

O produto não poderá ser chamado internamente de “completo” enquanto os itens aplicáveis ao escopo contratado não tiverem evidência real.

### Interoperabilidade pública

- [ ] RNDS/FHIR;
- [ ] RAC;
- [ ] REL;
- [ ] RIA;
- [ ] RIRA;
- [ ] modelos futuros plugáveis;
- [ ] CADSUS;
- [ ] CNES;
- [ ] e-SUS APS/LEDI/Siaps;
- [ ] BNAFAR/SI-BNAFAR;
- [ ] OBM;
- [ ] SIGTAP;
- [ ] produção SUS aplicável.

### Privado

- [ ] TISS;
- [ ] TUSS;
- [ ] elegibilidade;
- [ ] autorização;
- [ ] claims;
- [ ] faturamento;
- [ ] glosa;
- [ ] recurso;
- [ ] conciliação.

### Clinical

- [ ] MPI;
- [ ] prontuário longitudinal;
- [ ] ambulatório;
- [ ] APS;
- [ ] emergência;
- [ ] internação;
- [ ] enfermagem;
- [ ] UTI;
- [ ] centro cirúrgico;
- [ ] medicação closed-loop;
- [ ] laboratório;
- [ ] imagem;
- [ ] farmácia;
- [ ] regulação;
- [ ] especialidades necessárias.

### Operação

- [ ] supply chain;
- [ ] estoque;
- [ ] patrimônio;
- [ ] OPME;
- [ ] CME;
- [ ] command center;
- [ ] analytics;
- [ ] population health.

### Segurança

- [ ] MFA;
- [ ] RBAC/ABAC;
- [ ] RLS;
- [ ] break-glass;
- [ ] immutable audit;
- [ ] encryption;
- [ ] backups;
- [ ] restore proof;
- [ ] DR;
- [ ] pentest;
- [ ] security monitoring;
- [ ] LGPD lifecycle.

### Experiência

- [ ] role-adaptive UX;
- [ ] accessibility;
- [ ] responsive/mobile;
- [ ] Fluid Clinical OS;
- [ ] unified inbox;
- [ ] command palette;
- [ ] timeline;
- [ ] graph;
- [ ] motion system;
- [ ] portal paciente/cidadão.

### Inteligência

- [ ] AI gateway;
- [ ] evidence-linked AI;
- [ ] evals;
- [ ] audit;
- [ ] clinical governance;
- [ ] regulatory review;
- [ ] human confirmation.

---

# 38. MÉTRICAS DE SUCESSO

Não medir sucesso por número de telas.

## 38.1 UX clínica

- tempo para abrir paciente;
- tempo até informação crítica;
- cliques por fluxo;
- tempo de documentação;
- tarefas por sessão;
- abandonos;
- erro de formulário;
- satisfação por profissão;
- teclado vs mouse;
- uso de busca/comando.

## 38.2 Segurança

- acesso negado correto;
- break-glass rate;
- incidents;
- vulnerability age;
- secret leaks;
- failed MFA;
- restore success;
- privileged access review.

## 38.3 Interop

- submission success;
- rejection rate;
- retry count;
- latency;
- reconciliation gap;
- stale credentials;
- model/version compliance.

## 38.4 Clínica

Indicadores devem ser definidos por equipe clínica e nunca inventados pela engenharia sem governança.

## 38.5 Operação

- wait time;
- LOS;
- no-show;
- occupancy;
- bed turnover;
- stockout;
- waste;
- expiry;
- queue SLA;
- billing denial/glosa.

---

# 39. GOVERNANÇA DE PRODUTO

Criar fóruns claros:

- Architecture Council;
- Clinical Safety Council;
- Security Council;
- Data Governance;
- AI Governance;
- Regulatory/Compliance;
- UX Research Council;
- Release Readiness.

Nenhum desses precisa virar burocracia pesada; precisa haver owner e evidência.

---

# 40. ARQUITETURA DE DOCUMENTAÇÃO

Manter junto ao código:

```text
docs/
├── architecture/
├── clinical/
├── interoperability/
├── sus/
├── private-health/
├── security/
├── compliance/
├── ai/
├── ux/
├── runbooks/
├── adr/
└── release-evidence/
```

ADRs obrigatórios para decisões estruturais.

---

# 41. REGRAS CONTRA REGRESSÃO ARQUITETURAL

Adicionar architecture tests/linters para impedir:

- controller acessando SQL;
- Domain dependendo de Infrastructure;
- cross-tenant query sem contexto;
- integração externa sem timeout;
- uso de fake em Production;
- criação de páginas clínicas sem audit/authorization onde aplicável;
- log de payload clínico não autorizado;
- `any` indiscriminado em contratos críticos;
- endpoint sem versionamento/política quando público;
- migration fora do mecanismo oficial.

---

# 42. REFATORAÇÕES PRIORITÁRIAS NO CÓDIGO ATUAL

## 42.1 `OpenAiReadingService`

Quebrar em:

- ingestion;
- preprocessing;
- provider gateway;
- prompts;
- clinical grounding;
- structured output;
- safety;
- cost/usage;
- audit;
- telemetry.

## 42.2 `MigrationRunner`

Transformar em orquestrador pequeno:

```text
IMigration
├── Id
├── Checksum
├── Apply()
├── Verify()
└── Metadata
```

Tabela de controle:

- migration_id;
- checksum;
- applied_at;
- duration;
- status;
- app_version.

## 42.3 Frontend

Migrar progressivamente domínios para `features/`, evitando reescrita big-bang.

## 42.4 Demo/Fakes

Criar build/runtime guard:

```text
Production + Demo/Fake provider => startup failure
```

E teste automatizado obrigatório.

---

# 43. FONTES OFICIAIS E BASES DE REFERÊNCIA

> As versões devem ser verificadas novamente antes de qualquer homologação ou release regulatório. Esta seção registra as fontes consultadas na data-base deste documento.

## Brasil — SUS / interoperabilidade

- RNDS — Estrutura do projeto e modelos de informação:  
  https://www.gov.br/saude/pt-br/composicao/seidigi/rnds/estrutura-do-projeto

- e-SUS APS — versão/documentação e API LEDI para sistemas próprios/terceiros:  
  https://sisaps.saude.gov.br/sistemas/esusaps/docs/versoes/versao_5_3/

- Nota Técnica 32/2026 — integração de sistemas próprios via LEDI/API no contexto publicado:  
  https://www.gov.br/saude/pt-br/composicao/saps/publicacoes/notas-tecnicas-e-informativas/nota-tecnica-no-32-2026-cgsb-desf-saps-ms

- BNAFAR — FAQ e diretrizes atuais:  
  https://www.gov.br/saude/pt-br/composicao/sectics/daf/bnafar/faq/faq

- Portaria 5.713/2024 explicada pelo Ministério da Saúde / BNAFAR:  
  https://www.gov.br/saude/pt-br/composicao/sectics/daf/bnafar/faq/faq/o-que-foi-estabelecido-pela-1

- Sistemas de Informação em Saúde — CNES/SIGTAP/SIA/SIH/SISREG etc.:  
  https://www.gov.br/saude/pt-br/acesso-a-informacao/gestao-do-sus/programacao-regulacao-controle-e-financiamento-da-mac/sistemas-de-informacao-em-saude

- SIA Wiki — BPA/APAC/RAAS/processamento:  
  https://wiki.saude.gov.br/sia/index.php/P%C3%A1gina_principal

- SIGTAP Wiki:  
  https://wiki.saude.gov.br/sigtap/index.php/Gerais

## Brasil — saúde suplementar

- ANS — Padrão TISS:  
  https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss

- ANS — TUSS:  
  https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/codigos-da-tuss

## Segurança / prontuário / certificação

- Lei nº 13.787/2018 — digitalização, guarda, armazenamento e manuseio de prontuário:  
  https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13787.htm

- Lei nº 13.709/2018 — LGPD:  
  https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm

- SBIS — categorias e modalidades certificáveis S-RES:  
  https://sbis.org.br/certificacoes/certificacao-software/categorias-e-modalidades-certificaveis/

- SBIS — sistemas certificados:  
  https://sbis.org.br/certificacoes/certificacao-software/sistemas-certificados/

- ANVISA — perguntas e respostas sobre Software como Dispositivo Médico / RDC 657/2022:  
  https://www.gov.br/anvisa/pt-br/centraisdeconteudo/publicacoes/produtos-para-a-saude/manuais/software-como-dispositivo-medico-perguntas-e-respostas

## Benchmarks de produto — não são fontes regulatórias

- Epic: https://www.epic.com/
- Oracle Health: https://www.oracle.com/health/
- MEDITECH Expanse: https://ehr.meditech.com/
- InterSystems TrakCare: https://www.intersystems.com/br/produtos/trakcare/
- MV: https://mv.com.br/
- Philips Tasy: https://www.philips.com.br/healthcare/resources/landing/tasy
- HIMSS EMRAM: https://www.himss.org/maturity-models/emram/

---

# 44. REGRA DE ATUALIZAÇÃO REGULATÓRIA

Criar um **Regulatory Compatibility Registry** versionado no repositório.

Exemplo:

```yaml
rnds:
  models:
    RAC:
      implemented: true
      tested: true
      homologated: false
      production: false

tiss:
  organizational_version: "202607"
  content_version: "202511"
  communication_versions:
    - "04.03.00"
    - "01.06.00"
```

Os valores acima são apenas exemplo de estrutura; o registry real deve ser preenchido por evidência e atualizado com as publicações oficiais.

Pipeline deve alertar quando versão suportada estiver vencida/obsoleta.

---

# 45. PRODUCT NORTH STAR

O STARMED deve buscar uma experiência em que:

### Para o cidadão

“Eu sei o que está acontecendo com meu cuidado e qual é o próximo passo.”

### Para o profissional

“Eu encontro o que preciso sem lutar contra o sistema.”

### Para a enfermagem

“Minhas tarefas, riscos e checagens estão no fluxo do cuidado, não em planilhas paralelas.”

### Para a farmácia

“Prescrição, validação, estoque, dispensação e administração são um circuito único.”

### Para o gestor

“Eu sei onde a rede está falhando e consigo chegar à causa.”

### Para TI

“Eu sei o estado de cada integração, versão e dependência.”

### Para segurança/compliance

“Consigo provar quem fez o quê, quando, por qual motivo e sob qual autorização.”

---

# 46. CONCLUSÃO NORMATIVA

A evolução do STARMED deve seguir quatro movimentos simultâneos:

1. **Consolidar o que já existe**, especialmente APS, prontuário, interoperabilidade SUS, farmácia, laboratório, regulação, telediagnóstico, assinatura, IA e segurança.
2. **Completar as lacunas de plataforma**, principalmente MPI, hospitalar, revenue cycle privado/TISS, produção SUS completa, BNAFAR e supply chain enterprise.
3. **Redesenhar a experiência clínica**, substituindo navegação de ERP por um workspace contextual, adaptativo e orientado ao paciente.
4. **Provar maturidade**, com testes, homologações, certificações, SLOs, segurança, auditoria, DR e evidência operacional.

O objetivo final não é possuir o maior número de menus.

O objetivo é que o STARMED seja capaz de operar redes de saúde complexas com:

- **mais contexto clínico**;
- **menos cliques**;
- **menos retrabalho**;
- **mais interoperabilidade**;
- **mais rastreabilidade**;
- **mais segurança**;
- **melhor operação**;
- **melhor experiência para cidadão e profissional**.

---

## REGRA FINAL

> **Nenhum requisito deste documento deve ser considerado entregue sem evidência verificável.**
>
> Código não prova homologação.  
> Tela não prova fluxo.  
> Teste unitário não prova operação.  
> Certificado não substitui segurança contínua.  
> IA não substitui julgamento profissional.  
> Design visual não substitui UX.  
> Quantidade de features não substitui confiabilidade.
>
> O STARMED deve ser construído para unir todas essas dimensões no mesmo produto.
