# StarMed Health OS — arquitetura de referência

> Especificação normativa: `STARMED-MASTER-SPEC` (23/09/2026). Este documento traduz os §1, §3,
> §29 e §41 da especificação para as convenções **executáveis** do repositório. Estado de cada
> capacidade: [STARMED_CAPABILITY_MATRIX.md](STARMED_CAPABILITY_MATRIX.md) (gerado de
> `capability-matrix.json`). Estado regulatório:
> [../compliance/REGULATORY_COMPATIBILITY_REGISTRY.md](../compliance/REGULATORY_COMPATIBILITY_REGISTRY.md).

## 1. Um núcleo, pacotes ativáveis

Não existem produtos paralelos ("StarMed SUS", "StarMed Hospital"). Existe um núcleo canônico —
paciente/cidadão, prontuário longitudinal, identidade, terminologia, auditoria, autorização — e
**pacotes ativados por município/instituição** (`starmed_pack_activations`, ADR-010):

| Pacote | O que liga |
|---|---|
| `public_health` | território, APS, regulação, vigilância, imunização, busca ativa |
| `aps` | fila da UBS, atendimento presencial, vacinação, dispensação |
| `hospital` | ADT, mapa de leitos, enfermagem, eMAR, UTI, centro cirúrgico, CCIH |
| `emergency` | pronto atendimento com classificação configurável e tempos porta-X |
| `ambulatory` | agenda ambulatorial e especialidades |
| `diagnostic` | laboratório, imagem, anatomia patológica |
| `pharmacy` | estoque, validação farmacêutica, dispensação, BNAFAR |
| `supply_chain` | compras, almoxarifado, patrimônio, OPME, CME |
| `private_billing` | convênios, TISS/TUSS, elegibilidade, autorização, glosa, conciliação |
| `sus_billing` | SIGTAP, pré-glosa, BPA/APAC/AIH |
| `telehealth` / `telediagnostics` | teleconsulta e telediagnóstico |
| `population_health` | lacunas de cuidado, indicadores explicáveis, command center |
| `intelligence` | gateway de IA, copilotos, previsões |
| `developer_platform` | clientes de API, webhooks, FHIR |

Pacote desligado **não esconde dado**: bloqueia a escrita nova daquele domínio e a tela diz por
quê. O dado já registrado continua no prontuário longitudinal.

## 2. Estilo: monólito modular rigoroso

Quatro projetos em camadas (Domain → Application → Infrastructure → Api), travados por
`CamadasTests`. Dentro deles, **bounded contexts** com pasta própria. Não há microserviço: a
extração só se justifica com motivo operacional medido (§3.1).

### Onde mora cada coisa (contextos novos a partir de 23/09/2026)

```text
RenoveJa.Application/StarMed/<Contexto>/      DTOs, regras puras (static), interfaces da store
RenoveJa.Infrastructure/StarMed/<Contexto>/   store Dapper + SchemaSql (DDL idempotente)
RenoveJa.Api/Controllers/StarMed<Contexto>Controller.cs
frontend-web/src/features/<contexto>/         api/, components/, pages/, types/, __tests__/
```

Rota: `api/starmed/<contexto>/institutions/{institutionId}/...`. O prefixo `StarMed` no nome do
controller não é estética: é o que coloca a ação sob `StarMedAuditCoverageTests` (toda escrita
deixa trilha) e `StarMedLogSemConteudoClinicoTests`; a pasta `Infrastructure/StarMed/` é o que a
coloca sob `StarMedTenantScopeRatchetTests` (toda consulta recorta município).

### Bounded contexts e dono do dado

| Contexto | Tabelas (prefixo) | Dono |
|---|---|---|
| Identity & Access | `users`, `institution_memberships`, `starmed_break_glass_*` | plataforma |
| Master Patient / Citizen (MPI) | `patients`, `citizen_external_identities`, `starmed_mpi_*` | núcleo |
| Terminology | `starmed_terminology_*` | núcleo |
| Organization | `institutions`, `health_units`, `starmed_org_*` | núcleo |
| Clinical Record | `encounters`, `medical_documents`, `exam_results`, `starmed_presential_*` | núcleo |
| APS | `aps_*`, `starmed_ubs_queue_*` | APS Pack |
| Regulation | `clinical_referrals`, `clinical_referral_transitions`, `regulated_appointments` | Public Health Pack |
| Laboratory | `starmed_lab_*`, `exam_results` | Diagnostic Pack |
| Pharmacy | `starmed_pharmacy_*`, `aps_medication_dispensations` | Pharmacy Pack |
| Inpatient/ADT, Nursing, Surgery, ICU | `starmed_adt_*`, `starmed_nursing_*`, `starmed_surgery_*`, `starmed_icu_*` | Hospital Pack |
| Emergency | `starmed_ed_*` | Emergency Pack |
| Medication (hospitalar) | `starmed_med_*` | Hospital Pack |
| SUS Billing | `starmed_sigtap_*`, `starmed_sus_production_*` | SUS Billing Pack |
| Private Billing | `starmed_payer_*`, `starmed_tiss_*`, `starmed_claim_*` | Private Billing Pack |
| Supply Chain & Assets | `starmed_supply_*`, `starmed_asset_*`, `starmed_cme_*` | Supply Chain Pack |
| Population Health | `starmed_care_gap_*`, `starmed_kpi_*` | Population Health Pack |
| Intelligence | `ai_interaction_logs`, `starmed_ai_*` | Intelligence Pack |
| Developer Platform | `starmed_api_*`, `starmed_webhook_*` | Developer Platform |
| Audit & Compliance | `audit_events`, `audit_logs`, evidência pública | plataforma |

## 3. Regras de dependência (executáveis)

| Regra (§3.2 / §41) | Portão |
|---|---|
| Domain não depende de Infrastructure | `CamadasTests` |
| Controller não acessa SQL | `PersistenciaTests.Nenhum_controller_novo_acessa_a_camada_de_persistencia` |
| Consulta sem recorte de município | `StarMedTenantScopeRatchetTests`, `SusTenantScopeRatchetTests` |
| Integração externa sem timeout | `IntegracaoExternaComTimeoutTests` |
| Fake/Demo em produção | `ProductionCompositionGuard` (boot) + `ProducaoSemSimulacaoTests` |
| Escrita sem trilha de auditoria | `StarMedAuditCoverageTests` |
| Endpoint sem decisão de acesso | `AcessoDosControllersTests` |
| Log com conteúdo clínico | `StarMedLogSemConteudoClinicoTests`, `ClinicalContentNotLoggedTests` |
| `any` em contrato crítico do web | `tseslint` recommended + `starmed-health-os-contract.test.mjs` |
| Migration fora do mecanismo oficial | `SchemaReachableFromMigrationRunnerTests`, `SchemaSnapshotDivergenceTests` |
| Migration que não deixa o que promete | `SqlGroupMigration.VerifyAsync` (boot) |
| Evidência imutável com FK para `users` | `MigrationSchemaHygieneTests.EvidenciaStarMedImutavel_NaoTemFkParaUsers` |

## 4. Receita de um módulo novo (definition of done técnica, §35)

1. **Schema**: `SchemaSql` na store; tabela com `institution_id NOT NULL`; sem FK para `users`
   (ids de pessoa são repontados pela lápide LGPD); registros de evidência com gatilho
   append-only que só deixa mudar as colunas de pessoa.
2. **Catálogo**: `StarMedSchemaCatalog.AllSql`/`MigrationSql`, policy RLS em `Scoped`, tabela de
   evidência em `ImmutableEvidenceTables`, passo em `LgpdErasurePlan` (+ lista opcional).
3. **Regra**: classe estática em `Application/StarMed/<Contexto>/` com as validações puras —
   testável sem banco.
4. **Store**: todo `WHERE` com `institution_id = @institutionId`; concorrência por `FOR UPDATE`
   ou `row_version`; `StarMedStateConflictException`/`KeyNotFoundException`/`ArgumentException`
   para o controller mapear em `ApiProblem`.
5. **Controller**: autorização real (`CanManageInstitutionAsync`, `CanWriteClinicalAtUnitAsync`,
   `CanReadCitizenClinicalAsync`, permissão do catálogo) e `audit.LogWriteAsync` em toda escrita.
6. **Testes**: unidade (regra), integração (banco real: fluxo, isolamento entre municípios,
   imutabilidade, concorrência), e2e (tela nos 5 tamanhos com axe).
7. **Docs**: capacidade na matriz com evidência; registro regulatório quando houver padrão externo.

## 5. Hierarquia multi-tenant (§29)

```text
Plataforma
└── Tenant = institution (município, estado, rede privada, hospital)
    └── Facility = health_unit (UBS, hospital, policlínica — CNES)
        └── Department = starmed_org_departments (ala, setor, serviço)
            └── Location = starmed_org_locations (quarto, leito, sala, box, consultório)
```

`institution_id` é o recorte de toda consulta; `health_unit_id` é o recorte da escrita clínica.
