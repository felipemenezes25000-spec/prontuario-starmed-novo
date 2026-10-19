# Design System RenoveJá+ — v4

Fonte única de verdade visual para os frontends: app mobile (Expo) e portal web (Vite).

```
design-system/tokens.json          ← você edita AQUI
        │
        │  npm run tokens:build
        ▼
frontend-mobile/lib/designTokens.generated.ts
frontend-web/src/styles/tokens.generated.css
```

Os dois arquivos gerados **não devem ser editados à mão**. O gerador reescreve por cima.

> **Terceiro alvo removido em 17/08/2026.** Havia um terceiro destino,
> `rh-renoveja/src/styles/tokens.generated.css`. O módulo `rh-renoveja` saiu do produto
> público no commit `152f8565` e o alvo foi retirado do gerador em 17/08/2026 — o motivo
> está comentado no fim de `scripts/design-tokens/build-tokens.mjs`: como `write()` faz
> `mkdirSync(recursive)`, cada `npm run tokens:build` recriava o diretório apagado. As
> menções a "portal RH" que sobraram abaixo são registro histórico, não estado atual.

### O que mora no JSON

| Seção | Conteúdo |
|---|---|
| `color` | as rampas primitivas (primary, teal, neutral, success, warning, error, info) |
| `semanticColor` | as cores semânticas que **não** derivam de um passo de rampa: superfícies do modo escuro, os cinzas de texto calibrados por contraste e a categórica rosa |
| `typography` `spacing` `radius` `elevation` `motion` `layout` `breakpoints` `zIndex` | escalas |

O gerador **compõe**, não inventa: os papéis derivados (`primary` = passo 600, `text` =
passo 800…) ficam no `.mjs` junto com o comentário que explica a escolha, mas todo
hexadecimal sai do JSON. Até a v4.0 havia 29 cores escritas direto no gerador — o README
prometia fonte única e entregava duas, e quem editasse só o JSON não conseguia mudar o
modo escuro.

Regra prática: **se você está prestes a digitar um `#` dentro de `build-tokens.mjs`, o
valor está no arquivo errado.**

---

## Por que a paleta é essa

A paleta não foi escolhida por gosto. Ela foi **extraída do logotipo** por amostragem de
pixels de `frontend-mobile/assets/logo.jpg`:

| Papel no logo | Hex | HSL |
|---|---|---|
| Wordmark "RenoveJá" | `#1C4068` | `hsl(212 58% 26%)` |
| Seta de renovação | `#5AACEE` | `hsl(207 81% 64%)` |
| Documento ao fundo | `#B4D8F8` | `hsl(207 81% 84%)` |

As duas cores da marca estão a **5° de matiz uma da outra**. O logotipo inteiro é uma
única rampa de azul variando luminosidade — e é por isso que dá para derivar um sistema
coerente a partir dele, em vez de inventar uma paleta ao lado da marca.

Antes da v4 havia **três marcas diferentes** no mesmo produto:

| | cor primária | confere com o logo? |
|---|---|---|
| mobile (v3) | `#1870F8` azul royal | não |
| web | `hsl(195 100% 45%)` ciano | não |
| portal RH | `#0EA5E9` sky | não |

### A cor da marca não é a cor de ação

`#5AACEE`, o azul da seta, tem **2,45:1** sobre branco. Ele reprova WCAG para texto por
uma margem grande. Isso não é defeito do logo — é a natureza de um azul claro.

A consequência de design é direta: `#5AACEE` é **cor de ilustração** (`brandAccent`).
Nunca texto, nunca botão. A cor de **ação** é o passo 600 da rampa, `#1B72C2`, com
**4,96:1**. A cor de **tinta** é o passo 800, `#1C4068`, com **10,59:1**.

---

## O que é verificado automaticamente

### Contraste — no build dos tokens

`npm run tokens:check` valida **132 pares** texto/superfície: 29 pares em cada um
dos quatro esquemas (claro, escuro, escuro-médico e alto contraste) mais 8 pares
em cada uma das duas simulações de dicromacia (`cvd-red-green` e
`cvd-blue-yellow`). Se qualquer par cair abaixo do mínimo WCAG, o comando sai com
erro e o token não é gerado.

> **Correção de 17/08/2026.** Este número estava congelado em **87** aqui, no
> `README` dos dois frontends, em `frontend-mobile/lib/designSystem.ts` e na
> declaração pública de acessibilidade da landing — enquanto o gerador validava
> 132, em quatro esquemas e não três. A divergência era a favor do produto, o que
> é exatamente por que sobreviveu meses: subdeclaração não incomoda ninguém. Em
> contratação pública, onde acessibilidade é critério de habilitação, o erro
> inverso teria a mesma chance de passar. A copy da landing agora tem teste de
> contrato contra a execução real do gerador
> (`scripts/__tests__/landing-accessibility-claims.test.mjs`); os READMEs não —
> **rode `npm run tokens:check` antes de citar o número.**

Inclui os critérios que costumam passar batido:

- **1.4.3** texto normal 4,5:1 — inclusive cor de estado sobre o *soft* correspondente
  (`error` sobre `errorSoft`, que é onde o par costuma reprovar por pouco)
- **1.4.11** contraste não-textual 3:1 para `borderInteractive` e para o anel de foco

Por isso existem dois tokens de borda diferentes:

- `border` / `borderStrong` — separador decorativo, isento de 1.4.11
- `borderInteractive` — contorno de input, checkbox, radio, switch. Quando a borda é o
  **único** indicador do limite do controle, ela precisa de 3:1.

### Valor inválido na emissão — no build dos tokens

O mesmo comando recusa gerar arquivo que contenha `NaN` ou `undefined`. Não é paranoia:
`--tracking-note: NaNem` viveu meses nos dois portais porque uma nota de documentação
estava dentro do mapa `typography.tracking` e o gerador dividia a frase por 16. CSS
inválido o navegador ignora **em silêncio** — não derruba build, não derruba teste, só sai
errado na tela. Notas ficam ao lado do mapa (`trackingNote`), nunca dentro dele, e o
gerador descarta qualquer chave não numérica de um mapa de escala.

### Separação sob daltonismo — no jest

`frontend-mobile/lib/accessibility/perceptual.ts` implementa simulação de dicromacia
(matrizes de **Machado, Oliveira & Fernandes 2009**, severidade 1.0) e **CIEDE2000**.

`perceptual.a11y.test.ts` exige:

| conjunto | limiar | por quê |
|---|---|---|
| estados entre si (`success`/`warning`/`error`/`info`) | ΔE ≥ 10 | competem pelo mesmo ponto, selo e borda. Confundir "aprovada" com "rejeitada" é erro clínico |
| estado vs `primary` | ΔE ≥ 6 | papéis diferentes (ação vs estado). Não podem ser idênticos, podem ser da mesma família |
| categorias em visão normal | ΔE ≥ 10 | receita, exame e consulta precisam ser óbvias |
| categorias sob dicromacia | ΔE ≥ 6 | sempre acompanhadas de ícone e rótulo — a cor é redundância, não o canal principal (WCAG 1.4.1) |

Esse teste **encontrou bugs reais** que estavam em produção sem ninguém saber:

- a paleta de tritanopia usava ciano para "informação" e magenta para "atenção"; sob
  tritanopia o ciano vira verde e encostava no sucesso (ΔE 5,27), e o magenta vira
  vermelho e encostava no erro (ΔE 9,09). A paleta que existia para proteger o tritanope
  era justamente a que falhava para ele.
- `statusApproved` e `success` guardavam o mesmo hexadecimal **copiado**; ao recalibrar a
  paleta, metade das cópias ficou para trás. Hoje os aliases são **derivados**, e essa
  classe de bug ficou impossível.

### Anti-padrões — no design lint

```bash
npm run design:lint            # falha se alguma contagem SUBIR
npm run design:lint -- --report          # lista tudo
npm run design:lint -- --update-baseline # REESCREVE a baseline (leia abaixo)
```

São mais de mil ocorrências herdadas registradas em `design-lint-baseline.json` (`_total`
= **1 191** em 22/08/2026, depois que o `rh-renoveja` saiu da varredura). Bloquear
todas de uma vez pararia o time e o lint seria desligado na semana seguinte. Então a regra
é: **os números só podem cair**. A dívida fica visível e sob controle.

Regras: sombra preta sem tint, cor hardcoded (hexadecimal), cor hardcoded funcional
(`hsl()`/`rgb()` literais), classe de paleta do Tailwind, fonte genérica, glassmorphism,
gradiente roxo, easing datado, `<alpha-value>` ausente no Tailwind, CTA genérico, pulse
como status.

Exceção legítima (cor de marca de terceiro, por exemplo) → comentário `design-lint-ignore`.
Linha dentro de bloco `/* … */` não conta: documentar uma cor aposentada não é usá-la.

#### A unidade de contagem é a LINHA, não a ocorrência

Uma linha com `"bg-blue-500 text-gray-700 border-red-200"` conta **1** para
`classe-de-paleta-tailwind`, não 3. Uma linha pode contar em mais de uma regra (um
`box-shadow: … rgba(0,0,0,.3)` conta em `sombra-preta-sem-tint` e em
`cor-funcional-hardcoded` — são dois defeitos diferentes na mesma linha).

Isso importa quando o número do lint é comparado com o de uma auditoria feita a `grep -o`:
os dois estão certos, medem coisas diferentes.

#### A visão do lint tem versão — e a baseline subiu porque a visão aumentou

O campo `_visao` na baseline diz o que o lint **enxergava** quando aquele número foi
gravado. Ele existe porque a baseline saltou de 733 para 2 231 em 01/08/2026 **sem uma
linha de código de produto ter piorado**:

| visão | o que via | total |
|---|---|---|
| v1 | `.ts` `.tsx` `.js` `.jsx` `.css`; só hexadecimal | **733** |
| v2 | + `.html`, + `hsl()`/`rgb()` literais, + classes de paleta do Tailwind | **2 231** |

> O primeiro `--update-baseline` da v2 gravou **2 232**, e minutos depois o lint reprovou
> apontando 7 ocorrências novas em cinco arquivos — quatro deles byte a byte idênticos ao
> commit anterior. Não era regressão: o `design-lint.mjs` foi afinado **depois** da
> gravação (`mtime` do script 17:05, o da baseline 17:03), então a régua mudou embaixo do
> número. A gravação final fecha em 2 231: `-8` de classes Tailwind que o lote 2 removeu
> de verdade, `+7` que o detector afiado passou a ver. **Sempre regrave a baseline no
> mesmo instante em que congelar a visão** — se as duas coisas se separam, o portão acusa
> regressão de código onde só houve mudança de lente, e a próxima pessoa gasta o tempo
> que este parágrafo economiza.

O que a v1 não via:

- **`.html`** — `frontend-web/index.html` e `frontend-web/public/offline.html` nunca foram
  varridos. `public/` também saiu da lista de diretórios ignorados: `offline.html` e
  `sw.js` são escritos à mão e servidos ao usuário.
- **`hsl()` e `rgb()` literais** — `rgba(255,255,255,0.22)` é tão hardcoded quanto
  `#FFFFFF38`, e o mobile está cheio deles. `hsl(var(--primary) / 0.1)` e
  `` `hsl(${h} ${s}% ${l}%)` `` continuam legítimos: o que denuncia a cor solta é o valor
  numérico logo depois do parêntese.
- **classes de paleta do Tailwind** — `bg-blue-600`, `text-emerald-500`,
  `dark:hover:bg-gray-800/40`. É cor solta com outra sintaxe.

**Famílias remapeadas não contam.** `frontend-web/tailwind.config.ts` aponta `neutral` e
`teal` para os tokens; nesses apps `bg-slate-700` **é** uso de token. O lint lê a config de
cada app e ignora as famílias que aquele app redefiniu — era por isso que o portal RH, que
chamava os neutros de `slate`, aparecia com 274 e não com os ~383 que uma contagem cega de
classes daria.

A distribuição da v2, medida em 01/08/2026, quando `rh-renoveja` ainda existia
(`APPS` em `scripts/design-lint.mjs` hoje é só `frontend-mobile` e `frontend-web`, e a
baseline não tem mais nenhuma chave `rh-renoveja::`):

| chave | contagem |
|---|---|
| `frontend-web::classe-de-paleta-tailwind` | 1 081 |
| `frontend-web::cor-hardcoded` | 394 |
| `rh-renoveja::classe-de-paleta-tailwind` | 274 |
| `frontend-mobile::cor-hardcoded` | 271 |
| `frontend-web::cor-funcional-hardcoded` | 76 |
| `frontend-mobile::cor-funcional-hardcoded` | 58 |
| `rh-renoveja::cor-hardcoded` | 56 |
| demais (sombra, fonte, CTA, pulse) | 22 |

Regra para o futuro: **ao mexer na visão, atualize `VISAO` em `scripts/design-lint.mjs`
antes de rodar `--update-baseline`.** Baseline que sobe sem dizer se foi o código ou a
lente que mudou é dívida que ninguém consegue auditar depois.

As regras têm teste: `node --test 'scripts/__tests__/*.test.mjs'`. O que está coberto é
sobretudo o **falso positivo** — um lint que marca `hsl(var(--primary))` ou `bg-slate-700`
de um app que remapeou `slate` não é rigor, é ruído, e ruído é o que faz alguém desligar
o lint.

#### Como a comparação funciona de verdade

O lint compara **chave a chave** (`app::regra`), não o total. `frontend-web::cor-hardcoded`
subir de 383 para 388 reprova mesmo que o total do repositório tenha caído — e isso é o
comportamento certo: totais escondem trocas ("piorei o web, melhorei o mobile, ficou
igual").

O `_total` gravado no JSON é **informativo**. Nada no `design-lint.mjs` o lê na
verificação.

#### `--update-baseline` reescreve tudo, inclusive as pioras

Este é o ponto que o "só pode cair" não deixa óbvio: **`--update-baseline` não valida
nada.** Ele apaga o arquivo e grava a contagem atual, chave por chave, subindo ou
descendo. É por isso que o total do repositório já subiu:

| commit | total | o que aconteceu |
|---|---|---|
| `935f7c3f` | 900 | baseline inicial da v4 |
| `235ab945` | **829** | melhoria real — `sombra-preta-sem-tint` no mobile caiu de 29 para 7 |
| `662a153b` | **848** | `--update-baseline` rodado com quatro contagens em alta: mobile `sombra-preta-sem-tint` 7→16, mobile `cor-hardcoded` 381→385, web `cor-hardcoded` 383→388, mobile `cta-generico` 0→1 |
| `140caf48` | **733** | melhoria real do lote 1 da auditoria |
| 01/08/2026 | **2 232** | **a lente mudou, não o código** — visão v1→v2 (`.html`, `hsl()`/`rgb()`, Tailwind). Ver a seção acima; `_visao` na baseline registra os dois números |

Ninguém burlou o portão. O portão fez o que devia — provavelmente reprovou —, e o comando
seguinte foi `--update-baseline`, que carimba a regressão como novo normal sem uma linha
de aviso. **"Só pode cair" é política, não é garantia do mecanismo.**

#### Quando rodar `--update-baseline`

Rode **depois de reduzir**, nunca para destravar um push:

1. Rode `npm run design:lint` e leia a saída. Ela imprime `Melhorou:` com as chaves que
   caíram e a lista de regressões com o trecho de código de cada ocorrência nova.
2. Confirme que **nenhuma** chave subiu. Se subiu, corrija — o objetivo de rodar o
   comando é travar a melhoria, não anistiar a piora.
3. Rode `npm run design:lint -- --update-baseline`.
4. **Confira o diff do JSON antes de commitar.** É o único momento em que uma piora fica
   visível: `git diff design-system/design-lint-baseline.json` mostra cada número que
   subiu.
5. Se precisar mesmo subir um número (mudança de escopo, arquivo novo importado de outro
   projeto), diga **no corpo do commit** qual chave subiu, de quanto para quanto e por
   quê. Baseline que sobe sem explicação no histórico é dívida que ninguém consegue
   auditar depois.

Nunca rode `--update-baseline` com a árvore suja de trabalho de outra pessoa: você
carimbaria a dívida dela junto com a sua.

> **Melhoria pendente do mecanismo:** fazer o `--update-baseline` recusar-se a gravar
> quando alguma chave subiu, exigindo um `--permitir-regressao` explícito. Isso moveria
> o "só pode cair" de política para garantia. Não implementado — a regra hoje depende de
> quem revisa o diff.

---

## Contrato de nomes

Alguns nomes de passo são **contrato** e estão travados no gerador:

```
typography.scale  xs=11  sm=13  md=15  lg=17  xl=20  xxl=24  display=32
spacing           xs=4   sm=8   md=16  lg=24  xl=32  xxl=48
radius            xs=6   sm=10  md=14  lg=18  xl=24  card=16  button=14  input=12  modal=20
```

Renomear `xs` de 4 para 8 mudaria espaçamento em centenas de arquivos **sem erro de
compilação e sem teste vermelho** — o pior tipo de regressão. Passos novos são bem-vindos
(`xxs`, `smd`, `xxxl`, `display2`); reciclar um nome existente derruba o build.

---

## Movimento

Curvas próprias, sem `ease-in-out` genérico e sem bounce/elastic (padrão datado).

| token | curva | uso |
|---|---|---|
| `standard` | `cubic-bezier(0.2, 0, 0, 1)` | mudança de estado, hover |
| `entrance` | `cubic-bezier(0.16, 1, 0.3, 1)` | entrada de elemento |
| `exit` | `cubic-bezier(0.4, 0, 1, 1)` | saída |
| `emphasis` | `cubic-bezier(0.34, 1.2, 0.36, 1)` | confirmação, o único com overshoot |

Durações: `fast` 140ms · `base` 220ms · `slow` 320ms · `slower` 480ms.
Entrada rápida com saída longa é o que dá sensação de resposta imediata.

`prefers-reduced-motion: reduce` zera todas as durações no CSS gerado. No mobile,
`lib/ui/motion.ts` já observa a preferência do sistema.

---

## Elevação

Sombras **tingidas com o navy da marca** (`#1C4068`), não preto puro. Sombra preta sobre
superfície azulada lê como sujeira; sombra tingida lê como profundidade.

`xs` `sm` `md` `lg` `xl` — mobile em `shadows.*`, web em `var(--elevation-*)` e
`shadow-card` / `shadow-elevated`.

---

## Como mudar um token

1. Edite `design-system/tokens.json`
2. `npm run tokens:build`
3. Se o contraste reprovar, o comando falha e diz qual par — **corrija o token, não o teste**
4. `cd frontend-mobile && npx jest lib/accessibility` para confirmar daltonismo
5. `npm run design:lint`

Se você mudar a cor primária, atualize também o espelho no CSS crítico inline de
`frontend-web/index.html` (nove variáveis, comentadas no arquivo) — ele existe para o
primeiro paint não piscar a cor errada.

### O espelho do CSS crítico é verificado

```bash
node scripts/design-mirror-lint.mjs
```

`npm run tokens:build` **não** reescreve esse espelho: ele é cópia manual. O drift check
de `scripts/verify/quality.sh` cobria só os três arquivos gerados, então o quarto lugar
onde token vira valor ficava sem rede — e divergiu: até 07/2026 a landing SSR pintava CTA
(2,61:1), badge (2,14:1), destaque do H1 (2,33:1) e link de contato (2,07:1) com o ciano
aposentado `hsl(195 100% 45%)`, todos reprovando WCAG AA. Como o React só troca esse
conteúdo depois de montar, o primeiro paint — o único que crawler e conexão lenta enxergam
— era a versão inacessível.

O script compara variável a variável o `:root` do `<style>` inline com o `:root` de
`frontend-web/src/styles/tokens.generated.css`. O espelho pode ser **parcial** (nove de
~200 variáveis), mas cada variável que ele declara precisa bater exatamente, e não pode
declarar variável que não existe no gerado. Roda no portão junto com os outros passos de
design.

Fora da cobertura, de propósito: as metatags `theme-color` e `msapplication-TileColor`
(hexadecimal — comparar exigiria converter HSL→hex com tolerância de arredondamento) e o
`--gradient-hero` duplicado entre `index.html` e `src/index.css` (dois arquivos escritos à
mão, nenhum deles gerado).

---

## Referências de método

As decisões de processo aqui seguem princípios de referências públicas de qualidade de
frontend, adaptados a um produto de saúde regulado:

- **Impeccable** (`impeccable.style`) — herdar tokens e convenções existentes em vez de
  sobrescrevê-los; detecção determinística de anti-padrões antes de irem para produção
- **high-end-visual-design** — evitar famílias tipográficas genéricas, sombras pretas
  duras, bordas cinza genéricas e transições lineares; curvas de movimento próprias
- **design-taste-frontend** — ler o briefing antes de codar; reconhecer as "restrições
  silenciosas" (acessibilidade, setor regulado, compra pública) como parte do briefing
- **extract-design-system** — tokens normalizados em JSON como fonte, arquivos de token
  gerados como saída

O que **não** foi adotado: a orientação dessas referências de escolher uma direção
estética extrema. RenoveJá+ é usado por pacientes idosos, pessoas de baixa escolaridade e
pessoas surdas, e é vendido para rede pública. Aqui clareza e conformidade vencem ousadia
visual — a identidade evolui, não se reinventa.
