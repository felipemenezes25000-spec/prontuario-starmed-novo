# Fluxo de leitura com IA (gpt-5.6-luna)

A IA participa em dois fluxos: **Renovação de Receita** e **Pedido de Exame**.

## 1. Renovação de Receita

- A IA lê a(s) imagem(ns) da receita vencida.
- Extrai: medicamento(s), dosagem, médico anterior.
- Classifica **risco** (low, medium, high).
- Gera **resumo para o médico** (texto copiável para doc/PDF).
- Se a imagem estiver ilegível, a IA retorna `aiReadabilityOk: false` e `aiMessageToUser` pedindo ao paciente que envie uma foto mais nítida. O paciente pode chamar **POST /api/requests/{id}/reanalyze-prescription** com novas URLs de imagem.

## 2. Pedido de Exame

- **Com imagem do pedido antigo:** a IA extrai tipo de exame, indicação clínica e classifica **urgência** (routine, urgent, emergency).
- **Só texto:** a pessoa pode apenas escrever o que quer; a IA ajusta/estrutura o texto para o médico.
- Gera **resumo para o médico** (copiável).
- Se houver imagem ilegível, retorna mensagem pedindo envio mais legível. Reanálise: **POST /api/requests/{id}/reanalyze-exam**.

## Configuração

- **OpenAI:** defina a chave em **appsettings** ou variável de ambiente:
  - `OpenAI:ApiKey` ou `OpenAI__ApiKey` (ex.: `sk-proj-...`).
  - Nunca commite a chave no repositório.
- **Modelo de leitura/renovação de receitas e exames:** `gpt-5.6-luna` (raciocínio superior para OCR de receitas manuscritas), configurável em `OpenAI:ModelPrescription`.
- **Modelo padrão dos demais fluxos** (anamnese, evidências, polish, sumário clínico, conduta): `gpt-5.6-luna`, em `OpenAI:Model`. Desde 19/09/2026 **nenhum fluxo clínico roda em `gpt-4o`** — a única exceção deliberada é `OpenAI:ModelFast` (`gpt-4o-mini`), usado em chamadas latência-crítica como o assistente de voz.
- **Fallback:** Gemini 2.5 Flash quando a OpenAI falha ou a chave está ausente.
- Chamadas para famílias `gpt-5*` passam por um normalizador de parâmetros no transporte (`max_tokens`→`max_completion_tokens`, sem `temperature`) — ver README do backend e `AiModelProfiles`.

## Resposta da API (solicitação)

Os campos de IA vêm no `RequestResponseDto`:

- `aiSummaryForDoctor`: texto para o médico copiar e colar no documento/PDF.
- `aiExtractedJson`: dados extraídos (medicamentos, dosagem, etc.) em JSON.
- `aiRiskLevel` (receita): low | medium | high.
- `aiUrgency` (exame): routine | urgent | emergency.
- `aiReadabilityOk`: `false` quando a IA não conseguiu ler; o front deve exibir `aiMessageToUser` e permitir novo envio de imagem.

## Banco de dados

As colunas são criadas automaticamente no startup pelo `MigrationRunner`
(`src/RenoveJa.Infrastructure/Data/Postgres/MigrationRunner.cs`). Para
referência (auditar o que será aplicado), o equivalente SQL é:

```sql
ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS ai_summary_for_doctor TEXT,
  ADD COLUMN IF NOT EXISTS ai_extracted_json TEXT,
  ADD COLUMN IF NOT EXISTS ai_risk_level TEXT,
  ADD COLUMN IF NOT EXISTS ai_urgency TEXT,
  ADD COLUMN IF NOT EXISTS ai_readability_ok BOOLEAN,
  ADD COLUMN IF NOT EXISTS ai_message_to_user TEXT;
```

## Endpoints

- **POST /api/requests/{id}/reanalyze-prescription** — body: `{ "prescriptionImageUrls": ["url1", "url2"] }`. Somente o paciente.
- **POST /api/requests/{id}/reanalyze-exam** — body: `{ "examImageUrls": ["url1"], "textDescription": "opcional" }`. Somente o paciente.

## Teste no front

> ⚠️ **Este arquivo não existe mais.** `docs/test-ai-reading.html` foi removido
> em 07/04/2026 (commit `bbad6cc0`, "removendo itens desnecessarios") e a seção
> abaixo ficou órfã desde então — verificado em 22/08/2026. Ela está preservada
> como registro do que a página fazia; para exercitar os fluxos hoje, chame os
> endpoints da seção anterior direto (curl / cliente HTTP).

Abra **docs/test-ai-reading.html** no navegador (ou sirva a pasta por um servidor HTTP, ex.: `npx serve docs` na pasta do backend). Configure a URL da API (ex.: `http://localhost:5000`) e o **Bearer Token** (obtido no login). É possível:

1. **Criar receita** — tipo + envio de imagens (multipart); a IA analisa e o resumo aparece com botão **Copiar**.
2. **Criar exame** — tipo, exames e sintomas; a IA estrutura o texto e exibe o resumo.
3. **Buscar solicitação** — informar o ID para ver a solicitação e os campos de IA.
4. **Reanalisar receita** — informar ID e novas URLs de imagem (ex.: após enviar foto mais legível).
5. **Reanalisar exame** — ID + opcionalmente novas URLs e/ou texto.
