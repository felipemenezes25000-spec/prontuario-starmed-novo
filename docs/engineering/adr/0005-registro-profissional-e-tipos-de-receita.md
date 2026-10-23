# ADR-0005 — Registro profissional do prescritor e tipos de receita

- **Data:** 2026-10-23
- **Status:** aceito (técnico) · **pendente de parecer regulatório** antes de uso clínico
- **Origem:** lote 2 do porte do repositório de referência (RenoveJá+): `CrmValidator.cs`, `PrescriptionKind.cs`, `PrescriptionComplianceValidator.cs`, `PrescriptionExpiryValidator.cs`

## Contexto

O PDF da prescrição imprimia "Registro profissional (CRM/UF): pendência - não cadastrado no sistema". Não havia CRM/UF do prescritor no banco, e `specialClass` era sempre recusado com 409 sem modelo de tipo de receita.

## Decisão

1. **`practitioner_registrations` (029):** CRM/UF obrigatórios; RQE, especialidade, endereço e telefone profissionais opcionais. O formato é validado na API (`checkCrm`: 3 a 7 dígitos, sem sequência uniforme, UF entre as 27) e reforçado por CHECK no banco. O mesmo CRM/UF não pode estar em dois usuários da mesma organização. Só médicos têm registro. Quem edita: o próprio médico ou o admin da organização.
2. **Assinatura exige CRM/UF do ASSINANTE.** Sem registro válido, a assinatura retorna **422** com `missing[]`, e nenhum documento é emitido. O registro é congelado em `prescriptions.prescriber_registration` (snapshot) no ato da assinatura e coberto pelo gatilho de imutabilidade.
3. **`prescriptions.kind`:**
   - `simple`: sempre disponível.
   - `antimicrobial` (RDC 471/2021): **desligado por padrão** (`FEATURE_ANTIMICROBIAL_RX`). Exige sexo do paciente informado e endereço profissional do prescritor. Imprime sexo, idade, validade e **duas vias** (farmácia/paciente).
   - `controlled_special` (Portaria 344/1998): **sempre 409**. A receita eletrônica de controle especial depende de integração com o SNCR homologada pela Anvisa (`BLOCKED_EXTERNAL`).
4. **Validade do antimicrobiano:** 10 dias, contando o **dia da emissão como o 1º** (leitura conservadora de "10 dias a contar da emissão"), em dias civis no fuso `America/Sao_Paulo`. A data fica em `valid_until`.
5. **O que NÃO foi portado:**
   - Os prazos de "validade" do repositório de referência (365/180/60 dias): são regras de **renovação** daquela plataforma, não validade de dispensação.
   - A exigência de CPF do paciente em toda receita: é política daquela plataforma, não norma.

## Consequências

- Médicos sem CRM cadastrado deixam de assinar receitas. As jornadas E2E, o preflight e o smoke passaram a cadastrar CRM sintético; o smoke prova o 422 → cadastro → assinatura.
- As regras estão versionadas em `RX_RULES_VERSION`, impressas no PDF.

## Pendências nomeadas

- Parecer regulatório sobre a contagem da validade, os campos obrigatórios por tipo e as duas vias do antimicrobiano eletrônico.
- Conferência da situação do CRM no conselho: externa (o CFM não oferece API pública).
- SNCR: homologação na Anvisa para habilitar `controlled_special`.
