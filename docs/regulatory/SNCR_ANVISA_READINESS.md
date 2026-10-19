# SNCR / Anvisa — implementação do RenoveJá Public Service

**Atualização:** 30/08/2026  
**Referências operacionais:** RDC Anvisa nº 1.000/2025, RDC nº 1.028/2026, **Manual API SNCR 2ª edição** e o OpenAPI publicado pela própria API em `/v3/api-docs` (`sncr-api` 1.2.0-SNAPSHOT), lido em 30/08/2026.

> **Quando as duas fontes oficiais discordam, vale o OpenAPI.** O manual em PDF descreve o
> campo de resposta da notificação de receita como `numeroReceita` (string); o OpenAPI declara
> `numeracoesReceita` (array de strings), e é isso que a API entrega. Implementar pelo PDF
> descartaria numeração já debitada da cota do prescritor. O cliente aceita os dois nomes de
> propósito — ver `SncrNumberingClient`.

## Regra de segurança que não pode ser removida

A integração de autenticação do prescritor está implementada, mas **conectar Gov.br/SNCR não é a mesma coisa que autorizar emissão eletrônica de receituário controlado**.

Enquanto a operação oficial, a numeração e o modelo regulatório não estiverem liberados/homologados para produção, o RenoveJá mantém `SncrElectronicPrescriptionGate` em modo **fail-closed**. O sistema não gera PDF que apenas imite o modelo oficial.

## O que está implementado

### Backend

Controller: `backend-dotnet/src/RenoveJa.Api/Controllers/SncrController.cs`

Endpoints:

- `GET /api/sncr/status`
  - retorna status de conexão do médico autenticado;
  - informa CRM/UF usados no fluxo;
  - nunca retorna o token SNCR;
  - diferencia conexão de emissão regulatória.

- `POST /api/sncr/connect/start`
  - aceita `channel=web|mobile`;
  - exige médico autenticado;
  - cria `state` aleatório de 256 bits;
  - grava o state no Redis por 10 minutos;
  - fora de `localhost`, devolve `https://<api>/api/sncr/go?state=...` (ver "Retorno pela raiz"
    abaixo); em `localhost`, devolve direto `/api/v1/auth/login?client_url=<callback>?state=...`.

- `GET /api/sncr/go?state=...` (desde 19/09/2026)
  - público: é a primeira parada do navegador do médico;
  - confere que o state tem o formato certo e existe no Redis, sem consumir;
  - grava o state no cookie `__Host-rj-sncr-state` (HttpOnly, Secure, SameSite=Lax, 10 min);
  - redireciona sempre para o SNCR configurado, com `client_url` = origem pura da API.

- `GET /?session_id=...` — retorno pela raiz (desde 19/09/2026)
  - público pelo mesmo motivo do callback; sem `session_id` responde 404;
  - lê e apaga o cookie, e segue exatamente o caminho do callback abaixo.

- `GET /api/sncr/callback` (usado em `localhost`)
  - é público apenas porque recebe o navegador que volta do SNCR/Gov.br;
  - a identidade é resolvida pelo `state` de uso único armazenado no servidor;
  - consome o state antes da troca do `session_id`;
  - chama `/api/v1/auth/token?session_id=...`;
  - guarda `access_token` somente no Redis, com TTL derivado de `exp` do JWT quando disponível;
  - nunca grava o token no browser, localStorage ou AsyncStorage;
  - redireciona de volta ao portal web ou ao deep link do app.

- `POST /api/sncr/disconnect`
  - remove token e metadados temporários do Redis;
  - registra evento de auditoria.

#### Numeração (implementada em 30/08/2026)

- `POST /api/sncr/numeracoes/notificacao-receita` — NRA, NRB, NRB2, NRR, NRT.
- `POST /api/sncr/numeracoes/receita-especial-retencao` — RCE e RET.
- `GET /api/sncr/numeracoes/estoque` — estoque local do prescritor, por tipo.

Regras que valem para as duas rotas de escrita:

- **Conselho, UF e inscrição não vêm do corpo da requisição.** Saem do perfil médico do usuário
  autenticado. A Anvisa confere que o CPF do Gov.br corresponde à inscrição informada e responde
  403 quando não corresponde; aceitar esses campos do cliente só criaria uma forma de tentar
  puxar numeração em nome de outro prescritor.
- **Chave de idempotência obrigatória** (8 a 60 caracteres), com índice único por prescritor. É o
  que impede que duplo clique, retry de rede ou refresh gastem cota que não volta.
- **Guarda-corpo local de cota**, conferido antes de chamar: 50 por tipo/dia na notificação de
  receita e 3 requisições/mês em RCE/RET, contadas no calendário de Brasília. O guarda-corpo só
  enxerga o que esta plataforma consumiu — ele nunca autoriza mais do que a Anvisa autorizaria,
  só evita gastar requisição para ouvir "não".
- **Toda tentativa é gravada.** Apenas os desfechos `Granted` e `Unavailable` ficam sob a chave
  pedida: o primeiro porque a cota foi debitada, o segundo porque é **indeterminado** — uma falha
  de rede pode ter chegado à Anvisa. Recusa limpa (400/401/403) e 204 entram com chave derivada,
  para o histórico existir sem travar a retentativa legítima.
- **204 não é erro.** Significa "prescritor válido, sem numeração atribuída" e é devolvido como
  200 com `status: "none_available"`, não como problema.

### Persistência

`sncr_numbering_batches` (o ato administrativo) e `sncr_prescription_numbers` (cada número como
linha própria, `numero` único global, consumo por `UPDATE` e nunca `DELETE`). Criadas pelo
`MigrationRunner` no grupo `sncr_numbering`.

O bloco de RCE/RET chega como intervalo `inicio`/`fim` e é expandido em números individuais por
`SncrNumberRange`, que **se recusa** a expandir quando o formato não é o esperado — prefixos
diferentes, larguras diferentes, ou contagem divergente da quantidade que a Anvisa informou.
Nesse caso o lote é gravado com `numbers_materialized = false` e o motivo em
`materialization_note`. Número de receituário inventado é pior que número ausente: o ausente
falha na hora, o inventado vira documento sanitário inválido na mão do paciente.

### Segurança

- token SNCR não vai para frontend;
- token SNCR não vai para log;
- `session_id` não vai para log;
- `state` é aleatório, curto e de uso único;
- o callback não depende da sessão do app nem do portal; fora de `localhost` o state volta
  pelo cookie `__Host-` que o `/api/sncr/go` gravou no mesmo navegador que faz o login;
- Redis é a fonte de sessão, permitindo múltiplas instâncias da API;
- falha de Redis, timeout ou erro remoto é **fail-closed**;
- eventos `SNCR_CONNECT_STARTED`, `SNCR_CONNECTED` e `SNCR_DISCONNECTED` são enviados para a auditoria do RenoveJá sem segredos.

## Fluxo web — tutorial exibido ao médico

Tela: `frontend-web/src/pages/doctor/DoctorHelp.tsx`

Caminho:

**Configurações → Ajuda e FAQ → Anvisa / SNCR / Gov.br**

A própria tela mostra:

1. **Confira seu CRM e a UF.**
2. Clique em **Conectar com Gov.br**.
3. Entre com **a conta Gov.br do próprio prescritor**.
4. Se for o primeiro acesso, conclua o cadastro/validação solicitado pelo SNCR.
5. O SNCR devolve o navegador ao RenoveJá.
6. O médico deve confirmar o selo **Conectado ao SNCR**.

A página também deixa explícito:

- o RenoveJá não recebe a senha Gov.br;
- CRM/UF enviados no fluxo ficam visíveis antes de conectar;
- treinamento e produção são ambientes diferentes;
- “conectado” não significa “receita controlada liberada”.

## Fluxo mobile — tutorial exibido ao médico

Entrada:

**Consultório médico → Mais → SNCR / Anvisa**

Tela: `frontend-mobile/app/(doctor)/sncr.tsx`

O app apresenta os mesmos cinco passos do web, com cartões numerados e legendas curtas. Ao tocar **Conectar com Gov.br**:

1. o app pede à API uma URL de conexão;
2. abre o navegador no `/api/sncr/go`, que grava o state em cookie e segue para o SNCR/Gov.br;
3. o médico autentica no ambiente oficial;
4. o SNCR devolve o navegador para a raiz da API (`/?session_id=...`), que troca o `session_id` por token;
5. o backend redireciona para `renoveja://sncr?sncr=connected`;
6. o Expo Router abre novamente a tela SNCR;
7. a tela atualiza o status automaticamente ao voltar para o foreground.

## Primeiro acesso do prescritor

A documentação da Anvisa informa que o prescritor precisa existir no SNCR e possuir inscrição ativa em conselho profissional. O primeiro acesso é realizado com Gov.br e pode exigir a conclusão da validação/cadastro profissional no SNCR.

O RenoveJá não tenta substituir essa validação. Ele mostra ao médico exatamente o que fazer e o devolve à plataforma após o fluxo oficial.

## Configuração do ambiente

A integração nasce desligada até que o ambiente seja explicitamente preparado. Variáveis suportadas:

```text
Sncr__Enabled=true
Sncr__Mode=homologation
Sncr__BaseUrl=https://sncr-api.hmg.apps.anvisa.gov.br
Sncr__CallbackUrl=https://API_PUBLICA_DO_RENOVEJA/api/sncr/callback
Sncr__WebReturnUrl=https://medico.renovejasaude.com.br/ajuda
Sncr__MobileReturnUrl=renoveja://sncr
Sncr__TimeoutSeconds=20

# Obrigatório para RCE/RET. É o CNPJ da empresa responsável por ESTA plataforma —
# não do médico, não do município. Sem ele a rota falha fechada.
Sncr__PlatformCnpj=

# Espelham os limites oficiais. Existem como configuração para o dia em que a Anvisa
# mudar o número, não para serem afrouxados localmente.
Sncr__DailyNotificationLimit=50
Sncr__MonthlySpecialControlRequests=3

# NÃO liberar apenas porque a autenticação funciona:
Sncr__IssuanceEnabled=false
Sncr__AllowProductionIssuance=false
```

**Atenção à base URL.** O manual publica `https://sncr-api.hmg.apps.anvisa.gov.br/api/v1`, já com
o sufixo de versão, mas os caminhos são montados no código incluindo `/api/v1`. O cliente remove
o sufixo se ele vier configurado, para que as duas formas funcionem — mas o valor canônico é o
host puro. O host `sncr-api.apps.anvisa.gov.br` (sem `hmg`), que era o default anterior, **nunca
foi confirmado**: a 2ª edição do manual não publica URL de produção.

**Limite mensal de RCE/RET: o manual se contradiz.** As regras de negócio dizem "3.000 numerações
entre RCE e RET por mês" (somado); a tabela de mensagens de erro diz "limite mensal de 3.000
receitas por tipo". A contagem local adota a leitura conservadora (combinada) até a Anvisa
desempatar. Bloquear cedo demais custa uma mensagem clara ao médico; bloquear tarde demais custa
cota que não volta.

`Sncr__CallbackUrl` precisa ser HTTPS em ambiente remoto. HTTP só é aceito pelo controller para `localhost`/`127.0.0.1` em desenvolvimento.

## API oficial contemplada pelo fluxo

Base de referência da documentação:

```text
https://sncr-api.apps.anvisa.gov.br
```

Esse host aparece no exemplo de código das Instruções de Integração v1.0, mas **não existe no
DNS** (conferido em 19/09/2026: `Non-existent domain`). O único host que responde hoje é o de
homologação, `https://sncr-api.hmg.apps.anvisa.gov.br`, e é ele que o código usa.

Autenticação:

```text
GET /api/v1/auth/login?client_url=SEU_FRONTEND
```

Retorno:

```text
SEU_FRONTEND?session_id=...
```

Troca por token:

```text
GET /api/v1/auth/token?session_id=...
```

O JWT retornado é usado apenas no servidor e nunca é exposto ao frontend do RenoveJá.

## O que permanece bloqueado de propósito

O código atual **não removeu** o portão de emissão para:

- `PrescriptionKind.ControlledSpecial`;
- `PrescriptionType.Controlled`;
- `PrescriptionType.Blue`.

Antes de liberar essas modalidades, ainda é obrigatório validar no ambiente oficial:

1. ~~obtenção real da numeração correta para cada modalidade~~ — **implementado em 30/08/2026**;
   falta a execução real contra o SNCR, que depende de um prescritor autenticado no Gov.br;
2. ~~schema/resposta definitiva da API~~ — **fechado pelo OpenAPI oficial**, com teste que trava
   os dois formatos de sucesso e os três de erro;
3. ~~persistência imutável da numeração vinculada ao request~~ — **implementado**
   (`sncr_prescription_numbers`, `numero` único global, consumo por `UPDATE`);
4. ~~idempotência para impedir consumo duplicado~~ — **implementado** (chave obrigatória com
   índice único por prescritor);
5. modelo eletrônico oficial;
6. QR/consulta oficial quando exigidos;
7. assinatura PAdES/ICP-Brasil após a numeração;
8. evidência de teste no ambiente de homologação;
9. homologação de produção — **sem como fechar hoje**: a 2ª edição do manual não publica URL de
   produção;
10. autorização explícita de produção no RenoveJá.

### O que falta para rodar a homologação de ponta a ponta

O código está pronto e desligado. Para a primeira chamada real faltam três coisas que **não são
de engenharia**:

1. **Um prescritor com conta Gov.br fazendo o login**, pelo fluxo que já existe. Não há
   substituto: a API exige que o CPF autenticado corresponda à inscrição da requisição, então
   ninguém pode obter numeração em nome do médico.
2. **Esse prescritor previamente cadastrado no SNCR**, com inscrição ativa no conselho. A API
   responde "usuário autenticado não encontrado" enquanto o cadastro não existir.
3. **O CNPJ da empresa em `Sncr__PlatformCnpj`**, exigido pela rota de RCE/RET.

Em homologação, o perfil de requisição de numeração **dispensa a aprovação prévia da Visa** — é o
que permite validar a integração técnica antes de qualquer trâmite sanitário. Em produção isso
não vale: toda numeração continua sujeita à análise e autorização da Visa competente, e a página
de solicitação para prescritores só entra até 30/09/2026. Até lá o pedido segue pelo canal
próprio de cada Visa.

### "Domínio não autorizado": a Anvisa barra o FORMATO do retorno, não o domínio (19/09/2026)

O médico que tocava "Conectar com Gov.br" no app caía numa página da Anvisa com
`{"error": "Domínio não autorizado"}` em JSON cru, sem caminho de volta. A primeira leitura foi
"lista branca de domínios"; a medição seguinte mostrou outra coisa. Fora de `localhost`, o login
do SNCR **só aceita como `client_url` a origem pura** (`https://host/`). Caminho, query, fragmento
ou porta explícita levam 403 — com qualquer domínio, inclusive o da própria Anvisa:

| `client_url` enviado | Resposta de `sncr-api.hmg.apps.anvisa.gov.br` |
|---|---|
| `http://localhost:5005/api/sncr/callback?state=abc` | `302` para o Gov.br |
| `https://api.renovejasaude.com.br/` | `302` para o Gov.br |
| `https://api.renovejasaude.com.br/api/sncr/callback` | `403 {"error": "Domínio não autorizado"}` |
| `https://api.renovejasaude.com.br/?state=abc` | `403` |
| `https://www.gov.br/` | `302` |
| `https://www.gov.br/anvisa` | `403` |
| `https://sncr-api.hmg.apps.anvisa.gov.br/x` | `403` |

O SNCR guarda o `client_url` dentro do `state` do OAuth (base64 de
`https://api.renovejasaude.com.br/|...`) e, depois do Gov.br, devolve o navegador para
`<client_url>?session_id=...`.

**Retorno pela raiz (19/09/2026).** O state não cabe mais no `client_url`, então viaja por dois
caminhos:

1. `connect/start` devolve `https://api.renovejasaude.com.br/api/sncr/go?state=<256 bits>`;
2. o `/api/sncr/go` grava o state no cookie `__Host-rj-sncr-state` e segue para o SNCR com
   `client_url=https://api.renovejasaude.com.br/&state=<o mesmo state>`. O parâmetro `state` é
   do próprio SNCR (Manual 2ed: "estado arbitrário do cliente"): ele o assina dentro do state do
   OAuth e o devolve na volta;
3. o SNCR devolve para `https://api.renovejasaude.com.br/?session_id=...` (sucesso) ou
   `/?error=...&state=...` (login cancelado ou inválido). A raiz pega o state da query e, se
   não vier, do cookie; consome o state no Redis (uso único) e troca o `session_id` pelo token.
   Com `error`, devolve o médico à tela de origem com `sncr=error&reason=provider_<erro>`.

Por que os dois caminhos: a volta de ERRO com o nosso state na query foi vista na homologação
(`/?error=token_invalid&state=...`), mas a de SUCESSO só se prova com um login Gov.br real, e o
manual cita apenas `?session_id`. O state na query faz cada aba concluir a própria tentativa; o
cookie cobre a volta que vier sem ele. O cookie é `SameSite=Lax` e não `Strict` porque a volta é
uma navegação que vem de outro site (`acesso.*.anvisa.gov.br`). Em `localhost` o fluxo antigo
continua (o SNCR aceita caminho ali). Provado até o 302 para o Gov.br e na volta de erro real;
a volta com um `session_id` real depende de um prescritor com conta Gov.br cadastrado no SNCR.

A Anvisa foi avisada em 19/09/2026 (e-mail para `sncr.visa@anvisa.gov.br`, o canal do Manual do
SNCR 6ª ed.) pedindo que o `client_url` aceite caminho, como o exemplo da seção 4.3 das próprias
Instruções. A cópia para `arquitetura@anvisa.gov.br` (contato do OpenAPI) voltou: o grupo não
recebe e-mail de fora da Anvisa.

**A sonda continua valendo** (commit `812be6205`): antes de montar o link, o backend pergunta ao
SNCR se o endereço de retorno é aceito (`GET /api/v1/auth/login` sem seguir o redirecionamento,
resultado guardado no Redis por 30 minutos quando aceito e por 5 quando recusado; resposta
inconclusiva não é guardada).

- `3xx` → domínio aceito, o fluxo segue normalmente;
- `403` com "autorizado" no corpo → `POST /api/sncr/connect/start` responde
  `409 sncr_domain_not_authorized` com mensagem em português, e o status traz
  `providerDomainAuthorized: false`. App e portal desabilitam o botão e mostram "Aguardando
  liberação da Anvisa";
- qualquer outra resposta, ou a Anvisa fora do ar → segue em frente (fail-open). A consulta só
  existe para evitar a página de erro, e não deve bloquear quem já pode estar liberado.

**Por que 409 e não 503.** Até 19/09 a recusa saía como `503`. Todo status `>= 500` vira linha
`ERR` no `ApiRequestLoggingMiddleware`, e `ERR` vira issue no Sentry — foi o
`DOTNET-ASPNETCORE-3F`, aberto por um médico real num app sem a OTA nova. O 503 também contava no
alarme P0 de 5xx do ALB, e o app anterior a 02/09 retentava POST em 503, então cada toque virava
três chamadas. O servidor não falhou: quem ainda não liberou é a Anvisa, e isso é 4xx. App e
portal, inclusive as versões antigas, mostram a `message` do corpo para qualquer status não-OK,
então o médico vê a mesma frase.

A sonda pergunta com o `client_url` exatamente como o navegador o mandará (hoje a origem pura, que
é aceita), e a chave do cache é esse `client_url` inteiro: se a Anvisa endurecer a regra de novo,
o botão volta a mostrar "Aguardando liberação da Anvisa" em vez da página de erro.

## Critério de conclusão regulatória

Marcar **emissão SNCR** como `OPERACIONAL` somente quando houver simultaneamente:

- integração oficial liberada pela Anvisa;
- teste de treinamento aprovado;
- fluxo Gov.br funcionando;
- numeração real obtida pela API;
- documento oficial gerado;
- QR/consulta oficial verificados;
- assinatura ICP-Brasil validada;
- evidência arquivada no dossiê de homologação;
- flags de produção explicitamente habilitadas.

Até lá, o status correto é:

> **Autenticação/integração preparada; emissão regulatória fail-closed.**
