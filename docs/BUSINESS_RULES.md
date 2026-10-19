# RenoveJá Saúde — Regras de Negócio

> Extrato do [Guia do Produto](RENOVEJA_PRODUCT_OWNER_ONBOARDING_MASTER.md) (capítulos 7, 32), com data de referência de 16/09/2026. As etiquetas [PÚBLICO], [PRIVADO] e [AMBOS] estão explicadas em "Sobre este guia".

---

## 7. Regras de Negócio

### 7.1 Receita

| ID | Regra | Linha |
|---|---|---|
| RX-01 | O canal eletrônico atende **receita simples** e **receita de controle especial** | [PÚBLICO] |
| RX-02 | Notificações de Receita A e B seguem o talonário físico do prescritor | [PÚBLICO] |
| RX-03 | Receita de controle especial é renovada pelo canal eletrônico: é receituário próprio, em duas vias, sem numeração do SNCR. Validade de 30 dias e uma dispensação | [PÚBLICO] |
| RX-04 | Só medicamento de **uso contínuo** é renovável; a classe terapêutica do catálogo CMED/Anvisa define o uso contínuo | [PÚBLICO] |
| RX-05 | Receita com data antiga segue para avaliação do médico | [PÚBLICO] |
| RX-06 | Rasura só impede a renovação quando atinge informação decisiva: uso contínuo, fármaco, dose, identidade ou data | [PÚBLICO] |
| RX-07 | Imagem já usada por outro paciente é identificada e recusada | [PÚBLICO] |
| RX-08 | Limite de uso: até 10 receitas ativas e até 10 medicamentos distintos ativos por paciente | [PÚBLICO] |
| RX-09 | Um medicamento que já está em pedido ativo não entra em outro pedido | [PÚBLICO] |
| RX-10 | Renovação a partir do histórico disponível 30 dias depois do pedido anterior | [PÚBLICO] |
| RX-11 | Até 5 arquivos e 10 MB por envio; o conteúdo do arquivo precisa corresponder ao tipo declarado | [PÚBLICO] |
| RX-12 | Data de nascimento é obrigatória para pedir documento | [PÚBLICO] |
| RX-13 | Aprovar pedido sinalizado pela IA exige justificativa escrita do médico | [AMBOS] |
| RX-14 | A assinatura exige itens estruturados **conferidos pelo médico** | [PÚBLICO] |
| RX-15 | A quantidade a dispensar é registrada separadamente da posologia | [PÚBLICO] |
| RX-16 | Sinalizações internas da triagem ficam fora do documento; observações impressas passam por lista permitida | [PÚBLICO] |
| RX-17 | Referência do CFM 2.314/2022 para o paciente crônico: consulta presencial a cada 180 dias | [PÚBLICO] |
| RX-18 | Rodapé fixo: "Receita renovada segundo normas de uso contínuo. Por gentileza, não se esqueça de retornar à consulta de rotina." | [PÚBLICO] |
| RX-19 | Antimicrobiano identificado pelo catálogo usa o modelo da RDC 471/2021 (validade de 10 dias e retenção da 2ª via) | [PÚBLICO] |
| RX-20 | O preço é lido da tabela oficial no momento da aprovação e fica congelado no pedido | [PRIVADO] |

### 7.2 Exame

| ID | Regra |
|---|---|
| EX-01 | O pedido precisa ter exame, anexo ou sintomas |
| EX-02 | O motivo começa preenchido com "Investigação diagnóstica" e pode ser editado; o texto padrão não é impresso no PDF |
| EX-03 | Um exame que já está em pedido ativo não entra em outro pedido |
| EX-04 | Anexos: até 5 arquivos, 5 MB cada e 10 MB no total |
| EX-05 | Exames laboratoriais e de imagem saem em pedidos separados |
| EX-06 | Na importação por foto, a lista é preenchida com os exames reconhecidos no catálogo |
| EX-07 | A assinatura do pedido de exame usa o CPF do paciente |
| EX-08 | Sinais de alarme no motivo (dor no peito, falta de ar e outros) exibem um alerta de orientação |

### 7.3 Teleconsulta e pré-triagem

| ID | Regra |
|---|---|
| TC-01 | No app, a teleconsulta começa pela avaliação da Porta Digital; na web, a Porta Digital é aplicada conforme o contrato |
| TC-02 | Sinal de alarme na Porta Digital direciona para urgência |
| TC-03 | Risco alto ou gestante com febre segue para cuidado assistido; risco alto recebe prioridade alta |
| TC-04 | O aceite do TCLE da sessão, na versão vigente, é obrigatório |
| TC-05 | O aceite da consulta exige especialidade compatível e médico disponível |
| TC-06 | O pós-consulta emite até 4 documentos; a senha do certificado é validada antes da emissão |

### 7.4 Fila e decisão médica

| ID | Regra |
|---|---|
| MD-01 | O médico opera depois da aprovação da administração |
| MD-02 | Assumir um pedido é uma operação atômica: um único médico fica responsável |
| MD-03 | Pedido assumido sem atividade por 10 minutos volta para a fila |
| MD-04 | A fila é filtrada por especialidade e ordenada por prioridade e antiguidade |
| MD-05 | Recusa exige motivo |
| MD-06 | Devolução ao paciente é feita pelo médico responsável, com observação de 10 a 2.000 caracteres; o histórico é preservado |
| MD-07 | Recusas feitas pela IA podem ser reabertas pelo médico |
| MD-08 | O paciente cancela o pedido até a assinatura; documentos assinados e entregues ficam preservados |
| MD-09 | CRM validado é requisito para encaminhar, atender chamado imediato e operar agenda regulada |

### 7.5 Documento e assinatura

| ID | Regra |
|---|---|
| DC-01 | Assinatura com certificado **A1** (arquivo .pfx ou .p12) |
| DC-02 | O CPF do titular do certificado é igual ao CPF da conta do médico |
| DC-03 | Assinatura qualificada com carimbo do tempo em todos os documentos |
| DC-04 | Documento assinado é imutável; uma correção gera documento substituto |
| DC-05 | Se o paciente cancela durante a assinatura, o documento não é emitido |
| DC-06 | Verificação pública protegida contra tentativas repetidas |
| DC-07 | Validade na verificação: antimicrobiano 10 dias, controle especial 30 dias |

### 7.6 Setor público

| ID | Regra |
|---|---|
| SP-01 | Gestor e UBS organizam e preparam; **só o médico** prescreve, diagnostica e assina |
| SP-02 | Diferenças entre municípios são tratadas como configuração de contrato |
| SP-03 | Check-in exige identidade confirmada, presença e, na teleconsulta, consentimento vigente |
| SP-04 | Agendamentos acontecem dentro da vigência do contrato |
| SP-05 | A prontidão do contrato confere integrações exigidas, CNES da UBS com 7 dígitos, CPF dos profissionais e CBO dos médicos |
| SP-06 | A contrarreferência chega ao cidadão depois da ciência da equipe de origem |
| SP-07 | O auditor de controle externo acompanha os municípios da sua UF |
| SP-08 | Faturamento segue as etapas preparado → enviado → aceito ou glosado → pago |
| SP-09 | Em produção, a plataforma usa somente integrações reais |
| SP-10 | Eventos de integração aguardam credencial e homologação antes de transmitir |

### 7.7 Conta, privacidade e comunicação

| ID | Regra |
|---|---|
| AC-01 | Sessão de acesso de 1 dia, com renovação de 30 dias e rotação do token |
| AC-02 | Na web, a sessão fica em cookie HttpOnly; no app, no armazenamento seguro do sistema |
| AC-03 | Exclusão de conta é solicitada pelo canal de privacidade indicado no app |
| AC-04 | Notificações no celular não exibem o nome do paciente |
| AC-05 | Link de redefinição de senha vale 1 hora; links anteriores são invalidados |
| AC-06 | A trilha de auditoria é imutável |
| AC-07 | O contexto clínico é usado pela IA quando o paciente tem consentimento de IA vigente |

---

## 32. Princípios do Produto

Os princípios abaixo atravessam todas as funcionalidades do RenoveJá e explicam por que o produto se comporta como se comporta.

| # | Princípio | Por que existe |
|---|---|---|
| P1 | A decisão clínica, a emissão e a assinatura são do médico | Resolução CFM 2.454/2026 e responsabilidade profissional |
| P2 | A posologia impressa passa por conferência humana, item a item | Documento com validade jurídica nasce da decisão do médico |
| P3 | Aprovar pedido sinalizado pela IA exige justificativa | Rastreabilidade da decisão clínica |
| P4 | A renovação eletrônica atende receita simples e de controle especial; notificação de receita (azul e amarela) depende da numeração do SNCR e segue o talonário | Norma sanitária |
| P5 | Notificações de Receita A e B seguem o talonário físico do prescritor | Norma sanitária |
| P6 | Uso contínuo é definido pela classe terapêutica oficial | Segurança do paciente |
| P7 | Assinatura ICP-Brasil qualificada, com carimbo do tempo | Validade jurídica e prova de data e hora |
| P8 | CPF do certificado igual ao CPF do médico | Garantia de autoria |
| P9 | Documento assinado é imutável | Integridade |
| P10 | Sinalizações internas da triagem não aparecem no documento do paciente | Clareza do documento entregue |
| P11 | Na linha pública, o cidadão não paga | Modelo de contratação pública |
| P12 | A autorização é aplicada no servidor | Segurança entre municípios |
| P13 | Gestor e UBS organizam o cuidado; o ato médico é do médico | Separação de papéis clínicos |
| P14 | A contrarreferência chega ao cidadão depois da ciência da equipe de origem | Entrega com orientação profissional |
| P15 | Trilha de auditoria imutável e registro clínico guardado por 20 anos | CFM 1.821/2007 e fiscalização |
| P16 | TCLE aceito antes de cada teleconsulta | Boas práticas de telemedicina |
| P17 | O contexto clínico vai à IA com consentimento de IA | LGPD |
| P18 | Cada evento de integração SUS registra seu estágio real | Fidelidade da produção |
| P19 | Em produção, somente integrações reais | Qualidade do dado enviado ao SUS |
| P20 | Pré-triagem organiza o atendimento e não é diagnóstico | Segurança do paciente e ética médica |
