# Fluxo de receita médica (renovação)

Ordem dos passos e endpoints.

---

## 1. Paciente solicita receita (envia foto)

**Um único endpoint:** `POST /api/requests/prescription`

### Envio com imagens (recomendado) – multipart

- **Content-Type:** `multipart/form-data`
- **Campos:** `prescriptionType` (obrigatório: **simples**, **controlado** ou **azul**), `images` (obrigatório: um ou mais arquivos JPEG, PNG, WebP ou HEIC; máx. 10 MB por arquivo). Medicamentos não são enviados no multipart.
- **Quem:** paciente (Bearer token).
- **Efeito:** As imagens são enviadas para o **AWS S3** (bucket `renoveja-prescriptions`, prefixo `prescription-images/`, objetos **privados**). As URLs de **proxy da API** são salvas na solicitação no banco (`prescription_images`). Status **submitted**.
- **Resposta:** `{ "request": { "id": "...", "status": "submitted", "prescriptionImages": ["https://..[URL proxy da API]"], ... } }`

### Envio só com dados (JSON)

- **Content-Type:** `application/json`
- **Body:** `{ "prescriptionType": "simples", "medications": [], "prescriptionImages": [] }` (prescriptionType obrigatório; medications e prescriptionImages opcionais).
- **Quem:** paciente (Bearer token).
- **Efeito:** Cria a solicitação com status **submitted** usando as URLs informadas em prescriptionImages, se houver (sem upload).
- **Resposta:** `{ "request": { "id": "...", "status": "submitted", ... } }`

---

## 2. Médico aprova ou rejeita a renovação

### Aprovar
- **Endpoint:** `POST /api/requests/{id}/approve`
- **Body:** opcional `{ "medications": [], "exams": [], "notes": "..." }` — todos os campos são opcionais. `notes` passa a ser **obrigatório** quando a IA sinalizou dúvidas ou risco alto (`aiHasDoubts` ou `aiRiskLevel = high`).
- **Quem:** somente médico (Bearer token, role doctor). O médico precisa ser o dono do pedido (guarda de IDOR) ou o pedido estar sem médico atribuído.
- **Efeito:** Atribui o médico (se ainda não houver) e leva o status direto para **approved** — pronto para assinatura. O serviço é gratuito para o paciente: da aprovação o pedido segue direto para a assinatura digital.
- **Resposta:** `{ "id": "...", "status": "approved", ... }`

### Rejeitar
- **Endpoint:** `POST /api/requests/{id}/reject`
- **Body:** `{ "rejectionReason": "Motivo da reprovação" }` (obrigatório).
- **Efeito:** Status → **rejected**; o motivo fica em `rejectionReason` para o paciente ver.

---

## 3. Médico confere os itens da receita (obrigatório antes de assinar)

Exigência da **Resolução CFM 2.454/2026**: nenhum documento com validade ICP-Brasil sai com
dose/via/frequência/duração/quantidade que um modelo escreveu e nenhum humano confirmou.

- **Endpoint:** `GET /api/requests/{id}/prescription-items`
- **Quem:** o médico DONO do pedido (role doctor). Outro médico recebe 403.
- **Efeito:** devolve os itens estruturados. Quando ainda não existem, gera a proposta
  (análise da foto quando houver; senão o modelo, recebendo os nomes digitados pelo médico
  como `KnownMedications`) e a **persiste** com `source: "ai"` — a tela de conferência mostra
  exatamente o que será assinado, sem geração paralela que possa divergir do documento final.
- **Resposta:**
  ```json
  {
    "items": [{ "name": "...", "dose": "...", "route": "...", "frequency": "...",
                "duration": "...", "quantity": "...", "source": "ai" }],
    "source": "ai",
    "reviewedAt": null,
    "reviewedBy": null,
    "aiGeneratedAt": "2026-08-01T12:00:00Z"
  }
  ```

- **Endpoint:** `PATCH /api/requests/{id}/prescription-items`
- **Body:** `{ "items": [{ "name", "dose", "route", "frequency", "duration", "quantity" }] }`
- **Efeito:** persiste os itens conferidos, marca **todos** como `source: "doctor"` e carimba
  `reviewed_by_doctor_at` / `reviewed_by_doctor_id`. O campo `source` enviado pelo cliente é
  ignorado: a origem é decidida pelo servidor. É este carimbo que libera a assinatura.
- **Resposta:** mesmo payload do `GET`.

> Reescrever a lista de medicamentos (`PATCH /prescription-content`) invalida a conferência:
> o que foi confirmado não corresponde mais ao pedido, e é preciso conferir de novo.

---

## 4. Médico assina e envia a receita nova

- **Endpoint:** `POST /api/requests/{id}/sign`
- **Body:** `{ "signedDocumentUrl": "https://storage.../receita-123.pdf", "signatureData": "opcional-id-assinatura" }`
- **Quem:** médico (Bearer token, role doctor).
- **Efeito:** Associa a URL do documento assinado à solicitação, status: **approved** → **signed**. O paciente pode acessar a receita pelo `signedDocumentUrl` retornado em `GET /api/requests/{id}`.
- **Resposta:** `{ "request": { ..., "signedDocumentUrl": "...", "signedAt": "..." } }`
- **409 `REVIEW_REQUIRED`:** quando há item de origem `"ai"` sem conferência, **ou** quando não
  há item estruturado nenhum (o caminho em que o médico digitou só os nomes — exatamente o que
  deixava a IA escrever a posologia sozinha dentro da assinatura):
  ```json
  {
    "error": "REVIEW_REQUIRED",
    "message": "Os itens da receita foram gerados por IA e precisam da sua conferência antes da assinatura.",
    "itemsUrl": "/api/requests/{id}/prescription-items"
  }
  ```
  O portão vive no **backend**. A tela é conveniência; um cliente que chame a API direto esbarra
  no mesmo 409.

---

## Resumo da ordem

| # | Ação              | Endpoint                          | Status antes → depois              |
|---|-------------------|-----------------------------------|------------------------------------|
| 1 | Paciente solicita (imagens + dados na mesma API) | POST /api/requests/prescription (multipart ou JSON) | — → **submitted**                  |
| 2 | Médico aprova     | POST /api/requests/{id}/approve  | submitted / in_review → **approved** |
| 3 | Médico confere os itens | GET + PATCH /api/requests/{id}/prescription-items | approved (carimba `reviewed_by_doctor_at`) |
| 4 | Médico assina     | POST /api/requests/{id}/sign     | approved → **signed** (receita nova vinculada) |
| 5 | Paciente baixa/abre o PDF | POST /api/requests/{id}/mark-delivered | signed → **delivered** |

---

## Outros endpoints úteis

- `GET /api/requests` – lista solicitações do usuário (filtros `status`, `type`).
- `GET /api/requests/{id}` – detalhe da solicitação (inclui `signedDocumentUrl` quando assinada).
- `POST /api/requests/{id}/reject` – médico rejeita (body: `rejectionReason`).
- `POST /api/requests/{id}/assign-queue` – atribui a um médico disponível (fila).

Fluxo de **exame** é análogo (POST /api/requests/exam → approve → sign). **Consulta** tem fluxo próprio (sala de vídeo, etc.).

---

## AWS S3 (fotos de receita)

> ⚠️ **Seção corrigida em 22/08/2026.** Ela descrevia um bucket **público** e
> mandava criá-lo rodando um `.sql` no "SQL Editor do Dashboard" — instruções
> herdadas da era Supabase, que não valem para S3 e nunca valeram aqui. O
> arquivo citado, `docs/STORAGE_BUCKET.sql`, **não existe no repositório**.

- **Bucket:** `renoveja-prescriptions` (configurável em `AWS_S3_PRESCRIPTIONS_BUCKET`), **privado**. `prescription-images` **não é um bucket** — é um *prefixo* de chave dentro dele, ao lado de `receitas/`, `signed/` e `careplans/` (os prefixos legados que o `GetBucket` roteia para o bucket de prescriptions). `avatars/` **não** é um deles: vai para o bucket de avatars.
- **Acesso:** os objetos são enviados com `CannedACL = S3CannedACL.Private` (`S3StorageService.cs`). Nada é público para leitura. O app **nunca** recebe URL direta do S3: a API devolve URLs de proxy autenticado (`/api/requests/{id}/image/...`), e é por isso que `Api__BaseUrl` e `Api__DocumentTokenSecret` precisam estar configurados — sem eles as imagens não carregam para o médico.
- **Criação do bucket:** provisionamento de infraestrutura (Terraform / console AWS), não SQL.
- **Limite:** 10 MB por arquivo; tipos: JPEG, PNG, WebP, HEIC.
- As imagens ficam em `{userId}/{uuid}.{ext}`; a URL de proxy é salva em `requests.prescription_images` (array de texto).
