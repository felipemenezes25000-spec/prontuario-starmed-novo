# Protocolo do piloto clínico controlado — StarMed ambulatorial

- **Versão:** 1.0 (2026-10-23)
- **Status:** RASCUNHO para aprovação da direção clínica, do DPO e do jurídico.
- **Natureza:** implantação controlada de software em serviço de saúde. **Não é pesquisa clínica com intervenção terapêutica.** Se a instituição quiser publicar os resultados como pesquisa, submeter antes ao Comitê de Ética (CEP/CONEP, Res. CNS 466/2012 e 510/2016) — decisão do jurídico e da direção clínica.

## 1. Objetivo

Demonstrar que médicos e equipe concluem atendimentos ambulatoriais reais no StarMed **com segurança, sem perda de dados e em tempo aceitável**, medindo:

- tempo de tarefa;
- incidentes e quase-incidentes;
- disponibilidade;
- satisfação.

## 2. Escopo do piloto (mínimo e reversível)

| Entra | Fica DESLIGADO no piloto |
|---|---|
| Agenda, cadastro (CPF/CNS), prontuário 360°, evolução SOAP, alergias/problemas (CID-10), adendos, receita **simples** atestada + PDF + verificação pública, pedidos/resultados de exame sem integração LIS, portal do paciente (documentos), auditoria | IA clínica (`AI_API_URL` vazio), teleconsulta com gravação, antimicrobiano (`FEATURE_ANTIMICROBIAL_RX`), controle especial (bloqueado por SNCR), programa 344 hospitalar, integrações externas (LIS/PACS/RNDS/TISS/NFSe), modo offline |

A receita PAdES ICP-Brasil só entra se o item 2.1 do [plano de homologações](PLANO_HOMOLOGACOES.md) estiver concluído. Até lá, a receita sai **atestada** e a instituição mantém o fluxo de assinatura que já usa.

## 3. Local, participantes e duração

- **Local:** 1 clínica ou ambulatório, 1 unidade, especialidades de baixa complexidade (clínica geral, mais 1 a 2 especialidades).
- **Participantes:** 3 a 6 médicos, 2 a 4 profissionais de recepção/enfermagem e 1 administrador. Todos voluntários, treinados e com termo de ciência.
- **Duração:** 8 semanas.
  - Semanas 1–2, **sombra:** o sistema atual continua sendo o oficial; o StarMed é preenchido em paralelo.
  - Semanas 3–8, **uso primário:** o StarMed vira o oficial, com plano de contingência ativo.
- **Volume esperado:** 300 a 1.000 atendimentos (dimensionar com a clínica).

## 4. Pré-requisitos (gate de início — todos obrigatórios)

| # | Pré-requisito | Evidência |
|---|---|---|
| P1 | Pacote de revisão clínica e regulatória assinado para o escopo da seção 2 | [PACOTE_REVISAO_CLINICA_REGULATORIA.md](PACOTE_REVISAO_CLINICA_REGULATORIA.md) com assinaturas |
| P2 | Pentest independente sem achado crítico/alto aberto | Relatório e reteste (plano de homologações, item 2.6) |
| P3 | Ambiente de produção isolado | TLS, backup e PITR, restore testado com RTO/RPO medidos (`docs/BACKUP_RUNBOOK.md`) |
| P4 | LGPD | Base legal (art. 11, II, "f" — tutela da saúde), RIPD/DPIA, contrato controlador–operador, aviso de privacidade |
| P5 | Contingência assistencial | Formulário em papel e procedimento de reconciliação, treinados |
| P6 | Suporte | Canal com tempo de resposta definido e on-call durante o horário do piloto |
| P7 | Critérios de parada | Seção 7, aceitos por escrito pela direção clínica |

## 5. Métricas (sem PHI; denominadores sempre explícitos)

| Métrica | Como medir | Meta para aprovar o piloto |
|---|---|---|
| Incidentes de segurança do paciente atribuíveis ao sistema | Notificação obrigatória + revisão semanal | **0 graves**; quase-incidentes analisados com ação corretiva |
| Troca de paciente (documento no prontuário errado) | Auditoria amostral de 5% dos atendimentos + notificações | **0** |
| Perda de dado clínico | Notificações + conferência de autosave e conflitos | **0** |
| Disponibilidade no horário assistencial | Monitor externo de `/health` a cada 1 min | ≥ 99,5% no período |
| Tempo para abrir o prontuário (p95) | `GET /metrics/perf` (evento `open_record`) | ≤ 2 s |
| Tempo de atendimento documentado (mediana) | Diferença entre abertura do encontro e assinatura da nota (consulta agregada, sem PHI) | Linha de base do sistema atual (semanas 1–2) **sem piora > 10%** |
| Satisfação (SUS) | Questionário SUS na semana 8 (`scripts/estudo/sus-questionario.md`) | Mediana ≥ 68; meta aspiracional 80 |
| Alertas de segurança medicamentosa | Contagem de bloqueios, overrides e justificativas (auditoria) | Taxa de override < 30%; todo override com justificativa revisada |
| Chamados de suporte por 100 atendimentos | Ferramenta de suporte | Tendência de queda da semana 3 para a 8 |

## 6. Rotina

- **Diária:** checagem de disponibilidade, fila de integrações (vazia, pois tudo está desligado) e backups.
- **Semanal:** comitê de 30 min (médico responsável, engenharia, DPO) para rever incidentes, quase-incidentes, métricas e chamados. Ata em `docs/estudo/evidencias/<data>/`.
- **Correções:** ciclo normal (CI verde, push na `main`, deploy com rollback pronto). Mudança clínica só com aprovação do médico responsável.

## 7. Critérios de PARADA imediata

O sistema volta para contingência e o piloto é suspenso até análise se ocorrer qualquer um destes:

- evento adverso grave ou óbito com possível contribuição do sistema;
- documento associado ao paciente errado;
- perda de dado clínico confirmada;
- vazamento ou acesso indevido a dado de saúde (acionar o `PLANO_RESPOSTA_INCIDENTES.md` e avaliar comunicação à ANPD);
- indisponibilidade > 2 h no horário assistencial;
- solicitação da direção clínica, a qualquer momento.

## 8. Saída

Relatório final em até 15 dias após a semana 8: métricas da seção 5 com denominadores, incidentes e ações, limitações, decisão GO/NO-GO para ampliar.

Só com este relatório é possível afirmar algo como "usado em N atendimentos reais com 0 incidentes graves atribuíveis".
