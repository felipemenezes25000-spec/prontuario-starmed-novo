# Auditoria WCAG 2.2 AA + estados de interface + métricas (ST-P1-012)

**Data:** 21/10/2026 · **Método:** `axe-core` via Playwright
(`@axe-core/playwright`, tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`),
**impactos `serious`/`critical` bloqueiam**; moderate/minor são registrados como
não bloqueantes. Execução: `tests/e2e/a11y.spec.ts` (**jornada9**) — roda local e
no CI (job `E2E — Playwright`) a cada push.

## 1. Escopo escaneado (jornadas críticas)

| Contexto | O que foi escaneado |
|---|---|
| Login (equipe) | tela pública inicial (credenciais, SSO, nota de segurança) |
| Login (portal) | tela pública "Área do paciente" |
| Autenticado | dashboard → pacientes (lista/busca) → **prontuário** (evolução+alergias) → **Prontuário 360°** (timeline + aba Alto risco) → **prescrições** → **resultados** → **teleconsulta** |
| Portal | home com documentos, notificações (opt-out) e perfil |

## 2. Resultado

**PRÉ-correção:** 63+ nós `color-contrast` (serious) + 2 `target-size` (serious) —
**PÓS-correção: 0 serious/critical em todos os contextos** (3/3 da jornada9).

Principais achados e correções (todas em `apps/web/src/styles.css`, bloco
"**Fase 7 — WCAG 2.2 AA**" no fim do arquivo; ratios conferidos pelo próprio axe):

| Achado | Antes | Depois | Ratio (em #fff / #f5f8fa) |
|---|---|---|---|
| Texto secundário (`.muted`, `small`, `.breadcrumb`, `.topbar-right`, `.security-note`, `.sso-divider`, `.page-heading p`, `.patient-header p`, `.empty-state p`, `.flow-line p`, `.footer`, `.footnote`, `.mode-button`, `.stat-card span/small`, `.list-line small`) | #859aa4…#a3b5bd (2.1–3.9) | **#5b6b75** | ≈5.5 / 5.2 |
| Botão primário (texto branco) | fundo #13ad97 (2.81) | **#0b7a68** | 5.3 |
| `.text-button` (ações teal) | #159c8e (3.39) | **#0e7d70** | 5.0 |
| `.eyebrow` (títulos de seção) | #11a991 (2.77–2.95) | **#0b6e63** (`.hero` escuro mantém #11a991 — já passava) | 5.7 |
| Botão de busca / `details summary` | #208579/#159d8b (3.4–3.9) | **#17695f** | 5.6+ |
| `.small-pill` | #448980 (3.7) | **#2e6b64** | 5.9 |
| `.search-field` (selects herdavam a cor do container) | #95aab4 (2.3) | **#5b6b75** | 5.2 |
| `.r360-tab` inativa | #6b8692 (3.85) | **#5b6b75** | 5.2 |
| `.mode-button.active` | #0f8f7d (3.64) | **#0b6e63** | 5.6 |
| `.notice.info` | #317b9d (4.26) | **#275f7a** | 6.3 |
| **`target-size` (2.5.8)**: text-buttons do prontuário <24px | altura de glifo | **`.text-button{min-height:24px}`** | ≥24px ✓ |
| **Bug de LAYOUT real**: `.sidebar{height:100vh}` **sem overflow** → com14 itens + nota de ambiente, os últimos elementos (LGPD, Segurança, nota, Sair) **transbordavam a caixa pintada** e ficavam sobre o fundo CLARO da página (axe media bg=#f5f8fa, ratio1.5–2.08) | — | `@media(min-width:721px){.sidebar{height:100vh;overflow-y:auto}}` (mobile mantém a media query original `height:auto`) | medida DOM em jornada9 |

Inalterado de propósito: navegação lateral sobre fundo **escuro** `#102b3e`
(`.nav-item` original #a8c1ce = **7.6:1** ✓; medido no DOM — cor clara só é
necessária dentro da caixa pintada escura, daí a correção ser de LAYOUT e não de cor).

## 3. Estados de interface (inventory por classe de estado)

| Estado | Onde vive (evidência) |
|---|---|
| **loading** | "Carregando…" com `role="status"` (Prontuário 360, portal, notificações), "Salvando…/Assinando…/Baixando…" (prescrições), "Abrindo…" (documentos do portal), skeleton/disabled em botões |
| **empty** | `.empty-state` em todas as áreas: "Selecione um paciente", "Nenhum paciente encontrado", "Nenhum evento registrado para este paciente.", "Nenhum documento disponível por enquanto.", "Nenhuma mensagem foi gerada…", "Sala encerrada…", "Nenhum pedido diagnóstico." |
| **error** | `InlineError` + banners `.notice.error` com mensagem **não-técnica**; erros de domínio (409 de revisão, conflito de agenda, opt-out) traduzidos na UI |
| **denied** | Painel de **break-glass** (403 → justificativa auditada); recusas por papel ("Área da equipe assistencial", "Apenas médicos ativos…"); portal segregado (sessão própria) |
| **offline** | Portal: `OFFLINE` + fila de rascunhos (Dexie) + botão sincronizar; teleconsulta: "Reconectando…" no canal de sinais |
| **conflict** | 409s exibidos como estado recuperável: revisão obrigatória antes de assinar, merge de MPI já envolvido, sala já aberta, chave de idempotência |

Gaps pendentes (NOMEADOS, não mascarados): varredura de todos os estados em
TODAS as telas não cobertas pela jornada9; revisão com leitor de tela real
(NVDA/VoiceOver) = humana — **quem executa: engenharia + revisão humana**.

## 4. Métricas instrumentadas (sem PHI)

**Servidor** (`apps/api/src/perf-metrics.ts`, middleware + `main.ts`):
- Agrupa TODAS as requisições por **rota normalizada** (UUID/numéricos/códigos → `:id`,
  query descartada — **nunca paciente/usuário nos dados**), amostra limitada
  (2.000 durações/chave, memória);
- `GET /metrics/perf` (admin, auditado): por chave `{count, errorRate, p50, p95, since}`;
- **Honestidade:** janela em MEMÓRIA desde o boot (reinicia zerando); nada persistido.

**UI** (`pages/perf-metrics.ts` → `POST /metrics/ui`, sessão staff, enum FECHADO
rígido no servidor, durationMs ≤120s, fire-and-forget com timeout3s):

| Indicador do ST-P1-012 | Evento | Instrumentado em |
|---|---|---|
| abrir prontuário | `open_record` | `App.tsx` → `openPatient` (carga encounters+alergias+problemas) |
| concluir evolução | `sign_note` | `App.tsx` → `signNote` (POST /notes/sign) |
| emitir prescrição | `create_prescription` | `Prescriptions.tsx` → `sign` (POST /prescriptions/:id/sign) |
| recuperar histórico | `load_history` | `Record360.tsx` → `loadTimeline` |
| identificar alergia | `check_allergy` | `App.tsx` → `createAllergy` (POST alergia) |

- **p50/p95** por evento/rota via `GET /metrics/perf`; **taxa de erro** =
  `errorRate` (server) e `ok=false` (UI) — a taxa de **abandono** é o
  equivalente a `ok=false` (o usuário não concluiu: falha ou cancelamento);
  duração alta + falha = fluxo abandonado. Limitação honesta: sem sessão de
  usuário cruzada, não há métrica de "começou e desistiu antes de qualquer
  tentativa" — isso exigiria telemetria de sessão (pendência: DPO + produto).
- **PHI:** nenhum id, texto ou rota com id entra na métrica (enum fechado +
  normalização); testes puros em `perf-metrics.test.ts` cobrem a normalização
  (inclusive descarte de `?q=termo` de busca).
