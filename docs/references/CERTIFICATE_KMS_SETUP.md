# Envelope encryption do certificado ICP-Brasil (AWS KMS)

## O que mudou no código

Antes, o PFX de assinatura de **todos** os médicos era cifrado com **uma única** chave AES-256
vinda de `CertificateEncryption:Key`, com a senha do PFX embarcada no mesmo blob. Uma chave, um
vazamento, e o atacante ganha a capacidade de assinar receita com validade legal em nome de
qualquer médico da plataforma — já com a senha.

Agora existe `ICertificateKeyProvider` (envelope encryption) com duas implementações:

| Provedor  | KEK                                        | Quando é usado na ESCRITA           |
|-----------|--------------------------------------------|-------------------------------------|
| `config`  | `CertificateEncryption:Key` (env/SSM)      | Sempre que não há CMK configurada   |
| `aws-kms` | CMK do AWS KMS, dentro do HSM              | Quando `CertificateEncryption:KmsKeyId` está definido |

Cada certificado recebe a **sua** chave de dados aleatória; a KEK protege apenas essa chave de
32 bytes. O identificador do provedor viaja **dentro** do envelope, então:

- ligar o KMS **não invalida** nenhum certificado já cadastrado;
- desligar o KMS falha **alto** ao ler um certificado gravado por ele, com mensagem explícita —
  nunca em silêncio.

A leitura continua aceitando os formatos antigos (v1 AES-CBC e v2 AES-GCM). Isso é a fase
EXPAND: nenhuma migração de dados é necessária, e os certificados são reescritos no formato
novo naturalmente, no próximo upload de cada médico.

`CertificateEncryption__Key` **continua obrigatório mesmo depois de ligar o KMS** — é o que lê
os certificados nos formatos antigos. Removê-lo é o que quebraria a assinatura.

## Comandos (rodar com credencial de produção)

Região: `sa-east-1`. Projeto: `renoveja`. Cluster ECS: `renoveja-prod`. Task role: `renoveja-ecs-task`.

### 1. Criar a CMK e o alias

```bash
KEY_ID=$(aws kms create-key \
  --region sa-east-1 \
  --description "RenoveJa+ — KEK dos certificados digitais ICP-Brasil (envelope encryption)" \
  --key-usage ENCRYPT_DECRYPT \
  --key-spec SYMMETRIC_DEFAULT \
  --tags TagKey=Project,TagValue=renoveja TagKey=Sensitivity,TagValue=icp-brasil \
  --query 'KeyMetadata.KeyId' --output text)

aws kms create-alias \
  --region sa-east-1 \
  --alias-name alias/renoveja-certificados \
  --target-key-id "$KEY_ID"

# Rotação automática anual. Com envelope encryption a rotação NÃO exige reescrever nada:
# o KMS guarda o material antigo para decifrar envelopes anteriores.
aws kms enable-key-rotation --region sa-east-1 --key-id "$KEY_ID"
```

### 2. Dar permissão à task role do ECS

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws iam put-role-policy \
  --role-name renoveja-ecs-task \
  --policy-name renoveja-ecs-kms-certificados \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"kms:GenerateDataKey\", \"kms:Decrypt\"],
      \"Resource\": \"arn:aws:kms:sa-east-1:${ACCOUNT_ID}:key/${KEY_ID}\"
    }]
  }"
```

Só `GenerateDataKey` e `Decrypt`. A aplicação nunca precisa de `kms:Encrypt` (quem cifra o
conteúdo é a chave de dados) nem de qualquer permissão administrativa sobre a CMK.

### 3. Publicar o parâmetro que liga o provedor

```bash
aws ssm put-parameter \
  --region sa-east-1 \
  --name /renoveja/prod/CertificateEncryption__KmsKeyId \
  --value alias/renoveja-certificados \
  --type String \
  --overwrite
```

### 4. Referenciar o parâmetro na task definition

Adicionar ao array `secrets` de `infra/task-definition.json` (o `__ACCOUNT_ID__` é substituído
pelo pipeline de deploy):

```json
{"name": "CertificateEncryption__KmsKeyId", "valueFrom": "arn:aws:ssm:sa-east-1:__ACCOUNT_ID__:parameter/renoveja/prod/CertificateEncryption__KmsKeyId"}
```

A policy `renoveja-ecs-ssm` já cobre `parameter/renoveja/*`, então não é preciso mexer nela.

### 5. Deploy e verificação

Depois do deploy, um upload de certificado novo grava no formato v3 com `aws-kms`. Para
confirmar que a CMK está sendo exercitada:

```bash
aws cloudtrail lookup-events \
  --region sa-east-1 \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=alias/renoveja-certificados \
  --max-results 10
```

Cada `Decrypt` no CloudTrail passa a responder "quem abriu o certificado de qual médico e
quando" — informação que, com a chave em variável de ambiente, não existia.

## Como voltar atrás

Remover `CertificateEncryption__KmsKeyId` da task definition. As escritas voltam ao provedor
`config` imediatamente. **Atenção**: certificados já gravados no formato v3 com `aws-kms`
deixam de abrir enquanto o parâmetro estiver ausente — a falha é explícita e diz exatamente
isso. Se o rollback precisar ser definitivo, cada médico afetado deve reenviar o PFX.

## O que continua em aberto

- **Senha do PFX em cofre separado (Secrets Manager)**: separá-la exigiria um segundo
  round-trip autenticado em todo fluxo de assinatura, inclusive no lote (o caminho mais lento),
  e uma migração de dado que não pode falhar pela metade. Com a chave de dados por certificado,
  a senha deixou de estar protegida por um segredo compartilhado por toda a plataforma — que
  era o risco real.
- **A3 em nuvem (VIDaaS/VALID)**: elimina o PFX local por completo. Mudança de produto, não de
  infraestrutura.
