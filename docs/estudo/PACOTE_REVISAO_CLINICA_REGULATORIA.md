# Pacote de revisão clínica e regulatória

- **Versão:** 1.0 (2026-10-23)
- **Para:** médico responsável pela segurança clínica, farmacêutico clínico, jurídico/regulatório e DPO.
- **Como usar:** cada linha é **uma decisão** que o software tomou e que precisa ser aceita, corrigida ou rejeitada por um profissional habilitado.
  - Decisão **rejeitada** vira tarefa de engenharia.
  - Decisão **aceita** recebe nome, registro profissional, data e assinatura na tabela final.
- Sem este pacote assinado para o escopo do piloto, **não há piloto** ([PROTOCOLO_PILOTO.md](PROTOCOLO_PILOTO.md), P1).

## A. Prescrição (farmacêutico + médico responsável + jurídico)

| ID | Decisão implementada | Onde | Pergunta ao revisor | Revisor |
|---|---|---|---|---|
| A1 | Toda receita exige CRM/UF válido do **assinante**; sem isso, 422 e nada é emitido | `prescription-compliance.ts`, ADR-0005 | Correto? Exigir também endereço/telefone profissional na receita **simples**? | Jurídico |
| A2 | CPF do paciente **não** é obrigatório na receita | ADR-0005 | De acordo com a norma vigente (CFM/Anvisa) para cada tipo? | Jurídico |
| A3 | Antimicrobiano: validade de 10 dias **contando o dia da emissão como o 1º**, no fuso de Brasília | `validUntil()` | A leitura de "10 dias a contar da emissão" está correta ou é emissão + 10? | Farmacêutico + jurídico |
| A4 | Antimicrobiano exige sexo e idade do paciente, endereço do prescritor e **2 vias** no PDF | `prescriptions.ts` | Campos e vias corretos para a receita **eletrônica** (RDC 471/2021 vigente)? | Farmacêutico |
| A5 | Controle especial sempre bloqueado até SNCR homologado | `kindBlockReason()` | Aceitar o bloqueio total até a homologação? | Jurídico |
| A6 | Lista de 78 substâncias de controle especial usada **só para bloquear** receita simples/antimicrobiano | `data/drug-terms.json` | Revisar item a item contra as listas **vigentes** da Portaria 344 (há itens a conferir, ex.: atomoxetina). Faltam substâncias frequentes no serviço? | Farmacêutico |
| A7 | 9 antimicrobianos exigem o tipo "antimicrobiano" (não saem em receita simples) | `data/drug-terms.json` | Lista correta? Faltam (ex.: ceftriaxona, nitrofurantoína, amoxicilina+clavulanato)? | Farmacêutico |
| A8 | 139 sinônimos marca → princípio ativo; alergia e duplicidade casam pelo princípio ativo | `data/drug-terms.json` | Algum mapeamento errado (marca que mudou de fórmula, associação)? | Farmacêutico |
| A9 | Alergia ativa de criticidade **alta** ao mesmo princípio ativo = **bloqueio sem override**; criticidade baixa ou indeterminada = revisão obrigatória com justificativa de ≥ 20 caracteres | `evaluatePrescriptionSafety()` | Política de override adequada? Reatividade cruzada (ex.: penicilinas × cefalosporinas) **não** é avaliada: aceitar essa limitação até haver base licenciada? | Médico + farmacêutico |
| A10 | Dose por peso só é **informativa** (sem faixa de referência) | `medications.ts` | Manter assim até contratar base farmacológica licenciada? | Médico |

## B. Identificação do paciente (médico responsável + DPO)

| ID | Decisão | Onde | Pergunta |
|---|---|---|---|
| B1 | CPF e CNS opcionais; DV conferido; únicos por organização entre cadastros ativos | migração `028` | Tornar algum obrigatório em algum fluxo (ex.: SUS exige CNS)? |
| B2 | Lista de pacientes mostra só os 2 últimos dígitos do CPF | `controllers.ts` | Suficiente para distinguir homônimos na recepção? |
| B3 | MPI: CPFs diferentes = pessoas diferentes; nome parecido + mesmo nascimento = "possível"; **nunca une sozinho** | `mpi-matcher.ts` | Pesos e limiares do ref aceitáveis sem calibração local? (O teto aqui é 73 por falta do nome da mãe.) Incluir nome da mãe no cadastro? |
| B4 | Merge exige escolha de quem fica + justificativa + confirmação de conferência; sem DELETE; perdedor fica rastreável | `mpi.ts`, aba Duplicidades | Quem pode unir (hoje: médico e admin)? Exigir dupla aprovação? |

## C. Documentos e verificação pública (jurídico + DPO)

| ID | Decisão | Onde | Pergunta |
|---|---|---|---|
| C1 | Sem código, a página pública mostra tipo, situação, datas, prescritor (CRM/UF), nível de assinatura, hash e **iniciais** do paciente; **sem medicamento** | `rx-verify.ts` | Exposição mínima adequada (LGPD art. 6º, III)? |
| C2 | Com o código impresso, a farmácia vê nome completo, CPF mascarado e o medicamento | idem | Adequado para a dispensação? |
| C3 | 5 códigos errados bloqueiam por 30 min; consultas auditadas sem ator | idem | Prazo e limite adequados? Retenção dos logs? |
| C4 | Receita "atestada" (sem PAdES) declara no PDF que **não** é assinatura qualificada | `prescriptions.ts` | Texto juridicamente adequado? Pode ser usada no piloto ou só PAdES? |

## D. Terminologia (médico responsável)

| ID | Decisão | Pergunta |
|---|---|---|
| D1 | CID-10: catálogo local de 228 códigos de atenção primária só para **sugerir**; formato inválido → 400; código fora da lista é aceito | Catálogo adequado às especialidades do piloto? Versão da CID-10 do DATASUS conferida? |
| D2 | Problema "provisório" × "confirmado" é escolhido pelo médico; IA nunca confirma | De acordo? |

## E. Hazard log — itens afetados pela rodada de 2026-10-23

Reavaliar o status em `docs/clinical/HAZARD-LOG-FMEA.md`. O revisor decide se o estado muda:

- **H-01 (homônimos):** agora há CPF/CNS com DV e MPI com revisão. Proposta: continua `parcial` até a UI de confirmação antes de prescrever.
- **H-06 (antimicrobiano/controlado):** tipos de receita + guarda por substância. Proposta: `mitigado-código` para o **bloqueio**; `bloqueado-externo` para a emissão de controlado.
- **H-10 (QR vaza PHI):** a verificação pública não mostra medicamento sem código. Proposta: `mitigado-código` após a revisão de C1–C3.
- **H-27 (atestação × assinatura):** status tipado e texto no PDF. Proposta: mantém `em implementação` até a validação no ITI.

## F. Assinaturas

| Bloco | Nome | Registro (CRM/CRF/OAB) | Decisão (aceito / aceito com ressalvas / rejeitado) | Data | Assinatura |
|---|---|---|---|---|---|
| A — Prescrição | | | | | |
| B — Identificação | | | | | |
| C — Documentos | | | | | |
| D — Terminologia | | | | | |
| E — Hazard log | | | | | |

Ressalvas e rejeições viram tarefas registradas, com ID e prazo, antes do piloto.
