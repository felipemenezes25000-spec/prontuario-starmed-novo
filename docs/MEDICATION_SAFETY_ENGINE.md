# Motor determinístico de segurança medicamentosa

> Implementado em 21/09/2026. Motor `1.0`, regras `2026.09.1`.

## Por que ele existe

A IA já lê a consulta e levanta hipóteses de alergia, interação e contraindicação. Isso é
útil — e não pode ser a **última** barreira: a mesma entrada pode produzir saídas
diferentes, e nada ali é auditável como regra.

O motor fecha essa lacuna por outro caminho:

```text
LLM ......... interpreta o caso, extrai medicamentos, estrutura dados, levanta hipóteses
MOTOR ....... aplica regras objetivas, versionadas, com o mesmo resultado sempre
MÉDICO ...... decide
```

As duas camadas convivem. Na tela elas aparecem **separadas e etiquetadas**, porque a
confiança que o médico deposita em cada uma é diferente:

```text
SEGURANÇA MEDICAMENTOSA

VERIFICAÇÃO AUTOMÁTICA
  Dipirona 500 mg · CRÍTICO
  Medicamento conflita com alergia registrada
  Regra allergy.mesmo.principio · versão 2026.09.1

OBSERVAÇÃO DA IA
  medicamento para pressão
  Paciente não soube informar o nome.
```

## Arquitetura

```text
backend-dotnet/src/RenoveJa.Application/Services/MedicationSafety/
├── MedicationSafetyContracts.cs        severidade, códigos, contexto, achado, resultado
├── MedicationNormalizer.cs             nome escrito → princípio ativo + números
├── IMedicationKnowledgeBase.cs         a abstração das regras
├── EmbeddedMedicationKnowledgeBase.cs  a implementação local (tabelas explícitas)
├── MedicationSafetyEngine.cs           o motor
├── MedicationSafetyDecision.cs         a decisão médica sobre um achado
├── MedicationSafetyRequestAssembler.cs pedido + paciente → contexto (caminho do servidor)
└── MedicationSafetyContextBuilder.cs   JSON clínico → contexto (teleconsulta)
```

### As duas formas de montar o contexto

| Caminho | Quem monta | Quando |
|---|---|---|
| `GET /api/requests/{id}/medication-safety` | **o servidor** — alergias, idade, peso e medicamentos em uso saem do prontuário do paciente; os candidatos saem dos itens estruturados que vão para o PDF | renovação de receita, e qualquer momento antes de assinar |
| `POST /api/requests/{id}/medication-safety` | **a tela** | prontuário vivo da teleconsulta, onde o que está sendo avaliado ainda não foi salvo |

O GET é o que vale como barreira: ele não depende de o cliente ter mandado o contexto
certo. `AllergiesReviewed` só fica verdadeiro quando há **pelo menos um registro** de
alergia — cadastro vazio é cadastro vazio, não paciente sem alergia.

- `IMedicationSafetyEngine` é injetado (`AddSingleton`) — puro, sem estado, sem I/O, sem
  LLM. A avaliação leva microssegundos.
- `MedicationSafetyEngine.Default` existe para o caminho síncrono dentro de
  `PostConsultationService`, seguindo o padrão já usado por `SmartIntakeEngine`.
- **Nada de lógica no controller.** O endpoint traduz DTO → contexto, chama o motor e
  audita.

### Entrada

O motor **não lê texto bruto**. Ele recebe `MedicationSafetyContext`:

| Campo | Observação |
|---|---|
| `Allergies` + `AllergiesReviewed` | lista vazia **sem** revisão é ignorância, não ausência de alergia |
| `ActiveMedications` | com `Identified` — "remédio pra pressão" entra marcado como não identificado |
| `Candidates` | o que está sendo prescrito |
| `AgeYears`, `WeightKg` | ausentes ⇒ regras que dependem deles produzem lacuna |
| `Pregnancy` | `Unknown` é estado de primeira classe |
| `Renal`, `Hepatic` | `null` = não se sabe; nunca "está normal" |

### Saída

```json
{
  "findings": [{
    "code": "ALLERGY_CONFLICT",
    "severity": "critical",
    "medication": "Dipirona 500 mg",
    "relatedTo": "Alergia registrada: dipirona",
    "title": "Medicamento conflita com alergia registrada",
    "description": "O medicamento tem o mesmo princípio ativo da alergia registrada.",
    "ruleId": "allergy.mesmo.principio",
    "ruleVersion": "2026.09.1",
    "requiresReview": true,
    "blocksAutomaticRelease": true,
    "source": "deterministic",
    "fingerprint": "allergy.mesmo.principio|ALLERGY_CONFLICT|dipirona 500 mg|alergia registrada dipirona"
  }],
  "rulesVersion": "2026.09.1",
  "hasCritical": true, "hasHigh": false, "requiresReview": true, "available": true
}
```

`source` é obrigatório e sempre `"deterministic"` nesta rota — é o campo que impede a UI de
misturar este achado com `alertas_seguranca_medicamentosa`, que vem do modelo.

## Decisão médica sobre um achado

`POST /api/requests/{id}/medication-safety/decisions`

| Decisão | Significa |
|---|---|
| `acknowledged` | o médico leu, mantém a conduta e assume. **Exige justificativa** |
| `corrected` | a receita mudou por causa do achado |
| `not_applicable` | o achado não se aplica (dado de cadastro errado, por exemplo) |

**Decidir não apaga o achado.** Ele continua na tela, agora com a decisão ao lado — quem
decidiu, o quê e por quê. Se sumisse, não haveria como distinguir "o médico avaliou" de
"alguém clicou para tirar da frente".

A decisão é gravada em `ConsultationProvenanceConfirmation`, estrutura que já existia e tem
a propriedade que importa: vive **fora** do JSON que a IA reescreve, então uma nova rodada
de anamnese, o encerramento ou o recovery não apagam o que o médico decidiu. Criar tabela
nova daria o mesmo resultado com mais migração. A chave natural do upsert inclui o hash de
decisão + justificativa, então editar a justificativa grava uma decisão nova em vez de
sobrescrever a anterior sem rastro.

`pendingRelevant` conta os achados `high`/`critical` **sem** decisão registrada. É o número
que mantém a exceção visível até a assinatura.

## Severidade

| Nível | Significa |
|---|---|
| `info` | documentação/orientação; não é julgamento clínico |
| `warning` | precisa ser revisado antes de emitir |
| `high` | risco clínico relevante; revisão obrigatória |
| `critical` | combinação potencialmente insegura; não pode passar despercebida |

Nenhum achado é chamado de "erro": o motor descreve risco, não reprova conduta.

## Regras implementadas

| Código | Situação | Gravidade |
|---|---|---|
| `ALLERGY_CONFLICT` | mesmo princípio ativo da alergia; reatividade cruzada declarada | critical / high |
| `ALLERGY_STATUS_UNKNOWN` | ninguém perguntou sobre alergia nesta consulta | warning |
| `DRUG_INTERACTION` | candidato × em uso **e** candidato × candidato | critical / high / warning |
| `ACTIVE_INGREDIENT_DUPLICATION` | mesmo princípio ativo duas vezes | high |
| `THERAPEUTIC_DUPLICATION` | dois da mesma classe (pode ser intencional) | warning |
| `DOSE_TOO_HIGH` | dose diária calculada acima do teto conhecido | high |
| `DOSE_TOO_LOW` | dose diária abaixo do piso terapêutico — **estrutura pronta, nenhuma regra da base de produção usa** | warning |
| `DOSE_REQUIRES_WEIGHT` | dose pediátrica em mg/kg com peso ausente | warning |
| `RENAL_ADJUSTMENT_REQUIRED` | TFG abaixo do limiar de contraindicação ou de ajuste | critical / high |
| `RENAL_DATA_MISSING` | a regra depende da TFG e ela não foi informada | warning / high |
| `HEPATIC_CONTRAINDICATION` | hepatopatia conhecida com fármaco hepatotóxico | high / warning |
| `HEPATIC_DATA_MISSING` | a regra depende da função hepática e ela não veio | warning |
| `PREGNANCY_RISK` | gestação/lactação com fármaco contraindicado | critical |
| `PREGNANCY_STATUS_MISSING` | a regra do fármaco exige saber, e não se sabe | warning |
| `AGE_CONTRAINDICATION` | faixa etária com regra concreta (AAS < 12 anos, etc.) | critical / high / warning |
| `ELDERLY_CAUTION` | ≥ 65 anos com fármaco de uso potencialmente inadequado | warning |
| `ROUTE_MISMATCH` | forma tópica prescrita por via oral | high |
| `POSOLOGY_INCOMPLETE` | falta dose, frequência ou duração | info |
| `MEDICATION_NOT_IDENTIFIED` | o nome escrito não identifica um princípio ativo | warning |
| `SAFETY_CHECK_UNAVAILABLE` | o motor falhou — ver *fail-safe* | warning |

**Ter 65 anos não é contraindicação de nada.** A cautela geriátrica é um achado próprio, de
gravidade própria, e só para os fármacos que constam na lista.

## Origem dos dados — o que é curadoria e o que é exemplo

Cada regra carrega o próprio `Source`:

| Origem | O que é | Onde aparece |
|---|---|---|
| `curadoria-interna` | `DrugSynonymDatabase`, que já existia no repositório: 138 sinônimos comerciais → princípio ativo, listas da Portaria 344/98, contraindicados na gestação, inadequados em idosos | normalização, gestação, idoso |
| `bula-literatura` | interação/limite de uso corrente em bula e literatura de referência | interações, doses máximas, regras renais/hepáticas, faixa etária |
| `fixture` | regra de exemplo, viva só para exercitar o motor | *nenhuma regra usa esta origem hoje* |

**Isto não é uma base farmacológica.** São ~65 princípios ativos conhecidos pela curadoria,
8 interações diretas, 4 interações por classe, 5 tetos de dose, 5 regras renais, 2
hepáticas e 3 de faixa etária. Não cobre "todos os medicamentos" e não cobre todas as
interações de nenhum dos fármacos listados. Não substitui bula, Micromedex, UpToDate nem
farmacêutico clínico.

Por isso a tela **nunca** escreve "medicamento seguro", "prescrição segura" ou "sem risco".
A frase é sempre:

> Nenhum conflito detectado pelas regras disponíveis.

## Fail-safe

Falha interna **nunca** vira "nenhum risco encontrado":

- o motor captura qualquer exceção e devolve `Available = false` com um achado
  `SAFETY_CHECK_UNAVAILABLE`;
- o cliente faz o mesmo para falha de rede (`unavailableResult`), porque ausência de bloco
  na tela lê-se como ausência de risco;
- a UI mostra *"Não foi possível concluir a verificação automática. Revisão manual
  necessária."*

## Versionamento

São **duas** versões, porque mudam por motivos diferentes:

- `MedicationSafetyVersions.Engine` (`1.0`) — muda quando a forma de avaliar muda: ordem,
  severidade, fingerprint;
- `EmbeddedMedicationKnowledgeBase.Version` (`2026.09.1`) — muda quando a farmacologia muda.

As duas vão gravadas em **cada achado** e em cada registro de auditoria. Com uma só, não
daria para responder "por que este achado de março saiu diferente do de setembro?".

## Idempotência

`Fingerprint` = `ruleId | code | medicamento normalizado | relacionado normalizado`.

Rodar o motor duas vezes com o mesmo contexto produz os mesmos achados, na mesma ordem
(gravidade desc, depois código, depois medicamento). Achados duplicados são colapsados pela
impressão digital antes de sair.

## Onde ele roda

| Superfície | Caminho | Quando |
|---|---|---|
| Prontuário vivo (web e app) | POST | quando o **conteúdo avaliado** muda — alergias, medicamentos em uso ou receita. Nunca a cada tecla: uma chave de conteúdo evita o laço com o autosave |
| Central de Revisão (web e app) | POST | mesma coisa, antes da assinatura |
| Editor de receita V2 (web) | GET | quando os itens da receita mudam |
| Conferência da receita (app) | GET | idem |
| `PostConsultationService` | interno | no **servidor**, sobre o que está de fato sendo emitido |

Todas as rotas exigem médico dono do pedido, e valem para **qualquer tipo de pedido** — a
renovação de receita precisa da mesma checagem que a teleconsulta.

## Auditoria

Achado `high` ou `critical` é gravado em `audit_logs` com `entityType =
consultation_medication_safety`, nas ações:

- `medication_safety_checked` — consulta feita pela tela;
- `medication_safety_at_emission` — avaliação do servidor na emissão.

- `medication_safety_decision` — decisão médica registrada.

O metadado guarda `engine_version`, `rules_version`, `available`, `critical`, `high` e, por
achado, `code`, `severity`, `ruleId`, `ruleVersion`, `engineVersion` e `fingerprint`. **Sem nome de paciente e sem texto
livre da consulta.**

É isso que responde depois à pergunta que importa: *este risco existia quando ele assinou, e
sob qual conjunto de regras?*

## Política antes de assinar

Hoje o motor **não bloqueia** a emissão. Isso é deliberado: impedir a decisão clínica do
médico é definição de produto e jurídica, não de código. O que está garantido é que um
achado crítico **não desaparece em silêncio** — ele aparece na tela e fica na auditoria.

`BlocksAutomaticRelease` marca os achados que impediriam uma liberação **automática** (sem
humano no meio). Nenhum fluxo hoje libera documento sem médico; o campo existe para o dia
em que existir.

**O override existe e é registrado** — ver "Decisão médica sobre um achado". O que ele NÃO
faz é apagar o achado.

## Como acrescentar uma regra

1. Abra `EmbeddedMedicationKnowledgeBase.cs` e acrescente a linha na tabela certa, **com
   `Source`**. Se o princípio ativo ainda não existir, acrescente antes o sinônimo em
   `DrugSynonymDatabase` — é ele que faz a normalização.
2. **Suba `EmbeddedMedicationKnowledgeBase.Version`.** A auditoria usa esse número para
   dizer quais regras avaliaram cada receita; mudar regra sem mudar versão apaga essa
   resposta.
3. Escreva o teste em `MedicationSafetyEngineTests.cs` — um caso que dispara e um que
   **não** dispara. Regra sem o caso negativo vira falso positivo silencioso.
4. Rode a mutação: quebre a regra de propósito e confirme que o teste reprova. Teste verde
   que nunca foi mutado não está provado.

Para trocar a base inteira por uma fonte validada, implemente `IMedicationKnowledgeBase` e
registre a nova implementação no container. O motor e os testes de motor não mudam.

## Como testar

```bash
cd backend-dotnet && dotnet test tests/RenoveJa.UnitTests/RenoveJa.UnitTests.csproj -c Release --filter "FullyQualifiedName~MedicationSafety"
```

```bash
cd frontend-web && npx vitest run src/components/doctor/__tests__/MedicationSafetyPanel.test.tsx src/lib/__tests__/medication-safety-input.test.ts
```

```bash
cd frontend-mobile && npx jest components/clinical lib/__tests__/medication-safety-input.test.ts --maxWorkers=2
```

## Limitações conhecidas

1. **Cobertura farmacológica pequena.** Ver "Origem dos dados". O motor acrescenta
   segurança; não a garante.
2. **Sem dose por peso de verdade.** O motor detecta que o peso falta; ele não calcula
   mg/kg.
3. **Função renal só por TFG informada.** Não há cálculo de clearance a partir de
   creatinina, idade e sexo.
4. **Hepática é binária.** Child-Pugh existe no contrato e ainda não tem regra que o use.
   AST/ALT isolados **não** entram, de propósito: transaminase alterada não é insuficiência
   hepática.
5. **Gestação e peso não chegam estruturados hoje.** O caminho do servidor (`FromClinicalJson`)
   lê alergias e medicamentos em uso; gestação, peso e função renal só chegam quando a tela
   os envia. Nada disso é deduzido de texto livre — deduzir seria exatamente o chute que
   esta camada existe para não dar.
6. **Sem via de administração estruturada na emissão.** `ROUTE_MISMATCH` depende do campo
   de via, que a receita nem sempre traz.
7. **`DOSE_TOO_LOW` não tem regra operacional.** A estrutura existe e é exercitada por
   fixture; a base de produção não traz piso terapêutico para nenhum fármaco, porque
   "abaixo do usual" sem referência é chute.
8. **Gestação e função renal continuam sem origem estruturada.** Nem o caminho do servidor
   as infere de comorbidade em texto: uma condição "doença renal crônica estágio 4" é
   registrada como comorbidade e **não** vira TFG.
