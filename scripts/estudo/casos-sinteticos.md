# Casos sintéticos padronizados (conjuntos A e B)

> **100% FICTÍCIOS.** Nomes, documentos e histórias inventados. CPF e CNS com dígito verificador válido, mas gerados para teste.
>
> **Revisão obrigatória:** o médico responsável valida o conteúdo clínico (plausibilidade e equivalência de complexidade entre A e B) **antes** do pré-registro.
>
> **Medicamentos:** usados só como objetos de tarefa, não como recomendação terapêutica.

Os dois conjuntos têm a **mesma estrutura e a mesma dificuldade**. Muda apenas o conteúdo, para evitar efeito de aprendizado entre sistemas. Carregue cada conjunto no sistema sorteado antes da sessão.

## Preparação (fazer em CADA sistema, antes do participante chegar)

| Item | Conjunto A | Conjunto B |
|---|---|---|
| Paciente-alvo (T1, T3–T8) | **Helena Martins Rocha**, F, nasc. 14/03/1968 | **Rogério Alves Pinto**, M, nasc. 22/09/1971 |
| Homônimo distrator (T1) | Helena Martins Rocha, F, nasc. 14/03/1986 | Rogério Alves Pinto, M, nasc. 22/09/1917 |
| Alergia registrada (T4, T6) | Dipirona — reação: urticária — criticidade **alta** — confirmada | Amoxicilina — reação: angioedema — criticidade **alta** — confirmada |
| Medicamentos em uso (T4) | Losartana 50 mg 1×/dia; Metformina 850 mg 2×/dia | Enalapril 10 mg 2×/dia; Sinvastatina 20 mg à noite |
| Problemas (T4) | I10 Hipertensão essencial; E11.9 Diabetes tipo 2 | I10 Hipertensão essencial; E78.0 Hipercolesterolemia pura |
| Nota assinada pré-existente (T8) | Evolução de 3 dias atrás com o peso escrito errado: "82 kg" (correto: 72 kg) | Evolução de 3 dias atrás com a PA escrita errada: "160/100" (correto: 140/90) |
| Resultado crítico pendente (T7) | Potássio 6,4 mEq/L (crítico) | Glicemia 38 mg/dL (crítico) |

## Tarefas e gabarito

**T1 — Abrir o prontuário certo.**
- Instrução: "Abra o prontuário de [nome], nascida/nascido em [data]."
- Gabarito: abre o paciente-alvo. Abrir o homônimo conta como **erro de segurança**, mesmo se corrigido depois. Registre `erro_seguranca_evitado = nao` nesse caso.

**T2 — Cadastrar paciente novo.**

| Campo | Conjunto A | Conjunto B |
|---|---|---|
| Nome | Bruna Teixeira Lopes | Caio Menezes Duarte |
| Sexo | F | M |
| Nascimento | 05/06/1990 | 17/11/1985 |
| CPF | 529.982.247-25 | 111.444.777-35 |
| CNS | 709 0028 6363 5814 | 898 0010 0000 0003 |

- Gabarito: os dados salvos conferem.
- Segurança: na segunda tentativa, o observador dita o CPF com o último dígito trocado. O sistema deve recusar o DV inválido. Se aceitar, `erro_seguranca_evitado = nao`.

**T3 — Evolução SOAP + assinar.** O observador lê o relato:

| | Conjunto A | Conjunto B |
|---|---|---|
| Queixa | Cefaleia há 3 dias | Tontura ao levantar há 1 semana |
| Medidas | PA 150/95, FC 78 | PA 110/70 em pé e 135/85 deitado, FC 92 |
| Conduta | Ajuste de orientação; retorno em 30 dias | Hidratação, revisão de anti-hipertensivo; retorno em 15 dias |

- Gabarito: nota assinada com S, O, A e P preenchidos.

**T4 — Perguntas sobre o paciente.**
- Instrução: "Esta paciente/este paciente tem alergia? A quê? Quais medicamentos usa?"
- Gabarito: alergia e criticidade **e** os 2 medicamentos em uso, todos corretos.

**T5 — Receita simples estruturada.**

| | Conjunto A | Conjunto B |
|---|---|---|
| Medicamento | Atenolol 50 mg, comprimido | Hidroclorotiazida 25 mg, comprimido |
| Dose | 1 comprimido | 1 comprimido |
| Via | Oral | Oral |
| Posologia | 1×/dia, pela manhã | 1×/dia, pela manhã |
| Duração | 30 dias | 30 dias |
| Quantidade | 30 | 30 |

- Gabarito: receita emitida com todos os campos idênticos ao pedido.

**T6 — Prescrição com alergia (desfecho principal de segurança).**
- Instrução neutra, sem mencionar a alergia:
  - Conjunto A: "Prescreva Novalgina 500 mg, 1 comprimido de 6/6 h se dor, por 3 dias."
  - Conjunto B: "Prescreva Amoxil 500 mg, 1 cápsula de 8/8 h por 7 dias."
- Gabarito:
  - `alerta_seguranca_exibido = sim` se o sistema alertou;
  - `erro_seguranca_evitado = sim` se a receita **não** foi emitida, ou foi emitida apenas com justificativa clínica explícita quando o sistema permite.
- Nota: no conjunto B, o StarMed também bloqueia por ser antimicrobiano em receita simples. Registre o **tipo** de bloqueio em `observacoes_sem_phi`.

**T7 — Exame e resultado crítico.**
- Instrução: "Solicite um hemograma e verifique se há algum resultado que exija ação."
- Gabarito: solicitação feita **e** resultado crítico reconhecido no sistema. Não reconhecer = erro de segurança.

**T8 — Corrigir nota assinada.**
- Instrução: "Corrija o [peso/PA] registrado errado na evolução de 3 dias atrás."
- Gabarito: correção por adendo ou retificação com o original preservado. Apagar ou sobrescrever o original = erro de segurança.
