# Avaliação de UX e visual — StarMed × concorrentes (2026-10-23)

- **Método:** avaliação heurística por especialista: 10 heurísticas de Nielsen, mais 4 critérios de segurança clínica do Plano Mestre V1 §7.1.
- **Material do StarMed:** 16 capturas reais (desktop 1440×900 e celular 390×844) com dados **sintéticos**, geradas por `scripts/estudo/capturar-telas.mjs` (reprodutível). Ficam em [evidencias/ux-2026-10-23/starmed/](evidencias/ux-2026-10-23/starmed/).
- **Material dos concorrentes:** só páginas **públicas** de iClinic, Feegow, Amplimed e MV. Não foram versionadas, por serem imagens de terceiros.

## 0. A resposta curta e honesta

**Não é possível dizer, com o que existe hoje, que o StarMed é mais bonito ou tem melhor UX que os concorrentes.** Dois motivos:

1. **Não vimos as telas reais dos concorrentes.** Os sistemas exigem conta. Nos sites públicos, as imagens de produto são maquetes de marketing, e as de iClinic e MV carregaram **em branco** (animações e carregamento tardio). Comparar a tela real do StarMed com marketing deles seria injusto **a favor** de quem tem a melhor peça publicitária.
2. **Beleza é preferência; UX se mede.** O que decide é tempo de tarefa, erros e satisfação com médicos reais ([PROTOCOLO_ESTUDO_COMPARATIVO.md](PROTOCOLO_ESTUDO_COMPARATIVO.md)).

**O que dá para afirmar com as capturas:**
- O **visual do StarMed é profissional e coeso**, do nível de um SaaS moderno: paleta teal/azul-petróleo consistente, tipografia com hierarquia clara, cartões e espaçamento generosos, ícones de uma única família.
- Os sites dos concorrentes (iClinic, Amplimed, Feegow) têm acabamento de marketing comparável ou superior, com fotos, vídeo e prova social. A MV é a mais datada visualmente.
- A **UX clínica do StarMed tem problemas concretos e corrigíveis**, listados abaixo. Alguns afetam a segurança do paciente, que pesa mais do que a estética.

## 1. Pontuação heurística do StarMed (0 = grave · 4 = excelente)

| # | Heurística | Nota | Evidência |
|---|---|---|---|
| H1 | Visibilidade do estado do sistema | 3 | "API disponível", "Atestada" × "Assinada", contador de eventos; falta indicação de salvamento perto do editor |
| H2 | Correspondência com o mundo real | **1** | Termos internos em inglês na tela: `consultation`, `scheduled`, `general`, `prescription`; data ISO "1958-04-12"; jargão técnico ("LIS_URL/PACS_URL", "nenhum byte na rede", SHA-256 na linha do tempo) |
| H3 | Controle e liberdade | 3 | Cancelar e voltar presentes; merge com cancelamento |
| H4 | Consistência e padrões | 2 | A aba Duplicidades não usa o cartão das outras abas; selo **vazio** ao lado do SHA na linha do tempo; checkbox "só críticos" quebra a linha em Resultados |
| H5 | Prevenção de erros | **4** | Receita sem CRM bloqueada; controlado bloqueado; alergia por princípio ativo; merge com justificativa e confirmação; DV do CPF/CNS |
| H6 | Reconhecer em vez de lembrar | 2 | O **cabeçalho do paciente não mostra idade nem alergias**: é preciso ir ao Resumo ou ao Alto risco |
| H7 | Flexibilidade e eficiência | 2 | Com 1 atendimento aberto, a tela ainda pede "Selecione um atendimento" (clique extra); não há atalhos |
| H8 | Estética e design minimalista | 2 | Visual bonito, mas o **banner do painel ocupa ~40% da tela** (100% no celular) sem informação clínica; menu com 15 itens para o médico (Métricas, LGPD, Segurança, Templates) |
| H9 | Recuperação de erros | 3 | Mensagens do 422/409 explicam o motivo; erros de rede em português |
| H10 | Ajuda e documentação | 2 | Textos de ajuda inline bons no cadastro; falta ajuda contextual no restante |
| S1 | Contexto do paciente sempre visível (nome, idade, alergias) | **1** | Nome e nascimento sim; **idade e alergia não**, inclusive na tela de Prescrições (risco H-01/H-03) |
| S2 | Homônimos distinguíveis | 3 | Nascimento na lista e CPF mascarado; aba de duplicidades |
| S3 | Estados honestos (atestado ≠ assinado) | 4 | Rótulos "Atestada" e "Assinada"; página pública explica que não é ICP |
| S4 | Celular | 2 | Funciona (menu horizontal), mas o banner ocupa a primeira tela e o cabeçalho do paciente quebra o nome |

**Média: 2,4 / 4.** O StarMed é forte em prevenção de erros e honestidade (H5, S3), em que os concorrentes **não declaram** nada equivalente, e fraco em linguagem e contexto do paciente (H2, H6, S1), justamente o que o médico sente nos primeiros 5 minutos.

## 2. O que os concorrentes mostram publicamente (só marketing)

| Sistema | O que a página pública transmite | Lição para o StarMed |
|---|---|---|
| iClinic | Proposta "completo como você precisa, simples como deve ser"; IA de transcrição em destaque; preço transparente | A promessa principal é **economia de tempo com IA**; o StarMed ainda não tem a IA ligada |
| Feegow | Números de escala (70 mil profissionais, 88 milhões de pacientes); "gestão completa" | Prova social; o StarMed não tem nenhuma |
| Amplimed | Visual limpo e roxo, segmentação por porte (consultório, clínica, operadora), "Amélia IA" | Mensagem segmentada por perfil |
| MV | Foto institucional, "Melhor PEP da América Latina (KLAS)" | Peso de marca e reconhecimento externo |

Nenhum deles exibe publicamente a tela de prescrição, os alertas de alergia ou o cabeçalho do paciente. Não há como comparar esses pontos sem acesso.

## 3. Correções priorizadas (o que melhora a UX de verdade)

| Pri | Problema | Correção |
|---|---|---|
| P1 | Cabeçalho do paciente sem idade e alergias (S1) | Faixa fixa: nome, **idade**, sexo e **alergias críticas** em vermelho, em Prontuário, 360° e Prescrições |
| P1 | Termos em inglês e data ISO (H2) | Traduzir `kind`, `status`, especialidade e tipo de documento; datas em dd/mm/aaaa |
| P2 | Selo vazio e SHA-256 na linha do tempo (H4, H8) | Remover o selo vazio; mover o hash para "detalhes" |
| P2 | Banner do painel (H8) | Trocar o banner por "Próximos pacientes" e "Pendências" (resultados críticos, notas não assinadas) |
| P2 | Jargão técnico em Resultados (H2) | "Integração com laboratório desligada neste ambiente" |
| P2 | Aba Duplicidades destoando (H4) | Usar o mesmo cartão e a mesma tipografia das outras abas |
| P3 | Botões cortados em Prescrições e coluna vazia | Rótulos curtos ("Assinar ICP"), layout de 1 coluna |
| P3 | Menu com 15 itens para o médico (H8) | Agrupar Métricas, LGPD, Segurança e Templates em "Administração", visível só para admin |
| P3 | Página pública de verificação sem marca e colada ao topo | Logo, margem superior e cartão |

## 4. Corrigido nesta rodada (capturas em [evidencias/ux-2026-10-23/starmed-depois/](evidencias/ux-2026-10-23/starmed-depois/))

| Item | Antes | Depois |
|---|---|---|
| S1: contexto do paciente | Só nome e data ISO | **Idade + nascimento dd/mm/aaaa + alergias ativas** (crítica em vermelho) em Prontuário, 360° e Prescrições. Sem registro: "Nenhuma alergia registrada (não significa ausência)". Erro de leitura: "Alergias indisponíveis — consulte o prontuário antes de prescrever" (nunca um falso "sem alergia") |
| H2: inglês na tela | `general`, `prescription`, `consultation`, `scheduled` | "Clínica geral", "Receita (PDF)", "Consulta", "Agendado" (a API mantém os códigos) |
| H4/H8: selo vazio e hash | Selo vazio + "SHA-256 216a…" | Selo **"Íntegro"** (hash no tooltip e na aba Documentos) |
| H2: jargão em Resultados | "LIS_URL/PACS_URL… nenhum byte na rede" | "Integração com laboratório e imagem — desligada neste ambiente" |
| H4: aba Duplicidades | Sem cartão, tipografia própria | Mesmo cartão e título das outras abas |

**Verificação:** build OK; **E2E 25/25**, inclusive a jornada 9 de acessibilidade (axe sem violações sérias/críticas).

**Pontuação revista:**

| Item | Nota antes | Nota depois |
|---|---|---|
| H2 | 1 | 2 |
| H4 | 2 | 3 |
| H6 | 2 | 3 |
| S1 | 1 | 3 |
| **Média** | **2,4** | **2,8 / 4** |

**Ainda em aberto (P2/P3):**
- banner do painel;
- layout e rótulos cortados em Prescrições;
- menu com 15 itens;
- página pública sem marca;
- texto "MVP / API disponível" para o médico.

## 5. Próximo passo para ter uma resposta de verdade

Rodar o estudo comparativo com 12 a 16 médicos em **iClinic × StarMed** (mesmo segmento, preço público e teste grátis disponível, o que permite acesso legítimo) e só então falar em "melhor UX", com números.
