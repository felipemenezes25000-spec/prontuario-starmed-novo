# Kit do estudo comparativo

Protocolo: [docs/estudo/PROTOCOLO_ESTUDO_COMPARATIVO.md](../../docs/estudo/PROTOCOLO_ESTUDO_COMPARATIVO.md).

| Arquivo | Uso |
|---|---|
| `sortear.mjs` | Ordem dos sistemas e conjunto de casos por participante. Reprodutível pela semente registrada no pré-registro. |
| `casos-sinteticos.md` | Conjuntos A e B (100% fictícios) com gabarito por tarefa. Requer revisão do médico responsável. |
| `coleta-tarefas.csv` | Uma linha por participante × sistema × tarefa (sem PHI). |
| `coleta-sus.csv` | Uma linha por participante × sistema (q1…q10). |
| `sus-questionario.md` | SUS + SEQ para aplicar. |
| `analisar.mjs` | Relatório: mediana/IQR, Wilcoxon pareado + Holm, McNemar exato, SUS. |

## Roteiro do observador (por sessão)

1. Confirme o sorteio do participante (`sortear.mjs`) e que os dois sistemas estão com o conjunto certo carregado.
2. Leia o termo de participação (dados sintéticos; nenhuma avaliação pessoal do médico; pode parar a qualquer momento).
3. Faça o treino de **15 min** no 1º sistema, com o roteiro idêntico para os dois sistemas e sem as tarefas do estudo.
4. Conduza T1→T8 no 1º sistema:
   - leia **só** a instrução do caso;
   - cronometre do "pode começar" até o critério de sucesso, a desistência ou 5 min;
   - **não ajude.** Se o participante perguntar, responda "faça como faria no seu dia a dia".
5. Aplique o SEQ após cada tarefa e o SUS ao fim do sistema.
6. Faça o intervalo de 5 min e repita os passos 3–5 no 2º sistema.
7. Registre tudo nos CSVs ao fim da sessão. Nunca use nome do participante, só o código (P01…).

## Gerar o relatório

```bash
node scripts/estudo/analisar.mjs --tarefas scripts/estudo/coleta-tarefas.csv --sus scripts/estudo/coleta-sus.csv --referencia StarMed --saida docs/estudo/evidencias/relatorio.md
```

## Testes do kit

```bash
node --test scripts/estudo/analisar.test.mjs
```

Os testes conferem os valores de referência do Wilcoxon exato, do McNemar, do Holm, do SUS e do sorteio. Rodam no CI.
