# ADR-0004 — Teleconsulta Fase 4: token de sala do paciente, sinalização com
# cursor transacional e gravação FORA do escopo

**Data:** 21/10/2026 · **Status:** Aceito · **Decisor:** engenharia (com pendência nomeada)

## 1. Sessão do paciente = token de sala (4h), não conta de usuário

O convite é single-use (hash+expiração, consumo ATRAZADO até as validações da sala —
um join recusado não pode queimar o código). Depois de entrar, o paciente troca
SDP/ICE com `POST/GET /teleconsult/rooms/:id/signals[paciente]` protegidos por
header `X-Teleconsult-Token` (JWT HS256 com `purpose='teleconsult-room'`+roomId+org,
mesmo `AUTH_SECRET` do app). **Nunca em storage** (só memória da aba); expira em 4h;
roomId casado (token de uma sala não abre outra). Header incluído no `allowedHeaders`
do CORS (3ª lição E2E: custom headers morrem no preflight — smoke via curl nunca pega).

## 2. Sinalização: cursor só avança após tratar (e o 2º participante não "transiciona")

- O `seq` da fila é o cursor do polling: avançar ANTES de tratar descarta sinais
  num erro transitório (bug real, provado: paciente ficou para sempre sem resposta).
  Cursor avança DEPOIS do sucesso; falha reprocessa a MESMA linha no próximo tick.
- `transitionRoom('open','join')` continua INVÁLIDO como máquina pura (contrato do
  teste existente preservado): a sala aberta por um participante é ENTRADA sem
  mudança de estado para o outro (`next = open ? open : transition(...)`).
- **Bugs latentes corrigidos (nenhum exercício prévio existia):** INSERT do convite
  usava o id da SALA no `WHERE` do atendimento (0 linhas — convite NUNCA existiu);
  INSERT de sinais sem `org_id` (NOT NULL desde o018 — todo sinal falharia);
  parâmetro órfão `$3` no INSERT do convite (500).

## 3. Gravação: FORA do escopo — pendência nomeada (DPO/direção clínica)

**Não existe capacidade de gravação implementada** (sem MediaRecorder, sem
armazenamento de mídia). A UI declara "Gravação: desligada (padrão deste ambiente —
armazenamento de mídia é pendência LGPD/DPO)" e o consentimento registrado é
obrigatório para entrar (servidor bloqueia sem ele). Ligar gravação exige projeto
próprio: base legal/consentimento granular, retenção, armazenamento criptografado e
aprovação do DPO — **quem decide: DPO + direção clínica** (não é decisão de código).

## 4. ICE/TURN por env (capacidade nasce desligada)

`TELECONSULT_ICE_SERVERS` (JSON array). Ausente → `{iceServers:[]}` = P2P direto
sem credencial (é o caso do E2E: candidatos host reais via flag
`--disable-features=WebRtcHideLocalIpsWithMdns`, sem a qual o mDNS ofusca os
candidatos entre contexts e o P2P nunca conecta em CI).

## 5. Estados honestos

`callBadge`: Conectando/Conectado/Reconectando…/Falhou/Sala encerrada. A degradação
medida no E2E é a do CANAL DE SINALIZAÇÃO (Playwright `setOffline` afeta HTTP, não
UDP/WebRTC): 3 falhas seguidas de polling com conexão WebRTC ativa → "Reconectando…",
e ao voltar o badge volta ao estado do WebRTC real.
