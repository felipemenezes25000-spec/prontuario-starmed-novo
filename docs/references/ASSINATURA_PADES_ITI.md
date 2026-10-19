# Assinatura PAdES e Validação no ITI

Este documento referencia o **Guia de Orientações aos Desenvolvedores** do ITI (validar.iti.gov.br) e descreve como o RenoveJá atende aos requisitos.

---

## Resumo do Guia ITI (por capítulo)

> ⚠️ Os ✅ da tabela abaixo significam **"implementado conforme o Guia"**, e não
> "conferido no validador". Nenhum documento gerado por este código foi
> submetido ao `validar.iti.gov.br` — ver a seção
> [Estado de verificação](#estado-de-verificação). Além disso, hoje
> `infra/icp-brasil/roots/` está vazio, então em produção o trust store carrega
> zero raízes.

| Capítulo | Conteúdo | Status RenoveJá (implementado conforme o Guia) |
|----------|----------|-----------------|
| **I** | Características dos documentos (PDF, OIDs de saúde) | ✅ PDF assinado ICP-Brasil, OIDs configurados |
| **II** | Padrões de assinatura (PAdES ICP-Brasil, DocMDP) | ✅ PAdES, DocMDP P=2 |
| **III** | QR Code (ISO/IEC 18004:2015) | ✅ QR no PDF |
| **IV** | Parâmetros para geração de QR Codes | ✅ `_format`, `_secretCode`, JSON, códigos HTTP |
| **V** | Referências de OID | ✅ 2.16.76.1.12.1.1, 2.16.76.1.12.1.3, CRM/UF |
| **VI** | DocMDP (controle de alterações incrementais) | ✅ P=2 (formulários, templates, novas assinaturas) |

---

## Capítulo IV — Parâmetros para QR Code (detalhado)

### Parâmetros obrigatórios (adicionados pelo VALIDAR)

| Nome | Conteúdo | Descrição |
|------|----------|-----------|
| `_format` | `application/validador-iti+json` | Reservado para o Portal Validar. **Comparação exata (literal)**. |
| `_secretCode` | 0–64 caracteres alfanuméricos | Código informado pelo paciente para acesso à prescrição. |

### Fluxo operacional

1. **URL no QR Code** (sem `_format` nem `_secretCode`):
   - Prescrição: `https://[API]/api/verify/{id}?type=prescricao`
   - Exame: `https://[API]/api/verify/{id}?type=exame`

2. **Requisição montada pelo VALIDAR**:
   ```
   GET https://[API]/api/verify/{id}?type=prescricao&_format=application/validador-iti+json&_secretCode=123456
   ```

3. **Resposta JSON esperada**:
   ```json
   {
     "version": "1.0.0",
     "prescription": {
       "signatureFiles": [
         { "url": "https://[API]/api/verify/{id}/document?code=123456" }
       ]
     }
   }
   ```

4. **Códigos HTTP de erro**:
   - `401` — código secreto incorreto
   - `404` — prescrição não existe

### Nota sobre `type`

Quando a URL possui outros parâmetros, o Guia exige o parâmetro `type` para que o VALIDAR identifique e acrescente `_format` e `_secretCode` corretamente. O backend retorna sempre a chave `prescription` (mesmo para solicitação de exame), conforme exemplificado no Guia.

---

## PAdES

O RenoveJá assina os PDFs de receita digital usando **PAdES** (PDF Advanced Electronic Signatures), conforme ISO 32000-2 e ETSI:

- **Padrão criptográfico**: PKCS#7/CMS (CryptoStandard.CMS no iText7)
- **Algoritmo**: SHA-256
- **Cadeia de certificados**: completa (assinante + intermediários + raiz)
- **DocMDP**: P=2 (CERTIFIED_FORM_FILLING) — evita "Assinatura Indeterminada" no validar.iti.gov.br
- **OIDs ITI**: atributos assinados conforme Guia do ITI (2.16.76.1.12.1.1 prescrição, 2.16.76.1.4.2.2.1 CRM, 2.16.76.1.4.2.2.2 UF)

O código está em `DigitalCertificateService.SignPdfWithBouncyCastle` e usa `ItiHealthOidsSignatureContainer` com `PdfSigner.SignExternalContainer`. O container constrói o CMS via BouncyCastle com os OIDs de documento de saúde exigidos pelo validar.iti.gov.br.

O relatório pode mostrar "Tipo de assinatura: Destacada" — isso refere-se à estrutura interna do PDF; a assinatura permanece **embutida** no documento e é PAdES compatível.

## Política de assinatura: AD-RB e AD-RT

O ITI distingue políticas por **referência**. As duas que interessam aqui:

| Política | Exige carimbo de ACT | Estado no RenoveJá |
|---|---|---|
| **AD-RB** (Referência Básica) | não | **é o que a configuração padrão emite** |
| **AD-RT** (Referência de Tempo) | sim | **suportado pelo código, desligado por padrão** — depende de credencial de ACT configurada no ambiente |

O que o RenoveJá assina hoje é PAdES com certificado ICP-Brasil, cadeia
validada contra o trust store e os OIDs de documento de saúde do Capítulo V.
Sem carimbo de ACT isso é **AD-RB — política ICP-Brasil legítima**, reconhecida
pelo validador oficial. A validade jurídica vem da MP 2.200-2/2001, que a
ancora no certificado, não no carimbo.

O que o carimbo acrescenta, e por que ainda importa: a hora que consta no
documento hoje é o `signingTime`, atributo assinado que reflete o **relógio de
quem assinou**. A ACT substitui isso pela atestação de um terceiro credenciado,
e é ela que mantém a assinatura verificável depois que o certificado do médico
expira ou é revogado.

A ausência é rastreável documento a documento: `medical_documents.signature_path`
preenchido e `timestamp_authority` nulo.

### ACT SERPRO: suportada, desligada

Desde 22/08/2026 o código integra a **ACT SERPRO**, que é credenciada ICP-Brasil
— a resposta dela traz `PKIStatus: granted` com política `2.16.76.1.6.2`, sob o
arco `2.16.76.1`. A integração é RFC 3161 padrão com uma diferença: o gateway
exige `Authorization: Bearer` com token OAuth2 obtido num segundo endpoint, e o
`TSAClientBouncyCastle` do iText só sabe emitir `Basic`. Daí existir
`SerproTsaClient` (`RenoveJa.Infrastructure/Certificates/`).

**A capacidade nasce desligada.** Com `IcpBrasilSignature:TimestampProvider`
vazio — o valor de fábrica em `appsettings.json`, e `appsettings.Production.json`
**não declara a chave**, então produção herda o mesmo vazio — o comportamento é
idêntico ao anterior a esta integração: assina-se AD-RB, `timestamp_authority`
fica nulo e `RequireTimestamp` permanece `false`. Nenhum byte sai para a rede.

Ativar é **ato de ambiente, e consciente**, nunca um default:

| Passo | Onde |
|---|---|
| 1. Criar os dois SecureString no SSM | `/renoveja/prod/IcpBrasilSignature__SerproConsumerKey` e `...__SerproConsumerSecret` (`aws ssm put-parameter --type SecureString`; o `bootstrap-ssm.yml` **não** cria credencial de terceiro, por desenho) |
| 2. Acrescentar os dois em `secrets[]` do task-definition | `infra/task-definition.json` — **depois** do passo 1: `check-ssm-parameters.sh` roda antes do build e reprova o deploy se o parâmetro não existir |
| 3. Ligar o provider | `IcpBrasilSignature__TimestampProvider=serpro` (texto claro, em `environment`) |
| 4. Validar um PDF real no `validar.iti.gov.br` | anexar o relatório antes de anunciar AD-RT |
| 5. Só então considerar `RequireTimestamp=true` | com `true`, qualquer falha da ACT **aborta a emissão** |

A tabela acima é o resumo. O procedimento executável — comandos, o que verificar
depois de cada passo, como reverter cada um e o que fazer com cada categoria de
erro — está em
[`docs/infra/ATIVACAO_CARIMBO_TEMPO_ACT.md`](../../docs/infra/ATIVACAO_CARIMBO_TEMPO_ACT.md).
Não execute a ativação por esta tabela: ela não traz verificação nem reversão.

Enquanto o passo 4 não existir, esta documentação **não afirma AD-RT emitido** —
afirma que o caminho existe no código.

Falha da ACT com `RequireTimestamp=false` não para a emissão: o documento sai
AD-RB, com `LogError` nomeando a causa, e `timestamp_authority` fica nulo. O
sinal de qualificação depende do carimbo que **realmente** entrou no CMS, não da
URL configurada — antes de 22/08/2026 a URL era devolvida antes de qualquer
carimbo acontecer, e a falha era engolida por um `catch` vazio, o que produzia
documento AD-RB gravado como qualificado.

Com `RequireTimestamp=true` o aborto é **pós-condição sobre o resultado**, não
efeito colateral de uma exceção subir: depois de assinar, se o carimbo não entrou
no CMS, `SignPdfWithBouncyCastle` lança `QualifiedSignatureUnavailableException` e
o documento não é emitido — mesmo que o gerador do atributo tenha devolvido
tabela vazia sem lançar nada.

> Não confunda com o caminho degradado. Sem os **OIDs ITI** (só alcançável com
> `RequireQualifiedSignature=false`) o documento realmente não é reconhecido
> pelo validador. Falta de carimbo e falta de OIDs são situações diferentes, e
> até agosto de 2026 o log usava o mesmo texto de aviso para as duas.

---

## ACT SERPRO por dentro

Esta seção é referência de implementação — **como o carimbo funciona**, para quem
for mexer no código depois. O estado operacional continua o da seção acima:
implementado e desligado.

### O que vai na rede

São dois endpoints do mesmo gateway, com autenticação diferente:

| Passo | Requisição | Autenticação | Corpo | Resposta |
|---|---|---|---|---|
| Token | `POST https://gateway.apiserpro.serpro.gov.br/token` | `Basic base64(consumerKey:consumerSecret)` | `grant_type=client_credentials` (`application/x-www-form-urlencoded`) | JSON com `access_token` e `expires_in` |
| Carimbo | `POST https://gateway.apiserpro.serpro.gov.br/apitimestamp/v1/stamps-asn1` | `Bearer <access_token>` | TSQ em **ASN.1 DER binário puro** (`Content-Type: application/timestamp-query`) | TSR em DER binário |

Os endereços de fábrica estão em `IcpBrasilSignatureConfig.SerproTokenUrlPadrao` e
`SerproStampsUrlPadrao`. O par consumer key/secret vira `Basic` **só** no endpoint
de token (`SerproAccessTokenProvider.cs:150-160`); o endpoint de carimbo nunca vê o
segredo, só o token (`SerproTsaClient.cs:175-185`).

Dois detalhes que quebram se forem "simplificados":

- O `Content-Type` do carimbo vai no **conteúdo** (`content.Headers.ContentType`),
  não em `DefaultRequestHeaders` — header de conteúdo posto no cliente lança
  `InvalidOperationException`.
- O mesmo gateway expõe `/stamps` e `/decoded-stamps`, que **não servem**: recebem
  hash e devolvem JSON, e o atributo do CMS precisa do carimbo em ASN.1 DER
  (`IcpBrasilSignatureConfig.cs:58-64`).

### Números medidos em 22/08/2026

Os valores abaixo foram **medidos contra a API real** em 22/08/2026, por uma prova
de vida executada **fora deste repositório**. Não são especificação de fornecedor e
não podem ser reproduzidos por quem lê este documento sem credencial. Onde
divergirem da documentação do provedor, quem manda é a resposta observada.

| Grandeza | Valor medido | Observação |
|---|---|---|
| Tamanho do TSR | 4021 bytes | o token, sem o envelope, é menor |
| Latência do carimbo | 2778 ms | acontece dentro do `Sign()`, segurando a request do médico |
| `expires_in` do token | 2878 s (≈ 48 min de vida) | a documentação do provedor cita 3295 s e "uma hora" |
| Política do carimbo | `2.16.76.1.6.2` | sob o arco ICP-Brasil `2.16.76.1` |
| TSA | `O=ICP-Brasil, OU=Certificado Carimbo de Tempo, CN=SERVIDOR DE CARIMBO DE TEMPO ACT SERPRO 50103` | |
| Folga no espaço reservado | 12363 bytes | `16384 − 4021`; ver `GetTokenSizeEstimate` abaixo |

Três números diferentes para a mesma validade — 2878 medido, 3295 e "uma hora"
documentados — é a razão de o código **ler `expires_in` da resposta** e nunca
chumbar o valor.

### O token OAuth2: por que objeto separado, e por que singleton

`CreateTsaClient()` roda **uma vez por assinatura**: é chamado em
`DigitalCertificateService.cs:754` (caminho qualificado) e `:895` (caminho
degradado), e `DigitalCertificateService` é `Scoped`. Um cache de token guardado
dentro do `SerproTsaClient` seria descartado junto com a receita e renderia um
`POST /token` por documento assinado.

Por isso o cache mora em `SerproAccessTokenProvider`, registrado como **singleton**
(`ServiceCollectionExtensions.cs:236-241`), enquanto o cliente da ACT é construído
com `new` a cada assinatura (`DigitalCertificateService.cs:1087-1096`) — barato,
porque não carrega estado.

O `HttpClient` é **nomeado** `act-serpro` (constante
`SerproAccessTokenProvider.HttpClientName`) e atende aos **dois** endpoints, com
`Timeout` explícito de 20 s (`ServiceCollectionExtensions.cs:230-232`). O timeout
curto é deliberado: `ITSAClient.GetTimeStampToken` é síncrono por imposição da
interface do iText e resolve o `Task` com `GetAwaiter().GetResult()`
(`SerproTsaClient.cs:96-108`), dentro do `Sign()`. Sem `SynchronizationContext`
(ASP.NET Core) isso não deadlocka; o que custa é segurar a thread da request do
médico enquanto a ACT responde. Com o default de 100 s, ACT lenta vira tela travada.

`DigitalCertificateService` recebe o provider como parâmetro **opcional** de
construtor e cria um próprio quando ele não vem (`:52-59` e `:73-76`). Nesse caso o
código funciona; o que se perde é o compartilhamento do token entre requisições —
custo e cota, não correção.

### Renovação serializada, e a folga lida da resposta

O par (token, prazo) vive num `record` imutável `TokenEmCache`, trocado por
referência com `Volatile.Read`/`Volatile.Write`
(`SerproAccessTokenProvider.cs:40-50`). Não são dois campos separados, de propósito:
o caminho rápido roda **fora** do semáforo e, com token e prazo independentes,
podia emparelhar token velho com prazo novo — token vencido dado como válido. Uma
referência só é lida atomicamente, então o par lido é sempre coerente.

A busca roda sob `SemaphoreSlim(1,1)` com dupla checagem (`:72-93`): quem ficou na
fila enquanto o primeiro renovava encontra o token novo ali e **não** dispara um
segundo `POST /token`. `RenewAccessTokenAsync` (`:103-121`) recebe o token que levou
o 401 e o compara com o do cache: se outra assinatura já renovou, devolve o novo sem
tocar a rede.

A folga de renovação é `Math.Clamp(expiresIn / 10, 30, 300)` segundos (`:123-129`) —
10% da validade, piso de 30 s, teto de 5 min:

| `expires_in` | Folga | Efeito |
|---|---|---|
| 2878 s (medido) | ≈ 288 s | token usável por ≈ 2590 s |
| 60 s | 30 s (piso) | |
| 36000 s | 300 s (teto) | |
| ausente, tipo inesperado ou ≤ 0 | — | assume 60 s: melhor pedir token demais do que assinar com um vencido (`:238-253`) |
| menor que a própria folga | — | usa `expiresIn / 2`, em vez de renovar "no passado" (`:202-210`) |

Cuidado ao citar estes números: **2878 s ≈ 48 min é a vida do token**; o intervalo
entre renovações é ≈ 43 min (vida menos folga). Não são a mesma coisa. O clamp é o
que garante que o comportamento não muda se o provedor alterar o `expires_in`.

`HTTP 401` no endpoint de carimbo provoca exatamente **uma** renovação e **uma**
retentativa, nunca um laço (`SerproTsaClient.cs:122-140`). Se o 401 persistir, vira
`CredencialInvalida` — não é expiração: credencial inválida, revogada, ou contrato
que não cobre o serviço de carimbo. Um laço aqui multiplicaria 401 contra o gateway
dentro do `Sign()`.

### O TSQ: `certReq` sim, `reqPolicy` não

`MontarTsq` (`SerproTsaClient.cs:147-168`) gera o pedido com SHA-256,
`SetCertReq(true)` — para o carimbo vir com o certificado da ACT embutido, sem o que
a validação passa a depender de achar a cadeia da ACT anos depois — e nonce
aleatório de 16 bytes, que amarra a resposta a este pedido e impede replay de um
carimbo antigo.

**Não** vai `reqPolicy`, e isso é decisão, não esquecimento: fixar a política no
pedido faria `TimeStampResponse.Validate` lançar caso a ACT respondesse com outra, e
a recusa chegaria como exceção de parsing em vez de mensagem útil. A política é
**conferida na resposta** (`:297-306`), contra o arco `2.16.76.1` (constante
`ArcoIcpBrasil`): aceita-se a política igual ao arco ou começando com `2.16.76.1.`,
comparação `Ordinal`.

Conferir por **política**, e não por nome de host ou de emissor, é a lição do
`IcpBrasilTrustStore`, onde comparar substring de nome deixava passar um emissor
chamado `INVALID TEST CA` por conter `VALID`. Um carimbo de TSA não credenciada
faria o documento **parecer** qualificado sem ser — por isso é recusado como
`RespostaInvalida` mesmo com `HTTP 200` e `PKIStatus` de concessão.

O cliente devolve o **token** (`token.GetEncoded()`, o `ContentInfo` do carimbo), e
não o envelope `TimeStampResp` (`:312-313`). Quem consome é
`TsaUnsignedAttributeGenerator`, que faz `Asn1Object.FromByteArray` e põe o
resultado direto no atributo `id-aa-signatureTimeStampToken` (OID
`1.2.840.113549.1.9.16.2.14`, `ItiHealthOidsSignatureContainer.cs:258-261`);
devolver o envelope produziria um atributo com a estrutura errada — um blob que
nenhum validador lê.

### `GetTokenSizeEstimate() = 16384`, e por que ele está dormente

`SerproTsaClient.TamanhoEstimadoDoCarimbo` é 16384 bytes: **quatro vezes** o TSR de
4021 bytes medido ao vivo (16384 / 4021 ≈ 4,07), com espaço para a cadeia da ACT
crescer numa renovação de certificado. O default do próprio iText
(`TSAClientBouncyCastle.DEFAULTTOKENSIZE`) é 10240.

O argumento é a assimetria do erro: errar para mais custa alguns KB reservados no
PDF; errar para menos é `IOException "Not enough space"` com o documento já
*pre-closed*.

**Hoje nenhum ponto deste repositório consulta esse número.** Os dois pontos de
assinatura passam `estimatedSize` explícito de 4 MB
(`DigitalCertificateService.cs:771` e `:916`), e o iText 8 só chama
`GetTokenSizeEstimate()` quando o chamador passa `0`. O valor existe para o dia em
que alguém trocar aquele `4194304` por `0` — ele **não** é "o espaço que o carimbo
ocupa".

### As quatro categorias de falha

`SerproTimestampFailure` (`SerproTimestampException.cs:17-45`) existe porque os
consertos são diferentes e quem lê a mensagem é o operador. Um único "falha ao
carimbar" obrigaria a abrir log de rede para descobrir em qual dos quatro mundos ele
está.

| Categoria | Significa | Disparada por | O que o operador faz |
|---|---|---|---|
| `CredencialInvalida` | o segredo está errado | credencial ausente/branca; `/token` com 401, 403 ou 400; carimbo com 403; carimbo com 401 que **persiste** depois de uma renovação | corrigir o segredo no SSM — repetir não adianta |
| `AutoridadeIndisponivel` | é do lado deles | `HttpRequestException`/`TaskCanceledException` (rede, DNS, timeout) nos dois endpoints; `/token` com qualquer outro status não-2xx; carimbo com HTTP ≥ 500, 429 ou 408 | repetir mais tarde ou abrir chamado; nada a corrigir aqui |
| `RequisicaoRecusada` | o defeito está no TSQ que **nós** montamos | imprint vazio; carimbo com 4xx que não seja 401/403/408/429; `HTTP 200` com `PKIStatus` fora de `granted`/`grantedWithMods` (a mensagem carrega `PKIStatus`, `failInfo` e `statusString`) | corrigir o pedido — repetir produz a mesma recusa |
| `RespostaInvalida` | veio algo que não é carimbo utilizável | `HTTP 200` com corpo vazio; TSR que não parseia ou cujo `Validate` falha (DER corrompido, nonce divergente); concessão sem carimbo anexado; política fora do arco `2.16.76.1`; `/token` com 200 sem `access_token`, ou com corpo que não é JSON | conferir endpoint e contrato |

`429` e `408` são classificados como **indisponibilidade**, e não como recusa do
pedido, de propósito (`SerproTsaClient.cs:228-239`): são 4xx que dizem "agora não",
não "o pedido está errado". Mandar o operador depurar o TSQ seria mandá-lo para o
lugar errado — e assinatura em lote é justamente o que produz throttling de gateway.
A mensagem sugere reduzir a concorrência do lote.

### Matriz de comportamento

Derivada de `CreateTsaClient`/`CreateProviderTsaClient`
(`DigitalCertificateService.cs:995-1108`) e da pós-condição de assinatura
(`:776-817`):

| `TimestampProvider` | Credencial | `RequireTimestamp` | O que acontece |
|---|---|---|---|
| vazio (fábrica) | nunca é lida | `false` | Caminho legado. Com `TimestampAuthorityUrl` também vazia: `LogWarning`, retorno `(null, null)`, documento AD-RB, `timestamp_authority` NULL, `IsQualified = false`. Zero bytes na rede |
| vazio | nunca é lida | `true` | Com `TimestampAuthorityUrl` vazia: `QualifiedSignatureUnavailableException` — o documento **não** é assinado. Credencial SERPRO no SSM não salva: sem provider ela nem é consultada |
| `serpro` | ausente (qualquer uma das duas vazia) | `false` | `LogWarning` nomeando as duas variáveis, retorno `(null, null)`, assina AD-RB, `timestamp_authority` NULL. Nenhuma chamada de rede |
| `serpro` | ausente | `true` | `QualifiedSignatureUnavailableException` **antes** de qualquer I/O |
| `serpro` | presente | `false` | Carimbo OK → atributo no CMS, `TimestampApplied = true`, `timestamp_authority` = URL efetiva, `IsQualified = true` (AD-RT). Carimbo falha → registrada em `TimestampFailure`, a assinatura **conclui**, `LogError`, `timestamp_authority` NULL, AD-RB |
| `serpro` | presente | `true` | Carimbo OK → igual acima. Carimbo falha → aborta por dois caminhos independentes: a exceção sobe do gerador e vira `QualifiedSignatureUnavailableException` no `catch`; e, se `SignExternalContainer` terminar com êxito sem carimbo, a pós-condição sobre `TimestampApplied` aborta assim mesmo |
| valor desconhecido (ex.: `digicert`) | — | `false` | `LogError` ("valores aceitos: vazio ou `serpro`"), retorno `(null, null)`. Nunca cai em outra ACT |
| valor desconhecido | — | `true` | `QualifiedSignatureUnavailableException` |

**`TimestampProvider` tem precedência sobre `TimestampAuthorityUrl`.** Com o
provider preenchido, `CreateTsaClient` desvia para `CreateProviderTsaClient`
(`:997-999`) e a URL legada **não é lida em momento nenhum**. Os dois caminhos usam
a mesma palavra para coisas diferentes: no legado, "configurado" quer dizer URL
preenchida; no provider, quer dizer **credencial** presente. Quem ligar o provider e
deixar a URL antiga preenchida vai supor que ela ainda vale — e ela não vale.

### Chaves de configuração

| Chave (`IcpBrasilSignature:`) | Variável de ambiente | Padrão | Declarada em `appsettings.json`? |
|---|---|---|---|
| `TimestampProvider` | `IcpBrasilSignature__TimestampProvider` | vazio (= nenhuma ACT) | sim, vazia |
| `SerproConsumerKey` | `IcpBrasilSignature__SerproConsumerKey` | vazio | sim, vazia |
| `SerproConsumerSecret` | `IcpBrasilSignature__SerproConsumerSecret` | vazio | sim, vazia |
| `SerproTokenUrl` | `IcpBrasilSignature__SerproTokenUrl` | `SerproTokenUrlPadrao` | não — só por override |
| `SerproStampsUrl` | `IcpBrasilSignature__SerproStampsUrl` | `SerproStampsUrlPadrao` | não — só por override |

Definições em `IcpBrasilSignatureConfig.cs:79,90,96,102,108`; binding em
`ServiceCollectionExtensions.cs:494-516`. O `if (!string.IsNullOrWhiteSpace(...))`
de cada uma **não é decorativo**: `EnvOrConfig` devolve string vazia quando não acha,
e atribuir direto apagaria o valor vindo do `appsettings`. É por isso que declarar a
variável vazia no ECS não "desliga" nada — o valor de fábrica sobrevive.

Errar um caractere no nome não produz erro: silenciosamente mantém o carimbo
desligado.

### Cobertura de testes

`backend-dotnet/tests/RenoveJa.UnitTests/Security/SerproCarimboDoTempoTests.cs` tem
**22 métodos** de teste, que rendem **27 casos** executados — 19 `[Fact]` e 3
`[Theory]` com 8 `[InlineData]` no total. A mensagem do commit `5dac20c4` diz "23
testes novos"; não bate com nenhuma das duas contagens, use 22/27.

O que cada bloco trava: cache do token (2 carimbos → 1 `POST /token`; 8 chamadas
paralelas com cache frio → 1 refresh); renovação (relógio injetado, e folga
proporcional com piso e teto — 2878→287, 60→30, 36000→300); 401 (uma renovação e uma
retentativa; 401 persistente vira erro de credencial em exatamente 2 tentativas);
contrato de rede (`Bearer` no carimbo, `Basic` só no token, `Content-Type`, corpo
parseável como `TimeStampRequest`, imprint idêntico, SHA-256, `certReq`, nonce; e
"devolve o token, não o envelope"); classificação de erro (credencial recusada no
token, 503, `PKIStatus` de recusa com HTTP 200, política DigiCert
`2.16.840.1.114412.7.1` recusada, 429/408 como indisponibilidade); nasce desligado
(5 testes, entre eles "configuração de fábrica não cria cliente de ACT e não toca a
rede" e "provider desconhecido não inventa ACT"); valores (estimativa de tamanho e
digest SHA-256); e os dois do buraco 1, mais abaixo.

Nenhum teste toca a ACT real. Todos passam por um `HttpMessageHandler` falso que
guarda o corpo em **bytes** — ler como UTF-8 corromperia o DER —, vários usam um
handler que **lança se for chamado**, o que transforma "não chamou" em asserção e
não em esperança, e há uma ACT falsa que emite TSR real assinado. As credenciais são
sintéticas porque o portão de pre-push roda `gitleaks` também sobre os testes.
`CreateTsaClient`, que é privado, é exercido por reflexão.

### Como exercer contra a ACT real de novo

Nenhum teste deste repositório fala com a ACT, por desenho: teste que depende de
credencial de terceiro e da disponibilidade de um gateway não é teste, é alarme
intermitente. A consequência é que **a suíte verde não prova que a ACT responde** —
os números da seção anterior vieram de uma prova de vida feita **fora** do
repositório em 22/08/2026, num projeto descartável que foi apagado junto com as
credenciais. Não há como reproduzi-la clicando aqui.

Para refazer essa prova de vida (é o que você quer antes de mexer no TSQ, no
parsing do TSR ou na renovação do token):

1. **Não crie arquivo com as credenciais dentro do repositório.** Nem `.env` "só
   por um minuto": `backend-dotnet/.env` está no `.gitignore`
   (`backend-dotnet/.gitignore:144`), mas o portão de pre-push roda `gitleaks` e a
   regra que vale é a de cima — nome de variável e placeholder, nunca valor. Os
   nomes e os placeholders estão em `backend-dotnet/.env.example:149-167`.
2. **O caminho barato é exercer o cliente direto**, não assinar de ponta a ponta:
   um projeto console fora deste repositório que instancie `SerproAccessTokenProvider`
   e `SerproTsaClient` com um `HttpClient` de `Timeout` explícito, chame
   `GetTimeStampToken` sobre um SHA-256 qualquer e imprima tamanho, política e
   `genTime`. Assinar de ponta a ponta na máquina local esbarra antes no cadastro do
   certificado do médico — com `infra/icp-brasil/roots/` vazio, `ValidatePfxAsync`
   falha fechada e o gate não se vence pela interface.
3. **O que conferir na resposta**, porque é o que muda se o provedor mexer no
   serviço: a política sob o arco `2.16.76.1`; o imprint do TSR igual ao digest que
   você mandou; `expires_in` do token (se ele mudar, a folga muda sozinha — o clamp
   existe para isso); e o tamanho do TSR contra os 4021 bytes de 22/08/2026.
4. **Apague o projeto e as credenciais em seguida**, e registre os números medidos
   com a data aqui nesta seção — os anteriores não deixam de valer, viram histórico.

Ligar a ACT **em produção** é outro assunto e tem procedimento próprio, com ordem,
verificação e reversão:
[`docs/infra/ATIVACAO_CARIMBO_TEMPO_ACT.md`](../../docs/infra/ATIVACAO_CARIMBO_TEMPO_ACT.md).

### Se um dia entrar uma segunda ACT

`TimestampProvider` é seletor justamente para isso, e o desenho já separa as duas
metades: quem obtém credencial (`SerproAccessTokenProvider`) e quem fala RFC 3161
(`SerproTsaClient`). Uma segunda ACT credenciada entra como **valor novo** do
seletor e um `ITSAClient` próprio. Hoje `CreateProviderTsaClient` não é um `switch`:
é uma comparação única contra `IcpBrasilSignatureConfig.ProviderSerpro`, e tudo que
não for ela cai no ramo de "valor que o código não conhece"
(`DigitalCertificateService.cs:1054-1070`). Trocar essa comparação por um `switch` é
parte do trabalho — e o ramo do desconhecido tem de continuar existindo, com o mesmo
comportamento: erro, nunca fallback.

Três coisas que **não** mudam, e que não devem ser reescritas junto:

- **A conferência da política na resposta, contra o arco `2.16.76.1`.** Ela não é
  específica da SERPRO; é o que impede qualquer ACT não credenciada de fazer o
  documento parecer qualificado. ACT nova reaproveita a mesma regra.
- **A ausência de `reqPolicy` no TSQ.** Vale para qualquer ACT: divergência de
  política tem de voltar como mensagem, não como erro de parsing.
- **As quatro categorias de `SerproTimestampFailure`.** Se a segunda ACT trouxer o
  próprio vocabulário de erro, quem lê o log — o operador — passa a ter dois
  dicionários. O tipo tem nome de fornecedor por ser o primeiro; a taxonomia é que é
  geral.

O que **não** existe hoje e você vai precisar decidir: não há fallback entre ACTs, e
isso é deliberado — a ACT é contratual, e cair de uma para outra sem contrato é pior
que não carimbar. Se o requisito virar "tolerar ACT fora do ar", o lugar da decisão é
um ADR novo, não um `try/catch` no seletor.

---

## A cadeia da qualificação em `medical_documents`

Três colunas de `public.medical_documents` são a **única evidência por documento** de
que a plataforma tem — ou não tem — valor de assinatura qualificada:

| Coluna | Tipo | O que guarda |
|---|---|---|
| `signature_path` | `TEXT` | nome do enum `SignaturePath`: `PadesItiOids` (o único qualificado), `DetachedCertified`, `DetachedPlain`, `DetachedWithoutRevocation`. NULL = anterior a 17/08/2026 |
| `timestamp_authority` | `TEXT` | **URL do endpoint** da ACT efetivamente chamado — não o nome da ACT. NULL = documento emitido sem carimbo |
| `signature_is_qualified` | `BOOLEAN` | `true` só quando `signature_path = PadesItiOids` **e** `timestamp_authority IS NOT NULL` |

A regra executável de `signature_is_qualified` é a propriedade derivada
`DigitalSignatureResult.IsQualified` (`IDigitalCertificateService.cs:68-71`) — nunca
é recalculada camada abaixo. E `timestamp_authority`, **no caminho
qualificado**, só é preenchida quando o carimbo realmente entrou no CMS
(`DigitalCertificateService.cs:777-780`), nunca a partir da URL de configuração — no
caminho degradado essa garantia não vale; ver a ressalva ao final deste documento.

Colunas, comentários e índice nascem em `MigrationRunner.cs:1829-1850` (grupo
`signature_path`, registrado em `:3083`), espelhados em
`infra/migrations/20260817_signature_path.sql` e — desde 22/08/2026 — em
`infra/schema.sql:530-532` e `:550`. Divergência residual conhecida: o `COMMENT` de
`signature_is_qualified` existe no SQL manual (`:32-33`) e **não** no
`MigrationRunner`, que comenta apenas as duas primeiras colunas.

### Quem escreve

São três escritores, com caminhos de persistência diferentes:

| Fluxo | Como grava | Onde |
|---|---|---|
| Renovação e exame | **INSERT único** de documento já assinado, via `CreateAsync` | `SignedRequestClinicalSyncService.cs:245` (receita) e `:264` (exame) |
| Pós-teleconsulta | **UPDATE** posterior, via `SetSignedDocumentAsync` | `PostConsultationService.cs:759-766` (receita), `:820-827` (exame), `:877-884` (atestado), `:931-938` (encaminhamento) |
| Backfill administrativo | passa os três **explicitamente nulos** | `AdminClinicalBackfillController.cs:95-121` |

A assimetria INSERT × UPDATE é a razão de os três parâmetros existirem em **dois**
métodos do repositório — `CreateAsync` (`MedicalDocumentRepository.cs:72-80`) e
`SetSignedDocumentAsync` (`:314-346`). O pós-teleconsulta já gravava desde
17/08/2026 porque `SetSignedDocumentAsync` escapa do `MedicalDocumentModel` usando
objeto anônimo; o INSERT não escapa, e era aí que a informação morria.

O backfill grava nulo porque a tabela `requests` nunca guardou esses dados —
`TrySignAsync` leva só url, id e data (`SignatureService.cs:382-387`). Não é
descuido: é exatamente o que o sistema sabe sobre aquelas linhas.

Duas coisas que **não** são um quarto caminho:

- **Assinatura em lote** delega para `SignatureService.SignAsync`
  (`BatchSignatureService.cs:822`) e herda a propagação sem código próprio.
- **Rascunhos** de `ClinicalRecordService` (`:157`, `:185`, `:209`) chamam
  `CreateAsync` sem os três argumentos, de propósito: são documentos ainda não
  assinados, e qualificação desconhecida (NULL) é o registro correto. Não "conserte"
  isso enfiando `false`.

### O caminho completo

Nove saltos, atravessando quatro contratos. A informação morre em qualquer um deles
sem quebrar compilação — foi exatamente o que aconteceu entre 17 e 22/08/2026:

| # | Onde | O que acontece |
|---|---|---|
| 1 | `DigitalCertificateService.cs:817` | `SignedPdf(bytes, SignaturePath.PadesItiOids, tsaUrlEfetiva)` |
| 2 | `IDigitalCertificateService.cs:52-72` | `DigitalSignatureResult` expõe `SigningPath` e `TimestampAuthority`, e deriva `IsQualified` |
| 3 | `SignatureService.cs:462`, `:482-484` | chama `SyncSignedRequestAsync` com `SigningPath?.ToString()`, `TimestampAuthority`, `IsQualified` |
| 4 | `ISignedRequestClinicalSyncService.cs:61-72` | contrato; os três parâmetros (`:69-71`) têm **padrão nulo** |
| 5 | `SignedRequestClinicalSyncService.cs:245-253` e `:264-272` | repassa nos dois ramos (receita e exame) |
| 6 | `IMedicalDocumentRepository.cs:31-39` | contrato do Domain; os três primitivos em `:37-39` |
| 7 | `MedicalDocumentRepository.cs:95-97` | atribui ao modelo de persistência |
| 8 | `PersistenceModels.cs:540-545` | `[JsonPropertyName]` explícito para as três colunas |
| 9 | `PostgresClient.cs:57-62` | serializa o modelo — e **as chaves do JSON são as colunas do INSERT** |

O salto 9 explica por que o defeito era invisível: **não existe SQL literal** do
INSERT. Propriedade ausente do modelo não vira coluna; nada compila errado, nada
retorna 500, a coluna simplesmente nasce NULL. E o nome da coluna vem da
serialização, cuja política padrão é `SnakeCaseLower` — uma propriedade `IsQualified`
viraria `is_qualified`, coluna inexistente, erro só em runtime, e o `catch` geral do
sync clínico transformaria isso em log, não em HTTP 500. Daí os `[JsonPropertyName]`
explícitos.

Regra para coluna nova de `medical_documents`: **se não está em
`MedicalDocumentModel`, ela não existe para o INSERT.**

Os três viajam como **primitivos, por fora do `SignatureInfo`**. Levar a qualificação
para dentro do value object exigiria o enum `SignaturePath` no Domain, e os testes de
arquitetura reprovam a dependência Domain → Application — por isso o enum vira
`string` no salto 3.

### Quem lê

| Leitor | O que faz |
|---|---|
| `idx_medical_documents_unqualified_signature` | índice parcial: `ON public.medical_documents(signed_at DESC) WHERE signed_at IS NOT NULL AND signature_is_qualified IS NOT TRUE` |

E só. **Nenhum código .NET lê as três colunas.** O `grep` em `backend-dotnet/src`
devolve apenas escrita — modelo, repositório, migrations — e comentários: não há
endpoint, DTO, relatório, export nem indicador que as consulte. O único consumidor é
o índice acima, por consulta SQL rodada a mão quando o órgão de controle pergunta.

Isso não deve ser suavizado em texto institucional: o dado existe e está correto; a
**superfície de leitura não existe**. Dizer que "o painel lista os documentos não
qualificados" seria afirmar controle inexistente.

O que o módulo de fiscalização (`PublicSectorAuditRepository`,
`StateOversightRepository`, `PublicSectorDossierService`) de fato lê é **outra**
coluna da mesma tabela: `signature_is_valid`. As duas não são sinônimas —
`signature_is_valid` diz que a assinatura criptográfica confere;
`signature_is_qualified` diz se ela tem valor ICP-Brasil. Divergem sempre que a
assinatura sai por caminho degradado.

### NULL não é `false`

`NULL IS NOT TRUE` é verdadeiro, então **para o índice dá no mesmo**: as duas formas
aparecem na lista de não-qualificados, que é o lado seguro. A distinção é de
significado:

- **NULL = "não sabemos"** — linha anterior a 17/08/2026, ou backfill sem o resultado
  da assinatura em mãos.
- **`false` = "sabemos que não é qualificada"** — houve assinatura, e ela não produziu
  AD-RT.

A distinção muda comportamento observável em dois lugares:

- No **INSERT**, os três são atribuídos direto
  (`MedicalDocumentRepository.cs:95-97`), sem o `if (!string.IsNullOrEmpty(...))` que
  protege `signedDocumentUrl` e `signatureId` em `:85-88`. Consequência: `false`
  **entra** no comando e é gravado; `null` é omitido pelo serializador
  (`JsonIgnoreCondition.WhenWritingNull`).
- No **UPDATE**, `UpdateAsync` reescreve a linha inteira a partir de `MapToModel`
  (`:189-212`), que **não conhece** as três colunas. Com `bool?`/`string?` nulos, o
  mesmo `WhenWritingNull` os omite do SET e o valor já gravado sobrevive. Um `bool`
  não-anulável mandaria `false` no update e apagaria um `true` legítimo — o tipo é
  anulável por isso, não por elegância.

> Ressalva de honestidade: `UpdateAsync` tem hoje **um único chamador** —
> `ClinicalRecordService.cs:246`, dentro de `SignDocumentAsync` (`:221`) — e esse
> método não é invocado por nenhum controller. A proteção vale para um caminho que
> existe no código e não está exposto: o risco é latente, não ativo.

O padrão nulo dos parâmetros existe para que **esquecer de propagar produza o lado
seguro**, nunca o otimista.

### Por que não houve backfill de NULL para `false`

Porque as migrations do `MigrationRunner` rodam **a todo boot** e não há mecanismo de
"pular se já aplicada" por linha de dado. Um `UPDATE ... SET signature_is_qualified =
false WHERE signature_is_qualified IS NULL`, sem corte temporal, achataria para
sempre a distinção entre "não sabemos" e "sabemos que não é" — com ganho de consulta
**zero**, já que as duas formas já entram no índice.

Se alguém propuser esse backfill como limpeza óbvia, é isto que se perde.

---

## Dois buracos fechados em 22/08/2026 — invariantes a não reintroduzir

Os defeitos abaixo já estão corrigidos. Ficam registrados porque são fáceis de
reintroduzir sem perceber, e os dois produziam o mesmo resultado: documento **sem**
carimbo gravado como **qualificado**.

### 1. `RequireTimestamp=true` tinha porta de saída silenciosa

`TsaUnsignedAttributeGenerator` devolvia `AttributeTable` vazio quando o CMS não
entregava o parâmetro `CmsAttributeTableParameter.Signature` — sem consultar a flag e
sem lançar; a ACT sequer chegava a ser chamada. Como todo o enforcement dependia da
exceção **subir de dentro do gerador**, por essa porta o PDF era emitido com "carimbo
obrigatório" ligado, carimbo nenhum, e a assinatura terminava com êxito. Quem tivesse
ligado a flag confiando nela **não estaria protegido**.

Hoje o gerador recebe `required`, registra `Failure` e expõe `Applied`
(`ItiHealthOidsSignatureContainer.cs:216-231`, `:236-245`, `:250-256`, `:264-270`;
superfície no container em `:96-98`, `:111` e `:114`). O `catch` também deixou de ser
vazio: grava `Failure` e relança se `required`.

**Invariante:** todo ramo que devolve tabela vazia tem de registrar `Failure` e, com
`required`, lançar. Ramo novo que saia em silêncio reabre o buraco. Dois testes
travam isso (`CarimboObrigatorioAbortaMesmoQuandoOCmsNaoEntregaAAssinatura` e
`CarimboOpcionalSemAssinaturaDoCmsNaoQuebraMasFicaRegistrado`).

### 2. O enforcement media configuração, não realidade

`timestamp_authority` recebia a URL vinda do `appsettings` **antes de qualquer
carimbo existir**. Bastava a URL estar preenchida para um AD-RB ser gravado como
qualificado.

Hoje há pós-condição sobre o que de fato entrou no CMS
(`DigitalCertificateService.cs:776-817`):

```csharp
var carimbouDeFato = tsaClient == null || container.TimestampApplied;
var tsaUrlEfetiva  = container.TimestampApplied ? tsaUrl : null;
```

Se não carimbou e `RequireTimestamp=true`, lança
`QualifiedSignatureUnavailableException` — com a falha original como `inner` quando
existe — e o documento **não** é emitido. Se não carimbou e `RequireTimestamp=false`,
`LogError` explícito e o documento sai AD-RB com `timestamp_authority` nulo.

**Invariante:** o sinal de qualificação depende de `container.TimestampApplied`,
nunca de `_icpConfig`. Qualquer atalho que volte a devolver `tsaUrl` direto
reintroduz o defeito.

### 3. O `catch` geral precisa continuar filtrando o aborto

O `catch` do caminho qualificado é
`catch (Exception ex) when (ex is not QualifiedSignatureUnavailableException)`
(`DigitalCertificateService.cs:823`). Sem o filtro, o aborto lançado logo acima —
**dentro do mesmo `try`** — seria capturado abaixo e, com
`RequireQualifiedSignature=false`, degradaria para `SignDetached`, reabrindo o buraco
pelo outro lado. Todos os caminhos de fallback produzem AD-RB.

Dentro do `catch` há ainda um segundo portão (`:834-843`): se `RequireTimestamp` e
`container.TimestampFailure != null`, aborta antes de qualquer degradação.

**Invariante:** remover o filtro do `catch`, ou mover o `throw` para fora do `try`,
transforma "aborta a emissão" em "degrada em silêncio".

### Ressalva: o caminho degradado ainda grava a URL configurada

`SignPdfDetachedFallback` chama `CreateTsaClient()` de novo (`:895`) e devolve
`SignedPdf(..., degradedPath, tsaUrl)` (`:922`) com a URL **configurada**, sem
pós-condição sobre carimbo aplicado. Ele só é alcançável com
`RequireQualifiedSignature=false`.

Isso **não** infla `signature_is_qualified` — `IsQualified` exige
`SigningPath == PadesItiOids` —, mas grava `timestamp_authority` com uma URL que pode
não corresponder a carimbo nenhum. Ou seja: "o sinal depende do carimbo real" é
verdade no caminho qualificado e **não** é verdade para a coluna
`timestamp_authority` no caminho degradado.

---

## Trust store das raízes ICP-Brasil

A validação de cadeia lê `IcpBrasilSignature:TrustStorePath`. Em produção o
caminho é `/etc/icp-brasil/roots`, populado a partir de
`infra/icp-brasil/roots/` pela imagem Docker.

Com o diretório vazio, `IcpBrasilTrustStore` carrega zero raízes, devolve
`TrustStoreNotConfigured` e o **cadastro de certificado do médico falha** —
`ValidatePfxAsync` é bloqueante nesse ponto. A assinatura de certificados já
cadastrados não consulta o trust store, então o sintoma aparece no onboarding,
não na emissão.

Procedimento para popular e verificar por thumbprint:
`infra/icp-brasil/roots/README.md`.

## Estado de verificação

Não há, neste repositório, relatório de um documento real submetido ao
`validar.iti.gov.br`. A conformidade descrita acima é **conforme o Guia**, não
conferida contra o validador. Um relatório do validador oficial é evidência de
terceiro e vale mais que qualquer trecho de código; enquanto ele não existir,
esta seção fica aqui como lacuna declarada.

## Integração com validar.iti.gov.br

1. **QR Code na receita**  
   O PDF contém um QR Code que aponta para o endpoint da API (`Verification:BaseUrl`).  
   Ex.: `https://api.renovejasaude.com.br/api/verify/{requestId}`  
   O texto impresso no PDF mostra a URL amigável do frontend (`Verification:FrontendUrl`).

2. **Configuração**  
   Defina em `appsettings.json` ou variáveis de ambiente:

   ```json
   "Verification": {
     "BaseUrl": "https://sua-api.com/api/verify",
     "FrontendUrl": "https://renovejasaude.com.br/verify"
   },
   "Api": {
     "BaseUrl": "https://sua-api.com"
   }
   ```

   - `Verification.BaseUrl` → endpoint da API (codificado no QR Code). Deve estar acessível publicamente (HTTPS).
   - `Verification.FrontendUrl` → URL do frontend de verificação (usada no texto do PDF e para redirect de browsers).
   - `Api.BaseUrl` → domínio da API para montar a URL do PDF retornada ao ITI (`{Api.BaseUrl}/api/verify/{id}/document?code=XXX`).

3. **Fluxo do QR Code**  
   - **Validador ITI**: chama `GET {BaseUrl}/{requestId}?_format=application/validador-iti+json&_secretCode={código}` → API retorna JSON com URL do PDF → ITI baixa e valida.
   - **Browser normal** (farmacêutico): abre o QR → API detecta que não há `_format` → redireciona para `{FrontendUrl}/{requestId}`.

4. **Código de acesso**  
   O `_secretCode` corresponde ao código de 6 dígitos exibido na receita.

## Capítulo V — OIDs utilizados

### Documentos digitais em saúde

| OID | Descrição |
|-----|-----------|
| 2.16.76.1.12.1.1 | Prescrição de medicamento |
| 2.16.76.1.12.1.3 | Solicitação de exame |

### Profissionais (médicos)

| OID | Descrição |
|-----|-----------|
| 2.16.76.1.4.2.2.1 | Número de registro (CRM) |
| 2.16.76.1.4.2.2.2 | UF de registro |

O `ItiHealthOidsSignatureContainer` aplica o OID correto conforme o tipo de documento (prescrição vs exame).

---

## Checklist de homologação

Antes de submeter ao VALIDAR:

- [ ] `Api__BaseUrl` configurado em produção (URL estável para `signatureFiles[0].url`)
- [ ] `Verification__BaseUrl` = `{Api__BaseUrl}/api/verify`
- [ ] QR Code **sem** `_format` e `_secretCode` embutidos
- [ ] QR Code com `type=prescricao` ou `type=exame` conforme o documento
- [ ] Teste: `curl -i "https://HOST/api/verify/{id}?type=prescricao&_format=application/validador-iti+json&_secretCode=CODE"` → 200 + JSON
- [ ] Teste: `curl -I "https://HOST/api/verify/{id}/document?code=CODE"` → 200 + `Content-Type: application/pdf`
- [ ] Teste código errado → 401
- [ ] Teste id inexistente → 404

---

## Resumo da validação

No Relatório de Conformidade do ITI, valores esperados para receitas assinadas corretamente:

- **Status de assinatura**: Aprovado
- **Estrutura**: Em conformidade com o padrão
- **Resumo criptográfico**: true
- **Caminho de certificação**: Valid
