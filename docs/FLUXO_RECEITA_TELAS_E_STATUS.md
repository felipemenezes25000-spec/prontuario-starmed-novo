# Fluxo de receita: telas e atualização de status

Este documento descreve o fluxo de telas no app durante o processo de renovação de receita e em que momento cada status é atualizado no backend.

O atendimento é da rede pública e **gratuito para o paciente**: assim que o médico aprova, o pedido segue direto para a assinatura digital.

---

## Visão geral do fluxo

```
Paciente: Home → Nova Receita → [envia] → volta ao Home
                → Meus Pedidos → Detalhe do pedido (status: Enviado)
                                    ↓
Médico:  Dashboard → Fila → Detalhe (receita) → Aprovar ou Rejeitar
                                    ↓
Backend:  ApproveAsync → status vira Approved
                                    ↓
Paciente: Detalhe (status: Aprovado) — aguarda o médico preparar e assinar
Médico:   Fila/Detalhe → Assinar digitalmente
                                    ↓
Backend:  SignAsync → status vira Signed
                                    ↓
Paciente: Detalhe → Baixar receita / Visualizar → mark-delivered → status vira Delivered
```

Fluxo canônico de receita/exame: `submitted → in_review → approved → signed → delivered`.

---

## 1. Telas por ator

### Paciente

| Tela | Rota | Quando aparece |
|------|------|----------------|
| Home | `/(patient)/home` | Após login; mostra atalhos (Nova Receita, Meus Pedidos, etc.). |
| Nova Receita | `/new-request/prescription` | Ao tocar em "Renovar Receita". |
| Meus Pedidos | `/(patient)/requests` | Lista de todos os pedidos (filtros: Todos, Receitas, Exames, Consultas). |
| Detalhe do pedido | `/request-detail/[id]` | Ao tocar em um pedido na lista. Mostra status, detalhes, e botões conforme o status. |

### Médico

| Tela | Rota | Quando aparece |
|------|------|----------------|
| Dashboard | `/(doctor)/dashboard` | Após login; contadores (Fila, Em análise, Assinados, Consultas) e preview da fila. |
| Fila de Atendimento | `/(doctor)/requests` | Lista de pedidos (fila + atribuídos ao médico). |
| Detalhe do pedido (médico) | `/doctor-request/[id]` | Ao tocar em um pedido na fila. Mostra dados do paciente, análise IA, imagens, e ações (Aprovar, Rejeitar, Assinar). |

---

## 2. Momento em que cada status é atualizado

| Status | Quando é setado | Onde no backend | Tela/ação do usuário |
|--------|-----------------|-----------------|----------------------|
| **Submitted** | Paciente envia a receita | `CreatePrescriptionAsync` → `MedicalRequest.CreatePrescription(...)` com `RequestStatus.Submitted` | Tela "Nova Receita" → preenche tipo, foto, medicamentos → Enviar. Após sucesso, volta ao Home (pode ir em Meus Pedidos para ver o pedido). |
| **InReview** | Médico é atribuído ao pedido | `AssignDoctor()` (em `AssignToQueueAsync` ou no primeiro `ApproveAsync` quando `DoctorId == null`) | Médico abre o pedido na Fila e clica em **Aprovar** (ou o sistema atribui via assign-queue). O status passa a "Em análise" para o paciente. |
| **Rejected** | Médico rejeita | `RejectAsync` → `request.Reject(motivo)` | Na tela do médico, botão **Rejeitar** + motivo. Paciente vê o motivo no detalhe. |
| **Approved** | Médico aprova | `RequestApprovalService.ApproveAsync` → `request.Approve(...)` → `Status = RequestStatus.Approved` | Na tela do médico, botão **Aprovar**. Paciente vê "Aguardando médico preparar e assinar" no detalhe; o pedido fica **Pronto para assinar** para o médico. |
| **Signed** | Médico assina o documento | `SignAsync` → geração do PDF, assinatura digital, `request.Sign(url, signatureId)` | Na tela do médico, pedido com status "Aprovado" → **Assinar Digitalmente** (senha do certificado). Paciente passa a ver **Baixar Receita** / **Visualizar** no detalhe. |
| **Delivered** | Paciente baixa/abre o PDF | `MarkDeliveredAsync` → `request.Deliver()` | Na tela de detalhe do paciente, ao tocar em **Baixar Receita** ou **Visualizar**, o app chama `POST /api/requests/{id}/mark-delivered` e depois abre o documento. |
| **Cancelled** | Paciente cancela | `CancelAsync` → `request.Cancel()` | Na tela de detalhe do paciente, botão **Cancelar pedido** (visível enquanto o pedido ainda não foi aprovado: submitted, in_review, searching_doctor). |

---

## 3. Botões e regras por tela

### Detalhe do pedido (paciente) – `request-detail/[id].tsx`

> ⚠️ **Corrigido em 01/08/2026 — a tela não segue o que este parágrafo dizia.**
> O texto anterior afirmava que "os botões vêm de `lib/domain/requestUiModel.ts`
> (`actions`), nunca de checagem de status espalhada na tela". A tela **faz a
> checagem local**: `canDownload` e `canCancel` são calculados em
> `request-detail/[id].tsx` (linhas ~503-504) e não vêm do `requestUiModel`.
>
> O modelo de domínio continua existindo, é testado e é a intenção de desenho —
> mas descrever a intenção no presente do indicativo fez este documento mentir
> sobre o código. Unificar é dívida legítima; enquanto não for feito, o que vale
> é o que está abaixo.

- **Baixar Receita** / **Visualizar**: aparece quando o pedido tem
  `signedDocumentUrl`. Ao usar, chama `mark-delivered` se o status ainda for
  `signed`.
- **Cancelar pedido**: status `submitted`, `in_review` **ou `approved`**.
- **Entrar na Consulta**: existe no app mobile de novo desde 17/08/2026. O botão
  vive em `app/request-detail/[id].tsx` e leva a `app/video/[requestId].tsx`; o
  `GlobalRequestUpdatedToast` também navega para lá sozinho quando o médico
  inicia o atendimento. A videochamada tinha sido removida do binário em
  `44bd3e8f` e o `canJoinCall` ficou dezenove dias calculado e testado sem que
  nenhuma tela o consumisse — hoje volta a ter consumidor.

> **A divergência do `approved` é intencional e vale explicar.** Este documento
> dizia que, depois de aprovado, "o pedido já está em preparo pelo médico e não é
> mais cancelável pelo paciente". A tela permite cancelar em `approved`. Entre
> aprovar e assinar pode passar tempo, e travar o cancelamento nessa janela
> prenderia o paciente num pedido que ele não quer mais — o que, num serviço de
> saúde pública, é pior do que o médico perder o trabalho de preparo. Se a regra
> correta for a do documento, o lugar de mudar é o código.

### Detalhe do pedido (médico) – `doctor-request/[id].tsx`

- **Aprovar** (`canApprove`): status `submitted` ou `in_review` e tipo não é consulta.
- **Rejeitar** (`canReject`): status `submitted` ou `in_review`.
- **Assinar Digitalmente** (`canSign`): status `approved` e tipo não é consulta.
- **Aceitar Atendimento** / **Entrar na Sala de Vídeo**: voltaram ao app do
  médico em 17/08/2026, em `components/doctor-request/DoctorActionButtons.tsx`,
  governadas por `canAccept` e `canVideo` do `useDoctorRequest`. A aba
  "Consultas" (`app/(doctor)/(tabs)/consultations.tsx`) e o card de Teleconsulta
  do painel também voltaram. O portal web (`DoctorVideoCall`) continua sendo o
  canal mais completo — só ele tem o painel de IA em tempo real ao lado do vídeo.

---

## 4. Status Tracker (receita)

O componente `StatusTracker` (`PRESCRIPTION_STEPS`) para receita/exame usa os passos:

1. Enviado (`submitted`)
2. Em análise (`analyzing` – opcional, se a IA rodar em etapa separada – e `in_review`)
3. Aguardando assinatura (`approved`)
4. Assinado (`signed`)
5. Entregue (`delivered`)

Cada transição de status acima é refletida no tracker conforme o backend atualiza o pedido.

---

## 5. Ajuste realizado

- Foi adicionado o botão **Cancelar pedido** na tela de detalhe do pedido (paciente) quando o status é cancelável, chamando `POST /api/requests/{id}/cancel` e atualizando o estado local para exibir o pedido como cancelado.

Com isso, o fluxo de telas e a atualização de status da receita estão alinhados com a documentação e com o backend.
