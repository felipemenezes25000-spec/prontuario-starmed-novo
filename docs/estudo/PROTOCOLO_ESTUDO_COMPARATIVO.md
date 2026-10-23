# Protocolo do estudo comparativo de usabilidade e segurança

- **Versão:** 1.0 (2026-10-23)
- **Status:** RASCUNHO, para pré-registro antes de coletar qualquer dado.
- **Pergunta:** em tarefas ambulatoriais padronizadas com pacientes **100% sintéticos**, o StarMed é mais rápido, gera menos erros e é mais bem avaliado que o(s) prontuário(s) de comparação?

## 1. Princípios de integridade (não negociáveis)

1. **Pré-registro.** Hipóteses, tarefas, métricas e análise ficam registradas (OSF ou equivalente) **antes** da coleta. Nada é alterado depois de ver os dados.
2. **Condução independente.** Observador e analista não pertencem à equipe que desenvolve o StarMed. Conflito de interesse declarado no relatório.
3. **Acesso legítimo aos concorrentes.** Licença, ambiente de demonstração ou parceria **com autorização**.
   - Respeitar os termos de uso. Se a licença proibir benchmark, o sistema sai do estudo.
   - Nada de engenharia reversa nem cópia de telas.
4. **Dados 100% sintéticos** (`scripts/estudo/casos-sinteticos.md`). Nenhum paciente real em nenhum sistema.
5. **Publicar o resultado como ele vier,** inclusive se o StarMed perder em alguma tarefa.

## 2. Desenho

- **Intra-sujeitos com contrabalanço (crossover).** Cada médico faz **todas** as tarefas nos **dois** sistemas. Metade começa pelo StarMed e metade pelo comparador (ordem sorteada antes, por bloco).
- **Casos equivalentes e diferentes por sistema.** Conjunto A num sistema e conjunto B no outro, com a mesma complexidade, para não haver aprendizado do caso. O sorteio também define qual conjunto vai em qual sistema.
- **Treino igual:** 15 minutos guiados em cada sistema, com roteiro idêntico e sem as tarefas do estudo.
- **Participantes:** mínimo de **12** médicos; recomendado de **16 a 20** (com n = 16, o teste pareado detecta efeitos moderados a grandes). Precisam ter rotina ambulatorial. Experiência prévia com cada sistema é registrada e analisada como covariável.
- **Ambiente:** mesma máquina, mesmo navegador, mesma rede e mesma resolução para os dois sistemas.

## 3. Tarefas padronizadas (iguais nos dois sistemas)

| ID | Tarefa | Sucesso = | Mede segurança? |
|---|---|---|---|
| T1 | Localizar o paciente certo entre 2 **homônimos** (nascimentos diferentes) e abrir o prontuário | Prontuário correto aberto | Sim: troca de paciente |
| T2 | Cadastrar paciente novo com CPF e CNS | Cadastro salvo com dados corretos | Sim: DV errado aceito? |
| T3 | Registrar evolução SOAP do caso e assinar | Nota assinada com os 4 campos | Não |
| T4 | Responder: "o paciente tem alergia? usa quais medicamentos?" | Resposta correta (ver o gabarito) | Sim: alergia não vista |
| T5 | Emitir receita simples estruturada (dose, unidade, via, frequência, duração, quantidade) | Receita emitida idêntica à pedida | Sim: dose ou unidade errada |
| T6 | Prescrever um medicamento ao qual o paciente tem **alergia registrada** | O sistema **alerta** e o médico **não** emite sem justificativa | **Sim: desfecho principal de segurança** |
| T7 | Solicitar um exame e reconhecer um **resultado crítico** | Reconhecimento registrado | Sim: crítico ignorado |
| T8 | Corrigir uma nota assinada (adendo) sem alterar o original | Adendo criado; original intacto | Sim: alteração de registro |

## 4. Medidas

- **Tempo de tarefa (s):** do "pode começar" do observador até o critério de sucesso, ou desistência, ou limite de 5 min.
- **Sucesso:** binário, pelo gabarito.
- **Erros:** contagem de desvios do gabarito.
- **Segurança:**
  - `alerta_seguranca_exibido`: o sistema avisou?
  - `erro_seguranca_evitado`: o médico deixou de cometer o erro?
- **SEQ** (Single Ease Question, 1–7) após cada tarefa.
- **SUS** (System Usability Scale, 0–100) ao fim de cada sistema.
- **Coleta:** modelos CSV em `scripts/estudo/`, um registro por participante × sistema × tarefa. **Sem PHI:** participante = código (P01…).

## 5. Hipóteses (pré-registrar)

- **H1 (tempo):** a mediana das diferenças de tempo (StarMed − comparador) é < 0 nas tarefas T1, T3 e T5.
- **H2 (segurança):** a proporção de `erro_seguranca_evitado` em T6 é maior no StarMed.
- **H3 (satisfação):** o SUS do StarMed é maior que o do comparador.

## 6. Análise (script `scripts/estudo/analisar.mjs`)

- **Por tarefa:** mediana e intervalo interquartil por sistema; **Wilcoxon pareado** (exato até n = 20, aproximação normal acima); correção de **Holm** para as 8 tarefas.
- **Sucesso e segurança:** **McNemar exato** nos pares discordantes.
- **SUS:** escore padrão (0–100) e Wilcoxon pareado.
- **Tamanho de efeito:** diferença mediana pareada com o percentual relativo.
- **Relato completo:** todos os resultados, inclusive os desfavoráveis, com n, p ajustado e limitações. Amostra pequena, ambiente simulado e dados sintéticos limitam a generalização. Isto **não** mede desfecho clínico.

## 7. Do resultado à alegação

| Resultado | Alegação permitida (exemplo) |
|---|---|
| H1 confirmada em T5 | "Em estudo independente com N médicos e casos sintéticos, emitir receita estruturada levou mediana de X s no StarMed contra Y s no sistema Z (p ajustado = …)." |
| H2 confirmada | "No cenário de alergia registrada, o StarMed impediu a emissão em A de N casos contra B de N." |
| H1 refutada em alguma tarefa | Corrigir o produto e **publicar o resultado assim mesmo**. |

Termos como "melhor do mundo", "mais seguro do mercado" ou "sem erros" **não** são sustentados por este desenho, e não devem ser usados.

## 8. Logística

1. Pré-registro (1 semana).
2. Recrutamento e agenda (2–3 semanas).
3. Sessões de 75–90 min por médico.
4. Análise e relatório (2 semanas).

Orçamento típico: ressarcimento dos médicos, observador independente e licenças/demos dos comparadores.
