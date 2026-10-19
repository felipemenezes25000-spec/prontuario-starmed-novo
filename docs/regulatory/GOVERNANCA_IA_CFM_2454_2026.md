# Governança de IA — Resolução CFM nº 2.454/2026

**Sistema:** RenoveJá+ / Public Service  
**Data-base:** 26/08/2026  
**Estado:** baseline técnica e operacional; não substitui parecer jurídico/regulatório.

## Princípio de autoridade

IA no RenoveJá é **apoio**, nunca autoridade clínica. Nenhum modelo pode, sozinho:

- diagnosticar como ato final;
- aprovar ou rejeitar receita em nome do médico;
- prescrever ou assinar documento clínico;
- autorizar regulação pública;
- definir preço, glosa ou pagamento;
- publicar dados na RNDS/e-SUS como decisão clínica autônoma.

A decisão final é do profissional habilitado e deve ser rastreável.

## Controles já existentes no código

| Controle | Evidência técnica | Estado |
|---|---|---|
| Revisão humana antes de documento assinado | `PrescriptionReviewGate` + `ReviewedByDoctorAt/Id` | implementado |
| Registro de decisão humana sobre sugestão | `IAiSuggestionTrail` / `AiSuggestionTrail` | implementado |
| Causalidade request → usuário → execução | `AiExecutionTraceScope` / contexto de IA | implementado |
| Minimização de PII antes do LLM | `PromptSanitizer` | implementado |
| Registro de interação sem depender de conteúdo bruto | `AiInteractionLog` / logging handler | implementado |
| Bloqueio quando IA sinaliza alto risco/dúvida sem justificativa médica | `RequestApprovalService` | implementado |
| Trilha de auditoria clínica | audit events / evidence ledger | implementado |
| Provedores declarados | OpenAI + Google/Gemini; vídeo/transcrição separados | documentado |

## Regras obrigatórias de operação

1. Toda funcionalidade de IA clínica deve declarar finalidade, modelo/provedor e ponto de revisão humana.
2. Conteúdo gerado por IA que possa aparecer em documento clínico deve ser persistido **antes** da assinatura e passar por confirmação humana.
3. Troca de modelo, provedor ou prompt clínico relevante deve ser tratada como mudança controlada, com teste de regressão e registro de versão.
4. Fluxos de alto risco devem falhar fechados quando a revisão humana obrigatória não puder ser comprovada.
5. A UI deve distinguir conteúdo sugerido por IA de conteúdo confirmado pelo profissional.
6. O profissional continua livre para alterar, rejeitar ou ignorar a sugestão.
7. O sistema deve conseguir demonstrar, para um episódio específico, quem tomou a decisão final e em que momento.

## Evidência mínima por episódio

Quando IA tiver participação clínica relevante, o dossiê técnico deve permitir reconstruir:

- `request_id` / episódio;
- finalidade da chamada;
- provedor e modelo;
- versão do fluxo/prompt quando disponível;
- horário;
- usuário/profissional responsável;
- hash/receipt técnico quando aplicável;
- decisão humana posterior (`approved`, `rejected`, `overridden` ou equivalente);
- documento final e assinatura, se houver.

Não é necessário persistir prompt/resposta clínica bruta em superfícies de auditoria externa quando isso aumentar exposição de dado sensível; receipts e hashes podem preservar prova técnica com minimização.

## Mudança de modelo/provedor

Antes de promover um novo modelo para produção clínica:

1. validar segurança e política do provedor;
2. executar dataset de regressão sem dado real desnecessário;
3. comparar extração/triagem com baseline anterior;
4. testar recusas, conteúdo incompleto e alucinação;
5. registrar versão e data da promoção;
6. manter rollback;
7. revisar RIPD/ROPA se mudar operador, suboperador, país de processamento ou finalidade.

## Privacidade e operadores

OpenAI, Google/Gemini, Daily/Deepgram e AWS devem constar de forma coerente em ROPA/RIPD/política pública conforme o fluxo efetivamente utilizado. DPA/addendum e mecanismo de transferência internacional são evidências contratuais externas: **código não substitui contrato com operador**.

## Pendências externas antes de declarar conformidade plena

- comprovar DPAs/addendums aplicáveis;
- resolver e publicar um único Encarregado/DPO conforme ato formal vigente;
- comprovar execução de testes de regressão do mesmo commit liberado;
- anexar evidências de homologação de fluxos clínicos que usem IA;
- manter revisão periódica do inventário de modelos/provedores.

## Regra de comunicação comercial

Permitido: “IA de apoio, com revisão e decisão final do profissional”.  
Evitar: “IA diagnostica”, “IA prescreve”, “receita automática”, “decisão médica automática”.
