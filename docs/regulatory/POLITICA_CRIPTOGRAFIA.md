# Política de Criptografia — RenoveJá+

**Versão:** 1.0  
**Data:** 13 de abril de 2026  
**Classificação:** Documento Formal  
**Responsável:** Felipe Menezes — CTO / Fundador  
**Referência:** ISO 27001:2022 — Anexo A.10 (Criptografia)

---

## 1. Objetivo

Definir os padrões, algoritmos e procedimentos de criptografia adotados pela plataforma RenoveJá+ para proteger dados em trânsito e em repouso, em conformidade com a LGPD e normas de segurança da informação.

---

## 2. Escopo

Esta política aplica-se a todos os dados processados, transmitidos e armazenados pela plataforma, incluindo:
- Dados pessoais e sensíveis de pacientes (saúde)
- Credenciais e tokens de autenticação
- Certificados digitais ICP-Brasil
- Comunicações entre componentes da infraestrutura
- Backups e dados arquivados

---

## 3. Classificação de Dados

| Nível | Exemplos | Criptografia Exigida |
|-------|----------|----------------------|
| **Crítico** | Certificados PFX, credenciais de banco, chaves de API | AES-256 em repouso + TLS 1.2+ em trânsito + KMS |
| **Sensível** | Prontuários, receitas, CID, dados clínicos | AES-256 em repouso + TLS 1.2+ em trânsito |
| **Pessoal** | Nome, CPF, e-mail, telefone, endereço | AES-256 em repouso + TLS 1.2+ em trânsito |
| **Interno** | Logs de auditoria, métricas, analytics | TLS em trânsito; criptografia em repouso desejável |
| **Público** | Página de verificação de receitas, docs públicos | TLS em trânsito |

---

## 4. Criptografia em Trânsito

### 4.1 Protocolos

| Conexão | Protocolo | Versão Mínima |
|---------|-----------|---------------|
| Cliente → ALB (browser/app) | TLS | **1.2** — negocia 1.3 quando o cliente suporta |
| ALB → ECS (interno VPC) | HTTP | N/A (isolamento de rede) |
| ECS → RDS (banco) | SSL/TLS | Requerido (`sslmode=require`) |
| ECS → APIs externas | HTTPS | 1.2+ |
| WebSocket (teleconsulta) | WSS | TLS 1.2+ (Daily.co) |

> **Correção de 01/08/2026.** A tabela dizia "mínima 1.3". A política de
> segurança do listener é `ELBSecurityPolicy-TLS13-1-2-2021-06`
> (`infra/ecs.tf:148`), cujo nome descreve exatamente o comportamento real:
> **suporta** TLS 1.3 e tem **1.2 como piso**. Cliente que só fala 1.2 conecta.
>
> Não é um defeito — exigir 1.3 quebraria clientes legítimos, e 1.2 com as
> cifras dessa política é adequado para dado de saúde. O defeito era escrever
> "mínima 1.3" num documento entregue a município, que é uma afirmação
> verificável em 10 segundos por qualquer avaliador com `sslscan`.

### 4.2 Certificados TLS

| Parâmetro | Valor |
|-----------|-------|
| Provedor | AWS Certificate Manager (ACM) |
| Domínio | `*.renovejasaude.com.br` |
| Renovação | Automática (DNS validation via Route 53) |
| Algoritmo | RSA 2048-bit / ECDSA P-256 |

### 4.3 HSTS (HTTP Strict Transport Security)

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Ativo em produção. Garante que navegadores forcem HTTPS.

---

## 5. Criptografia em Repouso

### 5.1 Banco de Dados (RDS PostgreSQL)

| Parâmetro | Valor |
|-----------|-------|
| Algoritmo | AES-256 |
| Gerenciamento de chaves | AWS Managed Keys |
| Ativação | `storage_encrypted = true` no Terraform |
| Escopo | Todo o volume de armazenamento (dados + índices + backups + snapshots) |

### 5.2 Armazenamento de Objetos (S3)

> **Corrigido em 01/08/2026 (terceira passada):** a tabela citava um bucket
> `renoveja-documents` que **não existe**, e atribuía SSE-S3 aos buckets
> clínicos quando o Terraform usa **SSE-KMS**. Nomes e algoritmos abaixo
> conferidos contra `infra/storage.tf` e o state.

| Bucket | Criptografia | Uso | Estado |
|--------|-------------|-----|--------|
| `renoveja-prescriptions` | **SSE-KMS** (`aws:kms`) | Receitas assinadas | aplicado |
| `renoveja-certificates` | **SSE-KMS** | Atestados e certificados | aplicado |
| `renoveja-transcripts` | **SSE-KMS** | Transcrições de consulta (prontuário) | aplicado |
| `renoveja-avatars` | **SSE-KMS** | Fotos de perfil | aplicado |
| `renoveja-frontend-web` | SSE-S3 (AES-256) | Assets do frontend web | ⚠️ declarado em `storage.tf`, **não aplicado** (não consta do state) |

> **Correção de 22/08/2026:** a linha `renoveja-rh-web` saiu desta tabela. O
> portal RH foi removido do produto em 17/08/2026 (commit `152f8565`) e o
> arquivo `infra/cdn-rh.tf` que a tabela citava **não existe mais** no
> repositório. Se o bucket ainda existe na conta AWS, ele passou a ser recurso
> órfão — não declarado em nenhum `.tf` — e deve ser tratado como tal.

Os quatro buckets clínicos são cobertos por um único
`aws_s3_bucket_server_side_encryption_configuration` com `for_each` sobre
`local.private_buckets`, e esse recurso **está** no state. Os dois de frontend
não guardam dado pessoal — a lacuna é de padronização, não de exposição de dado
clínico. Aplicar: [`../ACOES_PENDENTES_AWS.md`](../ACOES_PENDENTES_AWS.md)
ação 5.

### 5.3 Segredos (AWS SSM Parameter Store)

| Parâmetro | Valor |
|-----------|-------|
| Tipo | SecureString |
| Criptografia | AWS KMS (chave gerenciada) |
| Caminho | `/renoveja/prod/*` |
| Exemplos | Chaves de API (OpenAI, Daily.co, Gemini), senha do banco, secrets de webhook |

### 5.4 Certificados Digitais (PFX)

| Parâmetro | Valor |
|-----------|-------|
| Algoritmo de proteção | **AES-256-GCM** (`AesGcm` em `CertificateEnvelopeCipher`) — autenticado, detecta adulteração do ciphertext |
| Esquema | **Envelope encryption (formato v3)** — cada certificado tem a **sua** chave de dados aleatória, e só ela é protegida pela KEK do provedor. A leitura ainda aceita v1 (AES-CBC legado) e v2 (AES-GCM com chave única de configuração), para não invalidar certificado já cadastrado |
| Provedor da KEK | `config` (chave em SSM) por padrão; `aws-kms` quando `CertificateEncryption:KmsKeyId` está preenchida. O `providerId` viaja **dentro** do envelope, então ligar/desligar o KMS não exige migração de dado |
| Chave legada (v1/v2) | Base64, 32 bytes (256 bits); tamanho validado no startup, que aborta com mensagem explícita se não bater |
| Armazenamento da chave | SSM Parameter Store (SecureString), sob KMS |
| **Senha do PFX** | ⚠️ **É armazenada.** Vai cifrada **dentro do mesmo envelope** do certificado (`[4 tam-senha][senha][pfx]`), por decisão explícita: separá-la para o Secrets Manager custaria um round-trip autenticado em todo fluxo de assinatura, inclusive o de lote. Ver `CertificateEnvelopeCipher.cs` |
| Uso | Assinatura digital de receitas (ICP-Brasil, A1/PFX) |

> **Correção de 22/08/2026.** Esta seção trazia como "limitação conhecida" que
> "a chave é uma única chave simétrica em SSM, sem *envelope encryption* por
> certificado". Isso deixou de ser verdade em 01/08/2026 (commit `0d93efd6`),
> que introduziu o `CertificateEnvelopeCipher` v3. Comprometer um envelope
> deixou de comprometer os outros.
>
> **O que continua sendo limitação, e é outra coisa:** (a) o `providerId`
> `config` continua sendo o padrão — só se usa KMS se `KmsKeyId` estiver
> preenchida, e este repositório não permite verificar se está no ambiente real;
> (b) certificados gravados em v1/v2 **antes** de 01/08/2026 continuam
> protegidos pela chave única legada até serem regravados; (c) a senha do PFX,
> como a tabela agora declara, é persistida junto do certificado.
>
> **Consequência para a política de privacidade:** qualquer texto voltado ao
> médico dizendo "a senha do certificado não é armazenada" está errado e precisa
> ser corrigido onde aparecer.

---

## 6. Hashing de Senhas

| Parâmetro | Valor |
|-----------|-------|
| Algoritmo | **bcrypt** |
| Biblioteca | BCrypt.Net-Next 4.0.3 |
| Fator de custo | **11** — o padrão da biblioteca. `BCrypt.HashPassword(senha)` é chamado sem sobrecarga de custo, e não há chave de configuração que altere isso |
| Salt | Gerado automaticamente por hash |

> Senhas **nunca** são armazenadas em texto plano ou com hashing reversível.

> **Correção de 01/08/2026:** o valor documentado era "configurável (padrão 12)".
> Não é configurável e não é 12. Elevar para 12 é um argumento a mais na chamada;
> o custo é dobrar o tempo de verificação no login. A decisão fica em aberto — o
> que não pode ficar é o documento afirmando um fator que o código não usa.

### 6.1 Hashing de tokens de sessão

Token de sessão **não** usa bcrypt, e isso é deliberado: `AuthToken.ComputeHash`
aplica SHA-256 puro. O token é 256 bits vindos de `RandomNumberGenerator`, não
uma senha escolhida por humano — não há espaço de busca a encarecer, e a
validação está no caminho quente de **toda** requisição autenticada, onde bcrypt
custaria dezenas de milissegundos por request sem ganho de segurança.

---

## 7. Gerenciamento de Chaves

### 7.1 Rotação

| Tipo de Chave | Frequência de Rotação | Responsável |
|---------------|----------------------|-------------|
| Chaves de API (OpenAI, Daily.co) | Trimestral ou em caso de comprometimento | CTO |
| Senha do banco de dados | Semestral | CTO |
| Chave de criptografia de certificados | Anual | CTO |
| Certificados TLS (ACM) | Automática (ACM auto-renewal) | AWS |
| Chaves KMS (SSM) | Anual (rotação automática AWS) | AWS |

### 7.2 Procedimento de Rotação

1. Gerar nova chave/segredo
2. Atualizar no SSM Parameter Store
3. Forçar novo deployment no ECS (novo task definition)
4. Verificar health checks e funcionalidade
5. Revogar chave anterior após confirmação
6. Registrar rotação em log de auditoria

### 7.3 Comprometimento de Chave

Em caso de suspeita de comprometimento:
1. Rotacionar a chave **imediatamente**
2. Notificar o DPO
3. Investigar escopo do impacto
4. Registrar incidente conforme Plano de Resposta a Incidentes
5. Notificar ANPD se dados pessoais foram expostos (até 48h)

---

## 8. Algoritmos Proibidos

Os seguintes algoritmos **não devem** ser utilizados:

| Algoritmo | Motivo |
|-----------|--------|
| MD5 | Colisões conhecidas; não resistente a ataques |
| SHA-1 | Colisões demonstradas em 2017 |
| DES / 3DES | Tamanho de chave insuficiente |
| RC4 | Vulnerabilidades múltiplas |
| TLS 1.0 / 1.1 | Obsoletos; vulneráveis a POODLE, BEAST |
| SSL 3.0 | Obsoleto; vulnerável |

---

## 9. Auditoria e Monitoramento

| Controle | Implementação |
|----------|--------------|
| Logs de acesso a segredos | CloudTrail (SSM GetParameter) |
| Alertas de rotação vencida | Manual (roadmap: automatizar) |
| Verificação de TLS | Monitoramento via health check + WAF logs |
| Scan de segredos no código | Gitleaks — hook local de `pre-commit`/`pre-push` **e** job `secrets` do `ci.yml` (gitleaks 8.28.0, versão fixa) |
| SAST | Semgrep (OWASP + regras de linguagem) — hook local de `pre-push` **e** job `sast` do `ci.yml` (imagem fixada por digest) |

> **Histórico desta linha, em três datas — leia as três, porque a conclusão
> muda em cada uma.**
>
> **01/08/2026:** "Gitleaks + Semgrep no CI/CD" era falso; os scanners rodavam
> só nos hooks do husky, na máquina do desenvolvedor.
>
> **16/08/2026:** os workflows foram removidos por um dia e o texto passou a
> dizer "não existe CI/CD nenhum, `.github/workflows/` tem exatamente dois
> workflows".
>
> **17/08/2026 — `ci.yml` voltou, e os scanners passaram a rodar no servidor.
> Correção registrada aqui em 22/08/2026, porque o texto de 16/08 ficou parado.**
> `.github/workflows/` tem hoje **11 workflows**, e `ci.yml` (gatilho `push` na
> `main` e `pull_request`) traz os jobs `secrets` (gitleaks), `sast` (Semgrep),
> `iac` (Trivy + `terraform validate`), `raiz` (dependências) e o agregador
> `ci-gate`. A diferença importa para auditoria: hook local é desarmável sem
> registro (`--no-verify`, `HUSKY=0`, clonar sem `npm install`); execução em
> Actions produz log datado por commit.
>
> ⚠️ **Ressalva que anula o ganho hoje, e é o ponto honesto:** desde
> **21/08/2026 nenhum job do GitHub Actions chega a iniciar** — os runs de `CI` e
> `CodeQL` na `main` terminam em falha em 4-9 segundos, sem executar etapa
> alguma. Enquanto isso durar, **o único portão que realmente roda é o hook local
> de `pre-push`**, e o vermelho do Actions não é regressão de código. Não
> apresente log de Actions desse período como evidência de execução de controle.
> A favor do hook: a política dele é absoluta — qualquer achado bloqueia, e
> **ferramenta ausente reprova em vez de pular em silêncio** (`.husky/pre-commit`,
> `.husky/pre-push`). Contra: continua desarmável pelo próprio operador, sem rastro.
>
> Registrado como pendência P1 em
> [PENDENCIAS_TI.md §8.2](../PENDENCIAS_TI.md); portões locais descritos no
> [README](../../README.md#portoes-locais-pre-commit-e-pre-push).

---

## 10. Conformidade

| Norma | Requisito | Status |
|-------|-----------|--------|
| LGPD Art. 46 | Medidas técnicas de proteção de dados | Conforme |
| ISO 27001 A.10.1 | Política de uso de controles criptográficos | Este documento |
| ISO 27001 A.10.2 | Gerenciamento de chaves | **Parcial** — chaves existem e estão sob KMS, mas a rotação é 100% manual (§7.1 é procedimento, não automação) e não há registro de rotação executada. Um auditor pede a evidência, não a política |
| OWASP | Cryptographic Failures (A02:2021) | Mitigado |

---

## 11. Roadmap de Melhorias

> **Prazos revisados em 01/08/2026.** A tabela abaixo foi escrita em abril e
> nenhum item saiu do papel. O prazo "Q2 2026" do envelope encryption **venceu**
> sem entrega. Manter uma data vencida como se fosse futura, num documento que
> vai para edital, é pior do que assumir o atraso.

| Melhoria | Prioridade | Prazo original | Situação em 01/08/2026 |
|----------|-----------|----------------|------------------------|
| Implementar envelope encryption para certificados PFX | Alta | Q2 2026 | ✅ **Entregue em 01/08/2026** (commit `0d93efd6`, `CertificateEnvelopeCipher` v3) — fora do prazo original, mas feito. Situação atualizada em 22/08/2026; a linha ainda dizia "vencido, não iniciado". **Resta**: apontar `CertificateEncryption:KmsKeyId` para uma CMK real e regravar os envelopes v1/v2 remanescentes |
| Migrar SSE-S3 para SSE-KMS (chaves dedicadas) nos buckets de documentos | Média | Q3 2026 | Não iniciado — Q3 corrente |
| Automatizar alertas de rotação de chaves vencidas | Média | Q3 2026 | Não iniciado. Depende do item 7.1 de [PENDENCIAS_TI.md](../PENDENCIAS_TI.md): não há SNS nem alarme aplicado para pendurar o alerta |
| Avaliar criptografia a nível de coluna no PostgreSQL para campos CID | Baixa | Q4 2026 | Não iniciado |

---

**Próxima revisão:** Outubro de 2026

---

*RenoveJá Saúde Digital LTDA*  
*Este documento é confidencial e destinado exclusivamente a fins de conformidade.*
