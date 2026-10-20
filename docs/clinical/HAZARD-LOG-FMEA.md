# Hazard Log / FMEA Clínico — StarMed

**Data:** 20/10/2026 · **Base:** `main` @ `20b801249b5c5d84e939b4ee1ca3ae1a46f2edf0`
**Escopo:** rastreamento de perigos assistenciais derivados de `STARMED_PROMPT_MESTRE_EXECUCAO_V2`
(Parte J1) e das regras de `docs/BUSINESS_RULES.md`.

> **Limite deste documento:** ele NÃO substitui a revisão de um diretor clínico
> habilitado, revisor farmacêutico e responsável de qualidade (item I2 do plano).
> Estes papéis ainda **não estão nomeados** — é pendência de governança, não de código.
> Status reflete revisão estática; nenhum teste foi executado nesta rodada.

**Legenda**

- **Sev:** 4 = dano grave/morte possível · 3 = dano reversível/atraso relevante · 2 = retrabalho · 1 = desconforto.
- **Det:** capacidade de o sistema detectar o erro antes do dano (Alta/Média/Baixa).
- **Status:** `mitigado-código` (controle no código, não validado em execução) · `parcial` · `aberto` · `bloqueado-externo`.

## 1. Perigos e controles

| ID | Perigo (cenário) | Sev | Det | Controle preventivo/detetivo (código) | Status | Ação pendente |
|---|---|---|---|---|---|---|
| H-01 | Troca de paciente por homônimo (mesmo nome/iniciais) | 4 | Média | Identificação com nascimento/gênero na UI; confirmação antes de prescrever (F1/D2) | `parcial` | UI de confirmação obrigatória + testes E2E #1 |
| H-02 | Duas abas/profissionais editam a mesma nota → perda de versão | 4 | Alta | `expectedVersion` + 409 + adendo separado (`domain.ts`, `schema.sql`) | `mitigado-código` | E2E concorrência #2 |
| H-03 | Alergia grave + medicamento contraindicado prescrito | 4 | Alta | Motor de segurança: `block` sem override p/ criticality high (em implantação P1-04) | `parcial` | Base licenciada + revisão farmacêutica #3 |
| H-04 | Substância suspeita tratada como "sem alergia" | 3 | Média | `verificationStatus` preservado (reported/unconfirmed); UI não infere negativo de lista vazia (D2) | `parcial` | UI prontuário 360 #4 |
| H-05 | Dose sem unidade/via emitida | 4 | Alta | Validação server-side bloqueia emissão (zod em prescrição, P1-04) | em implementação | E2E #5 |
| H-06 | Antimicrobiano/controlado fora das exigências legais | 4 | Alta | `special_class` off por padrão → 409 até configuração versionada | `bloqueado-externo` | Regulamentação ANS/Anvisa/conselho + tabelas versionadas #6/#7 |
| H-07 | Certificado errado/expirado/revogado gera "assinatura válida" | 4 | Alta | Rejeição dura de cadeia + status tipado honesto (P0-06, em andamento) | em implementação | Validação ITI datada #8 |
| H-08 | Interrupção de rede duplica receita/assinatura | 3 | Alta | `operationId` idempotente + tabela `idempotency_keys` | `parcial` | E2E retry #9 |
| H-09 | PDF assinado alterado 1 byte é aceito | 4 | Alta | ByteRange + hash + CMS na verificação (`pki/pades.ts`) | `mitigado-código` | Teste #10 + validador oficial |
| H-10 | QR/código público vaza PHI | 3 | Média | QR com referência mínima, acesso controlado (D4.7) | `parcial` | Revisão do payload do QR #11 |
| H-11 | Documento/receita entregue a destinatário errado ou link expirado vazando | 4 | Média | Link temporário com expiração, escopo e anti-enumeração; outbox com opt-out | `parcial` | E2E de entrega e revogação de link |
| H-12 | Resultado crítico comunicado só por push, sem confirmação | 4 | Média | Fila de comunicação com reconhecimento auditado (D5) | `aberto` | Implementar fluxo de critical results #12 |
| H-13 | Profissional sem vínculo acessa prontuário | 4 | Média | Papel clínico obrigatório + auditoria de TODA leitura (`patient.read`, `note.read`, `fhir.*.read`); vínculo/break-glass formal: pendência de desenho registrada (threat model §2.2.1) | `parcial` | Implementar contexto de atendimento + break-glass justificado #13 |
| H-14 | Dados do tenant B acessados via URL/token do tenant A | 4 | Alta | `org_id` do token em toda query (revisão estática 20/10) + RLS 014 (opt-in, owner bypass) | `parcial` | GUC transacional + role não-owner + testes cross-tenant #14 |
| H-15 | Token do paciente acessa rotas staff (`/users`, `/patients`) | 4 | Alta | `purpose:'portal'` rejeitado no `JwtGuard` | `mitigado-código` | Teste negativo executado #15 |
| H-16 | Admin assina nota clínica sem habilitação | 4 | Alta | Assinatura exige papel clínico habilitado (403) | `parcial` | Teste #16 em execução |
| H-17 | Nota assinada sofre UPDATE/DELETE | 4 | Alta | Trigger `forbid_signed_note_mutations()` + CHECKs + adendo | `mitigado-código` | Teste #17; cadeia digest externa |
| H-18 | Dois agendamentos no mesmo slot/profissional | 2 | Alta | Índice/EXCLUDE de não sobreposição + transação (D6) | `parcial` | Corrida real sob carga #18 |
| H-19 | Retry de job/outbox duplica prescrição/envio/documento | 3 | Alta | Idempotência + `idempotency_keys`; worker CRM com retry idempotente | `parcial` | Teste #19 |
| H-20 | IA aceita/finaliza conteúdo sem revisão | 4 | Alta | Sugestão nunca autossalva; `requires_physician_review`; assinatura humana obrigatória | `mitigado-código` | Avaliação com dataset + sign-off #20 |
| H-21 | Prompt injection em exame/transcrição altera política | 4 | Baixa | Instrução anti-injeção + isolamento de ferramentas (`controllers.ts:272`) | `parcial` | Testes adversariais executados #21 |
| H-22 | Transcrição incompleta vira fato clínico (dose desconhecida) | 4 | Média | Incerteza propagada em `uncertainties`; campos não fabricados | `parcial` | Avaliação clínica #22 |
| H-23 | Dados offline divergem ao reconectar | 3 | Média | `operationId`/sync idempotente (`offline.ts`, `idempotency_keys`) | `parcial` | Conflito + revogação + wipe #23 |
| H-24 | Falha de disco/banco corrompe histórico/auditoria | 4 | Média | Backup diário + sha256 + restore drill (`scripts/backup/*`) | `parcial` | Revalidar em infra-alvo e medir RPO/RTO #24 |
| H-25 | Troca de unidade/perda de vínculo durante sessão | 3 | Média | Reavaliação de autorização por request; invalidação de cache ao mudar contexto | `parcial` | E2E #25 |
| H-26 | Dose/unidade com fator de confusão (mg vs mL, UI vs ED) | 4 | Média | Unidade obrigatória + validação de faixa quando houver base licenciada | `parcial` | Validação clínica + fonte |
| H-27 | Evidencial: atestação exibida como assinatura jurídica | 4 | Alta | Status tipado (attested/signed/pades_verified) — P0-06 | em implementação | Validação externa ITI |

## 2. Distribuição por severidade (estado atual)

| Sev | Total | Abertos/parciais | Observação |
|---|---|---|---|
| 4 (dano grave) | 18 | ~15 | Concentrados em prescrição, assinatura, autorização e IA — são as frentes P0/P1 em execução |
| 3 | 6 | 5 | Operação, concorrência e offline |
| 2 | 1 | 1 | Agenda |

## 3. Regras de contenção enquanto o log estiver aberto

1. **NO-GO para dados reais** enquanto H-01, H-03, H-05, H-07, H-13, H-14, H-15 e H-16
   não tiverem evidência de teste executado (gates da Parte K do plano mestre).
2. Nenhum perigo pode ser fechado apenas por código: fecha com teste executado +
   revisão do papel responsável (clínica/farmacêutica/jurídica conforme o caso).
3. Novos perigos entram com a mesma coluna de evidência (`arquivo:linha` + teste + data).

## 4. Pendências de governança (bloqueios não-técnicos)

- Nomear: direção clínica, revisor farmacêutico, responsável de segurança, DPO e qualidade.
- Registrar aceite formal dos riscos residuais por estes papéis antes de qualquer uso clínico.
- Definir severidade × probabilidade com dados de operação real (não estimativa de engenharia).
