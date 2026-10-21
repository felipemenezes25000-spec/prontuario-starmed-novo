# ADR-0003 — Prontuário 360°: leitura agregada honesta, merge MPI de corrente única e versionamento no banco

**Data:** 21/10/2026 · **Status:** Aceito · **Decisor:** engenharia (com pendências
clínicas nomeadas abaixo)
**Escopo:** `timeline.ts`, `medications.ts`, `mpi.ts`, migração `022`, UI `Record360.tsx`.

## 1. Linha do tempo é SOMENTE LEITURA agregada (não é porta lateral)

- Uma única query UNION ALL de 7 tipos; `summary` curto (≤160) e **sem conteúdo
  clínico longo**: o JSONB da nota e os bytes do PDF ficam atrás dos endpoints
  dedicados, com a MESMA autorização (`requireRole` + `requireCareContext` +
  break-glass auditado). Auditoria própria em cada leitura (`patient.timeline.read`,
  `patient.medications.read`, `patient.documents.read`, `patient.document.versions.read`).
- `meta.signatureStatus` expõe o estado REAL (`none|attested|pades`): `attested`
  NUNCA é apresentado como assinatura qualificada — a validação oficial continua no
  verificador do ITI (dito na UI quando só existe v1).

## 2. `allergyState: 'none_recorded'` nomeia o REGISTRO, não a condição

Ausência de linhas em `patient_allergies` = "nada registrado no sistema". A UI é
obrigada a exibir "Nenhuma alergia registrada — isto NÃO significa ausência de
alergia; confirme a anamnese" (H-04 do hazard log). Inferir alergia negativa de
lista vazia é erro clássico de prontuário e ficou tecnicamente impossível de
expressar como "sem alergias".

## 3. Merge MPI: corrente única, sem DELETE, fail-closed

- O registro perdedor permanece em `patients` com `merged_into_id` (rastro legível,
  LGPD/CFM); **nunca DELETE** de paciente ou histórico. Cada merge é gravado em
  `patient_merges` com autor, motivo (20..500) e `moved_counts`.
- **Corrente única por regra de aplicação** (além do índice único): rejeita-se
  merge se QUALQUER um dos dois já participou de `patient_merges` ou tem
  `merged_into_id` — sem cadeias A←B←C (o rastro viraria labirinto e a dedup
  perde o sentido).
- **Irreversível por design**: não há "unmerge". Correção de merge errado exige
  novo cadastro + novo merge — e pela regra de corrente única, os pacientes já
  envolvidos não participam de novo. Operação é, portanto, deliberada.
- **Fail-closed**: 14 tabelas filhas movidas em transação única; QUALQUER
  violação de constraint (ex.: `portal_accounts UNIQUE(org_id,patient_id)` quando
  ambos têm conta) aborta TUDO com mensagem citando a tabela (sem PHI) — nunca
  skip silencioso de histórico.
- Exceções documentadas: `crm_outbox` não tem `patient_id`; `lgpd_consents` é
  append-only no banco (gatilho) e permanece sob o perdedor — o consentimento é do
  titular, e o rastro MPI cobre a leitura; `prescriptions/clinical_notes/...`
  referenciam o paciente via `encounters` e sobem com o encontro.
- **Candidatas a duplicata são SUGESTÃO a um humano**: igualdade de nome =
  lower+trim+colapso de espaços (acentos distinguem — limitação conhecida) +
  mesma data de nascimento; nunca merge automático (decisão de identidade é
  humana e auditada: `mpi.candidates.read`, `patient.merged`).
- Identidade de OUTRO paciente aparece em `duplicates` (nome/nascimento/external
  id) para `admin|doctor` com auditoria — é dado de IDENTIDADE para dedup, não
  conteúdo clínico; por isso sem `requireCareContext` (registro é
  reorganização de cadastro auditada). Risco aceito e registrado.

## 4. Versionamento de documentos vive no banco (022)

`document_versions` append-only com gatilho AFTER INSERT/UPDATE OF content:
qualquer re-embarque (ex.: PAdES troca o PDF atestado pelo embebido) vira nova
versão automaticamente — sem tocar nos controllers de escrita. A aplicação só
LÊ. A nota "somente v1" declara honestamente que o histórico começa na ativação
do versionamento, não prova imutabilidade prévia.

## Pendências NOMEADAS (quem decide)

- **Regra de acentuação/unaccent no MPI** (usar `unaccent` muda rejeições de
  duplicata): decisão de engenharia + direção clínica (identidade do paciente).
- **Política de "unmerge"/correção de merge errado** (hoje: novo cadastro):
  direção clínica + DPO.
- Cenários por especialidade (dose por peso, teratogenicidade, lateralidade,
  privacidade de psiquiatria): exigem base farmacológica LICENCIADA para regras
  de alerta (bloqueio externo) — a Fase 2 entrega apenas o transporte/dados;
  qualquer regra clínica dura fica pendente de farmacêutico/direção clínica.
