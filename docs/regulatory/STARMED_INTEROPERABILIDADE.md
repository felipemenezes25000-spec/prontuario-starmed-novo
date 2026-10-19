# StarMed — interoperabilidade (e-SUS APS/LEDI, RNDS, PEC, CADSUS)

> Branch: `PROJETO-STARMED` · Atualizado em: 22/09/2026 · Blocos N, O, P e Q do super prompt

**Resumo honesto:** o pipeline é fail-closed de ponta a ponta e **nada é transmitido hoje**. Não há
serializador LEDI oficial nem construtor de Bundle FHIR para a RNDS; todo evento de produção fica
`blocked_prerequisite` com o motivo. Nenhuma tela afirma "enviado" ou "aceito" sem protocolo externo.

## 1. Produção APS (e-SUS APS / LEDI)

```text
Encounter final ──▶ outbox (sus.aps.encounter.validated.v1) ──▶ portão de contrato ──▶ mapeador
   │                                                          (APS/REL: dispensado)     │
   │                                                                                     ▼
   │                                    leitor canônico sus-aps-canonical-v1 ──▶ prontidão (CPF/CNS, CNES,
   │                                                                               INE, CBO, CIAP-2, CID-10,
   │                                                                               SIGTAP, datas)
   │                                                                                     ▼
   │                            versão LEDI da instalação PEC ──▶ validação de schema ──▶ serializador
   │                                                                                     ▼
   └──── linha longitudinal: status real ◀── ledger de resposta ◀── adapter e-SUS APS (HTTP)
```

| Etapa | Estado |
|---|---|
| Quem entra na fila | atendimento regulado com conduta validada (gatilho) **e, desde 22/09/2026, o atendimento presencial da UBS ao finalizar** — antes ficava fora da produção |
| Portão de contrato | exige `contractProfileId` para RAC e regulação; **produção APS e REL são do município e passam sem contrato** (antes o presencial e o REL ficavam presos com "sem contractProfileId") |
| Leitor canônico | corrigido em 22/09/2026 — juntava `users.id = encounters.patient_id` e não achava encontro nenhum; lê UBS/CNES/INE/CBO do presencial |
| Prontidão | `SusReadinessValidator` + `SusApsTransmissionValidator`: formato de CPF/CNS/CBO/CNES/INE/CIAP-2/CID-10, data no futuro, competência SIGTAP; agora reconhece CNS verificado e SIGTAP confirmado |
| Versões LEDI | declaradas 4.0–4.5, 5.0–5.2, 5.3–5.4 (compatibilidade com o PEC); **nenhuma suportada** — sem serializador oficial; sem datas de vigência cadastradas (não inventadas) |
| Serializador | **não existe** para produção (só um falso em teste unitário) → `LEDI_OFFICIAL_ARTIFACT_REQUIRED` |
| Adapter | `EsusApsAdapter` é HTTP real (login + ficha `.esus`). **Destino por município** (desde 22/09/2026, `SettingsEsusInstitutionTargets`): a linha `esus_aps.ledi.write` do município em `sus_integration_settings` dá o endereço do PEC dele e a referência da credencial (`SusSecrets:{ref}:usuario`/`:senha`); linha desligada, em ambiente de teste, sem HTTPS ou com referência que não resolve **bloqueia** como pré-requisito e nunca cai no PEC global; município sem linha segue no global (`Ledi:*`). Antes a produção de todos os municípios iria para o mesmo PEC |
| Fila | bloqueio não gasta tentativa (desde 22/09/2026; antes, semanas bloqueado esgotavam a cota e a primeira falha real ia para dead-letter); espera cresce com a idade do evento (6h→12h→24h) |
| Recibo | ledger `sus_external_response_ledger`; **"aceito" só com protocolo** — 2xx sem protocolo aparece como "recebido sem protocolo, confirme no SISAB" |
| Recusa | **permanente × transitória** (desde 22/09/2026, `SusExternalFailure`): 400/404/409/410/413/415/422 e payload inválido → `dead_letter` na hora com `[EXTERNAL_REJECTED]` (corrigir e reprocessar), sem abrir o disjuntor do destino; 401/403 → `blocked_prerequisite` com `[EXTERNAL_AUTH_REQUIRED]`, sem gastar tentativa; 408/429/5xx/rede → nova tentativa. Antes toda recusa era "transitória": um 422 era reenviado oito vezes |
| Evento preparatório | `sus.clinical.encounter.finalized.v1` (consulta encerrada) não transmite por desenho — quem publica é o "validated". Ficava `pending` para sempre; agora o worker o conclui sem transmitir e a retenção o apaga. Fora do monitor |

Status mostrados na linha longitudinal: `structured_only` (registrado, não enviado) · `queued` ·
`blocked` · `failed` · `processed_without_receipt` · `received_without_protocol` · `accepted` (com
protocolo) · `rejected` · `legacy_import` (histórico, não reenviado).

## 2. RNDS (bloco O)

- `RndsAdapter`/`RndsClient` existem (POST de Bundle FHIR R4, protocolo pelo `Location`), com
  credencial global;
- **não há mapeador que monte Bundle** (RAC, RIRA, REL bloqueiam com o modelo oficial requerido);
- capacidades RNDS ficam "artefato ausente"; nenhum painel marca pronto para produção;
- **RIRA/MIRA (regulação)**: o evento vem do gatilho de `clinical_referrals` com
  `careCoordinationId`. Desde 22/09/2026 o mapeador lê esse escopo e bloqueia com
  `OFFICIAL_RIRA_MODEL_REQUIRED`; antes herdava a montagem do encontro e **todo** evento MIRA
  travava com "payload não traz encounterId", escondendo o motivo real.

## 2b. Regulação externa (SISREG / e-SUS Regulação)

- adaptadores de leitura existem e ficam não operacionais sem capacidade habilitada;
- a reconciliação (a cada 15 min) consulta o **protocolo externo** (o que vem depois de `ext=`
  no marcador `rj:type=...;ext=...`). Antes mandava o marcador inteiro e varria encaminhamento
  sem protocolo nenhum;
- resposta repetida **não duplica** `regulation_external_status_history` nem reavisa o cidadão:
  só grava quando status, protocolo, agenda ou destino mudam, com lock por encaminhamento. A
  chave única antiga incluía `observed_at` (relógio da consulta) e não deduplicava nada;
- a situação consolidada da fila municipal usa o último status externo visto
  ([STARMED_GESTAO_MUNICIPAL.md](STARMED_GESTAO_MUNICIPAL.md) §3).

## 2c. Laboratório (LIS)

- `LisBoundaryAdapter` (chave `lis`, capacidade `diagnostics.exchange`) registrado e **não
  operacional**, com o bloqueio `lis_interface_specification_required`. Não há LIS simulado;
- a UBS registra as etapas do pedido e anexa o laudo à mão
  ([STARMED_OPERACAO_UBS.md](STARMED_OPERACAO_UBS.md) §3b). O resultado revisado com
  município gera o evento REL, que bloqueia com `OFFICIAL_REL_MODEL_REQUIRED`.

## 3. PEC externo (bloco P)

- Existe o lançamento a partir do PEC (`PecLaunchService`: origem, assinatura, janela de tempo,
  nonce, sessão `identity_only`) e o provedor de contexto somente leitura;
- `IPecGateway` + `PecCapabilities` (desde 22/09/2026) com os modos `not_configured`,
  `launch_only`, `read_only`, `write_only`, `read_write`. A implementação de hoje,
  `ContractlessPecGateway`, tira o modo do cadastro real da instalação PEC: sistema externo
  habilitado e segredo de assinatura configurado → **`launch_only`**; senão `not_configured`.
  Busca, leitura e escrita de prontuário respondem `capability_not_supported` com o motivo —
  sem contrato técnico/API daquele PEC não há o que implementar sem inventar;
- a Rede APS do gestor mostra o modo e o motivo;
- a StarMed mantém prontuário próprio e **nunca** acessa banco de PEC. Um PEC com contrato de API
  entra como outra implementação de `IPecGateway`, sem mudar quem chama.

## 4. CADSUS / identidade (bloco Q)

- consulta PDQ real quando configurada; sem configuração, adapter de fronteira que não finge resposta;
- **retorno divergente vira conflito** (desde 22/09/2026): o CNS divergente é gravado sem
  verificação e com nota de conflito; o CNS verificado anterior continua valendo para produção e
  linha longitudinal. Antes o divergente nascia "verificado" e, sendo o mais recente, substituía o
  correto;
- o resolvedor de identidade ainda não tem consumidor que persista o resultado (a busca CADSUS da
  UBS não grava vínculo) — pendência.

## 5. Monitor da fila (gestor)

`/gestor/automacao-sus`: contagens e eventos **do município, filtrados no banco** (antes, "os N mais
recentes de todos" deixavam um município movimentado esconder a fila de outro); "processado" só
vira "aceito" com protocolo. O reprocessamento manual deixa trilha (`SusOutboxRetry`).

## 6. Pendências (dependem de terceiro ou de decisão)

| Pendência | Depende de |
|---|---|
| Serializador LEDI oficial (Thrift/XML da versão contratada) | especificação oficial + homologação |
| Credencial RNDS por município/estabelecimento (hoje global; o e-SUS já resolve por município) | certificado ICP-Brasil e identificador solicitante de cada estabelecimento credenciado na RNDS |
| Bundle FHIR RNDS por perfil habilitado | credenciamento RNDS + perfis homologados |
| Leitura/escrita no PEC de terceiro (a abstração existe) | contrato técnico/API do PEC do município |
| Persistência do resultado CADSUS na busca da UBS | decisão de produto (quando gravar vínculo) |
| LIS: envio do pedido e retorno do laudo estruturado | especificação do LIS do laboratório contratado |
| SISREG/e-SUS Regulação: envio da solicitação (hoje só leitura/reconciliação) | credencial e contrato de interface da regulação estadual/municipal |
