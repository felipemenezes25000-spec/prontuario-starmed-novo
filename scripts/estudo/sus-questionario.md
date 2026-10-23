# System Usability Scale (SUS) — aplicação ao fim de cada sistema

A escala SUS (Brooke, 1986) é de uso livre. Esta é uma tradução de trabalho. Se a instituição exigir instrumento com validação psicométrica em português, use uma versão validada publicada e registre qual no pré-registro.

**Instrução ao participante:** "Pensando apenas no sistema que você acabou de usar, marque de 1 (discordo totalmente) a 5 (concordo totalmente)."

| # | Afirmação | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| 1 | Eu acho que gostaria de usar este sistema com frequência. | | | | | |
| 2 | Achei o sistema desnecessariamente complexo. | | | | | |
| 3 | Achei o sistema fácil de usar. | | | | | |
| 4 | Acho que precisaria do apoio de um técnico para conseguir usar este sistema. | | | | | |
| 5 | Achei que as várias funções do sistema estão bem integradas. | | | | | |
| 6 | Achei que o sistema tem muita inconsistência. | | | | | |
| 7 | Imagino que a maioria das pessoas aprenderia a usar este sistema rapidamente. | | | | | |
| 8 | Achei o sistema muito complicado de usar. | | | | | |
| 9 | Eu me senti muito confiante usando o sistema. | | | | | |
| 10 | Precisei aprender muitas coisas antes de conseguir usar este sistema. | | | | | |

Registre as 10 respostas em `coleta-sus.csv` (colunas `q1`…`q10`). O escore 0–100 é calculado pelo `analisar.mjs`: itens ímpares valem (resposta − 1), pares valem (5 − resposta), e a soma é multiplicada por 2,5.

**SEQ (após cada tarefa):** "No geral, quão fácil ou difícil foi esta tarefa?" — 1 (muito difícil) a 7 (muito fácil). Registrar na coluna `seq_1a7`.
