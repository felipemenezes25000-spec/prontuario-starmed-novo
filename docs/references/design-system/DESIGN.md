# DESIGN.md — como construir uma tela

Guia prático. Para o *porquê* das cores e a verificação automática, veja
[README.md](README.md). Para *quem usa*, veja [PRODUCT.md](PRODUCT.md).

---

## Modo da tela

Antes de posicionar qualquer coisa, decida em qual dos quatro modos a tela está. Isso
determina densidade, movimento e quanto espaço em branco é apropriado.

| modo | onde | prioridade |
|---|---|---|
| **Persuadir** | landing, `/lista-vip` | ganhar atenção e confiança; composição pode variar |
| **Operar** | fila do médico, admin, RH, home do paciente | concluir a tarefa; densidade útil, zero decoração |
| **Ler** | termos, privacidade, prontuário, resumo de consulta | legibilidade; medida de linha curta, hierarquia clara |
| **Experienciar** | onboarding, vídeo, sucesso de assinatura | momento único; aqui movimento se justifica |

O erro mais comum é aplicar estética de "Persuadir" numa tela de "Operar".

---

## Mobile

```tsx
import { useAppTheme } from '../../lib/ui/useAppTheme';

export function MinhaTela() {
  const { colors, spacing, radius, shadows, typography, layout, motion } = useAppTheme();
  const styles = useMemo(() => makeStyles(colors, typography), [colors, typography]);
  // typography NAS DEPENDÊNCIAS: sem isso, "Letras Grandes" não se aplica.
  ...
}
```

`useAppTheme()` é o único caminho correto. Ele resolve, de uma vez:

- papel do usuário (paciente / médico)
- claro / escuro
- escala de fonte (1.0 / 1.3 / 1.6)
- alto contraste
- paleta de daltonismo

`createTokens()` direto **pula acessibilidade**. Só use fora de componente React.

### Regras rápidas

| faça | não faça |
|---|---|
| `colors.primary` | `'#1B72C2'` |
| `shadows.md` | `shadowColor: '#000'` |
| `spacing.md` | `marginTop: 16` |
| `colors.headerOverlayTextMuted` (0.78) | `rgba(255,255,255,0.6)` sobre gradiente |
| `layout.minTouchTarget` (44) ou `hitSlop` | botão de 32px |
| `colors.brandAccent` em ilustração | `colors.brandAccent` em texto — **2,45:1** |

---

## Web e RH

```tsx
<button className="bg-primary text-primary-foreground shadow-card
                   transition-colors duration-fast ease-standard
                   hover:bg-primary-hover">
  Enviar pedido ao médico
</button>
```

| faça | não faça |
|---|---|
| `bg-primary` `text-content-muted` | `bg-[#1B72C2]` `text-gray-500` |
| `shadow-card` `shadow-elevated` | `shadow-md` do Tailwind puro |
| `ease-standard` `duration-base` | `ease-in-out` `duration-300` |
| `border-border-interactive` em input | `border-gray-200` em input |
| `bg-warning-soft` + `text-warning` | `bg-warning/15` + `text-warning-foreground` |

Aquela última linha é o erro que deixava texto **branco sobre fundo quase branco**:
`*-foreground` só existe para fundo **sólido** da cor cheia. Fundo suave pede texto forte.

---

## Cor por papel

```
AÇÃO        primary            #1B72C2   4,96:1   botão, link, foco
TINTA       text / brandInk    #16304F   12,7:1   título, corpo
MARCA       brandAccent        #5AACEE   2,45:1   ILUSTRAÇÃO APENAS
ESTADO      success warning error info    selo, ponto, borda de card
CATEGORIA   categoryPrescription / Exam / Consultation
```

**Estado** e **categoria** são eixos diferentes e não devem se misturar. Estado é o que
aconteceu com o pedido; categoria é que tipo de coisa ele é. Antes da v4, receita e exame
dividiam a mesma cor, o que anulava a distinção.

Categoria **nunca vai sozinha**: sempre com ícone e rótulo. É o que permite um limiar
perceptual mais baixo sob daltonismo sem perder informação (WCAG 1.4.1).

---

## Hierarquia

Uma tela tem **um** CTA primário. Se parecem existir dois, um deles é secundário e ainda
não foi rebaixado.

```
displayLg  40   herói
display    32   título de tela
h1         28
h2         24   seção
h3         18   card
body       15   corpo
bodySm     13   apoio
overline   11   rótulo em caixa alta, tracking +1
```

O tracking já vem no token e **escala junto com a fonte** — se o corpo cresce e o
espaçamento não, o texto grande fica com as letras coladas.

---

## Espaço

```
xxs 2 · xs 4 · sm 8 · smd 12 · md 16 · lg 24 · xl 32 · xxl 48 · xxxl 64
```

Agrupamento se comunica por espaço, não por borda. Se você precisou de uma borda para
separar dois blocos, provavelmente falta espaço entre eles.

**Nunca aninhe cards.** Card dentro de card com sombra e raio nos dois é ruído: some com o
container externo ou troque o interno por uma superfície plana (`surfaceSecondary`).

---

## Movimento

Movimento tem que **explicar alguma coisa**: de onde o elemento veio, o que mudou, que a
ação foi registrada. Movimento decorativo custa bateria e quadro em aparelho fraco.

| situação | duração | curva |
|---|---|---|
| hover, mudança de cor | `fast` 140ms | `standard` |
| entrada de card, expandir | `base` 220ms | `entrance` |
| saída, fechar | `fast` 140ms | `exit` |
| confirmação de sucesso | `slow` 320ms | `emphasis` |
| lista escalonada | `stagger.base` 48ms entre itens | `entrance` |

Só anime `transform` e `opacity` — o resto força layout.

Nunca: bounce, elastic, `ease-in-out` genérico, loop infinito como indicador de status.

---

## Estados obrigatórios

Toda tela que busca dados precisa dos **quatro**:

1. **carregando** — skeleton com a forma do conteúdo real, não spinner centralizado
2. **vazio** — diz o que é, por que está vazio e qual a próxima ação
3. **erro** — diz o que fazer, oferece tentar de novo. **Nunca** mostre estado vazio
   quando a chamada falhou: isso informa o contrário do que aconteceu
4. **conteúdo**

Todo controle interativo precisa de: repouso, hover (web), foco visível, pressionado,
desabilitado, carregando.

---

## Web — sistema de interface (portais autenticados)

### Camadas (`z-*`)

Nada de `z-50`, `z-[100]` ou `z-[999]`. Use o nome da camada (tokens.json → `layer`):

```
z-sticky 20 · z-nav 30 · z-floating 40 · z-overlay 50 · z-alert 55 · z-popover 60
z-toast 70 · z-command 80 · z-critical 90
```

- **popover acima de overlay**: select, menu e dica abrem de dentro de diálogo e gaveta;
- **command acima de toast**: a busca rápida é modal e foi aberta de propósito;
- `critical` é para o que precisa ficar por cima de tudo (sem conexão, sessão);
- empilhamento local dentro de um componente (`relative` + `z-10`) é livre — o que não pode
  é elemento `fixed`/`sticky`/portal com número solto.

A ordem é contrato: `src/components/ui/__tests__/layers.test.ts` reprova se alguém a inverter.

### Página

```tsx
<PageContainer>                 {/* largura e respiro: page 1600 · content 1280 · form 768 · reading 680 */}
  <PageHeader icon={…} eyebrow="Módulo" title="Título" description="Uma ou duas frases." actions={…} />
  {/* filtros / avisos (InlineAlert) */}
  {/* conteúdo, com SectionHeader por seção */}
</PageContainer>
```

- um `h1` por tela, no `PageHeader` (ele já recebe o foco depois da navegação);
- a tela **não** declara `<main>`: o casco já tem o único `<main id="main-content">`;
- elemento `sticky` usa `top-shell` (não passa por baixo da barra fixa do celular).

### Casco (AppShell)

`src/shared/shell/AppShell.tsx` é o casco dos portais: barra lateral (≥ 768 px, trilho de
ícones recolhível — padrão recolhido até 1279 px), barra + gaveta modal no celular, grupos de
menu que abrem e fecham (a escolha fica guardada), cartão "onde/quem" com o vínculo num painel,
rolagem ao topo e foco no título a cada troca de tela, e um limite de erro por tela — falha de
uma tela não derruba o portal. Menu novo entra em `lib/ubs-navigation.ts` ou
`lib/manager-navigation.ts`; nenhum grupo passa de nove itens.

### Overlays

| precisa | use |
|---|---|
| concluir ou cancelar uma tarefa focal | `Dialog` (`size`: sm · md · lg · xl · 2xl) |
| confirmar ação destrutiva, irreversível ou clínica | `ConfirmDialog` / `useConfirm` — nunca `window.confirm` |
| detalhe, filtro, contexto secundário | `Sheet` |
| contexto curto ancorado | `Popover` |
| explicar um controle (nunca o único caminho) | `Tooltip` |
| ações de uma linha | `DropdownMenu` |

Todos abrem em portal, respeitam a tela (altura em `dvh`, rolagem interna, colisão com a
borda), fecham com Esc e devolvem o foco. Confirmação destrutiva começa com o foco em
"Cancelar", não fecha por clique fora e trava os botões enquanto a ação roda.

### Estados

- carregando: esqueleto com a forma da tela (nunca a tela inteira trocada por spinner);
- vazio: `EmptyState` com o motivo — `no-data`, `filtered`, `search`, `permission`,
  `not-selected`; lista vazia não pede para "selecionar" o que não existe (mestre/detalhe
  vazio vira um estado vazio só);
- seletor sem opção diz por quê ("Nenhum contrato ativo") e fica desabilitado — `<select>`
  em branco é estado mudo;
- erro de carga: `StarMedLoadError` (acesso negado não oferece "tentar de novo"); mensagem
  de erro passa por `sanitizeUserFacingError` — "Cannot read properties of undefined" nunca
  chega à tela;
- aviso que precisa ficar: `InlineAlert` (o toast some — `AppToaster`, no máximo três).

### Formulário e tabela

- `FormField`: rótulo sempre visível, orientação e erro ligados ao controle por
  `aria-describedby`, erro em texto (não só cor), asterisco de obrigatório só visual. Para
  controle composto (select nativo, Radix), passe uma função `(control) => …`. Placeholder
  não é rótulo;
- `Table`: `density` (`comfortable` padrão, `compact`, `dense` para fila, log, estoque),
  `stickyHeader` (com altura máxima no contêiner) e `scrollLabel` (região nomeada e focável
  para rolar pelo teclado). Cabeçalho fixo dentro de tabela que rola não usa `top-shell` — o
  deslocamento do casco empurra o cabeçalho para cima das linhas;
- painéis lado a lado com conteúdo independente usam `items-start`: estado vazio curto não
  estica até a altura do vizinho.

### CSS global

- toda regra global mora numa camada. O CSS crítico inline do `index.html` fica em
  `@layer critical`, a de menor prioridade; regra sem camada vence qualquer utilidade (foi
  assim que `mt-*`, `font-black` e `tracking-*` em título ficaram sem efeito no app inteiro);
- título (`h1`–`h6`) herda a cor do contêiner — em faixa azul ou escura ele acompanha o
  `text-primary-foreground`/`text-white` do pai;
- texto sobre fundo tingido (`bg-primary/10`, `bg-warning/10`) usa o tom forte
  (`text-primary-active`) ou o fundo `-soft` do token: o tom base sobre o próprio tingido dá
  4,2:1 e reprova em texto pequeno.

### Responsividade e controles

- botão tem altura **mínima** e quebra linha — rótulo longo cresce para baixo, não vaza;
- `input`, `select` e `textarea` nunca passam da largura do contêiner (regra base);
- tabela larga rola dentro do próprio contêiner (`TableRegion`), nunca a página;
- microtexto (7–12 px arbitrários) é proibido: o menor texto é `text-xs`.

### QA tela a tela

```bash
QA_SAIDA=<pasta> QA_PORTAIS=ubs,gestor QA_TAMANHOS=320x568,390x844,768x1024,1440x900,2560x1440 E2E_PORT=5183 npx playwright test e2e/starmed-qa-visual.spec.ts --project=chromium
```

Percorre as rotas de cada portal com a sessão simulada, salva captura e um JSON por tela
(rolagem horizontal, elemento largo demais, erro de console, casca de erro, tela sem `h1`,
tela quase muda, texto sobre ícone ou sobre texto, vão acima de 40 px entre blocos, caixa
com faixa vazia de 120 px ou mais). Portais: `ubs`, `gestor`, `cidadao`, `medico`, `admin`,
`site`. Opções: `QA_AXE=1` (contraste), `QA_TEXTO=espacado` (WCAG 1.4.12),
`QA_TITULOS=1`, `QA_TEMA=escuro`; zoom de 200% é `QA_TAMANHOS=640x450`.
No Git Bash, passe rotas sem a barra inicial (`QA_ROTAS=ubs/fila`).

---

## Antes de dar a tela por pronta

- [ ] `npm run design:lint` não subiu nenhuma contagem
- [ ] Nenhum hexadecimal literal novo
- [ ] Alvos de toque ≥ 44×44
- [ ] Foco visível em tudo que é operável, e operável por teclado (web)
- [ ] Os quatro estados existem
- [ ] Um CTA primário só
- [ ] Rótulo diz o que a ação faz
- [ ] Escala de fonte 1.6 não quebra o layout
- [ ] Alto contraste continua legível
- [ ] Nenhuma informação depende só de cor
- [ ] Sem card aninhado
- [ ] Movimento se justifica e respeita `prefers-reduced-motion`
- [ ] (web) `PageHeader` com um `h1`; nenhum `<main>` na tela; camadas por nome
- [ ] (web) varredura `starmed-qa-visual` em 320 px e 1440 px sem rolagem lateral nem console de erro
