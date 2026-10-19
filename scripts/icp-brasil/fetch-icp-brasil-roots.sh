#!/usr/bin/env bash
#
# fetch-icp-brasil-roots.sh
#
# Materializa o trust store da RenoveJá somente com AC Raiz ICP-Brasil adequadas
# à validação de certificados de assinatura clínica.
#
# Fonte oficial: https://acraiz.icpbrasil.gov.br/credenciadas/RAIZ/
# Revisão da allowlist: 23/08/2026, com base no repositório oficial do ITI
# atualizado em 10/08/2026.
#
# Por que NÃO fazemos scraping de "todo .crt" da página:
# - v8/v9 estão revogadas;
# - v10 é raiz destinada a SSL;
# - v11 é raiz destinada a assinatura de código;
# - versões antigas expiradas/revogadas não devem virar âncoras genéricas novas.
#
# O conjunto operacional para certificados de assinatura clínica fica explicitamente
# limitado a v4, v5, v6, v7, v12 e v13. Se o ITI publicar nova raiz, o script deve
# falhar/continuar com esta lista até revisão humana — confiança não é auto-update.
#
# Uso:
#   bash infra/scripts/shell/fetch-icp-brasil-roots.sh
#   bash infra/scripts/shell/fetch-icp-brasil-roots.sh --listar
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEST="$REPO_ROOT/infra/icp-brasil/roots"
HOST="acraiz.icpbrasil.gov.br"
BASE_URL="https://$HOST/credenciadas/RAIZ"

# O servidor da ICP-Brasil não envia a intermediária no handshake, então o bundle de CA
# precisa recebê-la à parte. Ver o cabeçalho de lib-icp-brasil-tls.sh: nenhuma confiança
# nova é adicionada, e a intermediária só entra se fechar contra a raiz que o sistema já tem.
# shellcheck source=lib-icp-brasil-tls.sh
. "$(dirname "$0")/lib-icp-brasil-tls.sh"
ICP_CA_BUNDLE="$(icp_ca_bundle "$HOST")" || exit 1
MANIFEST="$DEST/manifest.sha256"
META="$DEST/manifest.tsv"

# Ordem deliberada e estável para diffs/auditoria.
ROOT_FILES=(
  "ICP-Brasilv4.crt"
  "ICP-Brasilv5.crt"
  "ICP-Brasilv6.crt"
  "ICP-Brasilv7.crt"
  "ICP-Brasilv12.crt"
  "ICP-Brasilv13.crt"
)

LIST_ONLY=0
[[ "${1:-}" == "--listar" ]] && LIST_ONLY=1

msg()  { printf '%s\n' "$*" >&2; }
fail() { printf '\nERRO: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl não encontrado."
command -v openssl >/dev/null || fail "openssl não encontrado."
command -v sha256sum >/dev/null || fail "sha256sum não encontrado."

msg "Trust store ICP-Brasil aprovado para assinatura clínica:"
for file in "${ROOT_FILES[@]}"; do
  msg "  · $BASE_URL/$file"
done

if [[ $LIST_ONLY -eq 1 ]]; then
  msg "--listar: nenhum arquivo foi alterado."
  exit 0
fi

# 1) Recusar uma conexão claramente interceptada.
msg ""
msg "Conferindo a cadeia TLS de $HOST…"
ISSUER="$(echo | openssl s_client -connect "$HOST:443" -servername "$HOST" 2>/dev/null \
  | openssl x509 -noout -issuer 2>/dev/null || true)"
[[ -n "$ISSUER" ]] || fail "não foi possível abrir conexão TLS com $HOST."
msg "  emissor: ${ISSUER#issuer=}"

if printf '%s' "$ISSUER" | grep -qiE \
  'avast|kaspersky|bitdefender|eset|norton|mcafee|zscaler|netskope|fortinet|fortigate|palo alto|bluecoat|proxy|mitm|scanning|web/mail shield'; then
  fail "conexão HTTPS interceptada. Não é seguro materializar âncoras de confiança nessa rede."
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/out"

printf '# SHA-256 dos DER oficiais após validação e conversão para PEM\n' > "$TMP/manifest.sha256"
printf 'file\tsource\tsubject\tnot_before\tnot_after\tsha256_der\n' > "$TMP/manifest.tsv"

# 2) Baixar a allowlist e validar cada certificado antes de tocar no diretório final.
for file in "${ROOT_FILES[@]}"; do
  url="$BASE_URL/$file"
  der="$TMP/$file"
  pem="$TMP/out/${file%.crt}.pem"

  msg "Baixando $file…"
  curl --fail --silent --show-error --location \
       --proto '=https' --tlsv1.2 --max-time 60 \
       --cacert "$ICP_CA_BUNDLE" \
       "$url" -o "$der" || fail "falha ao baixar $url"

  format=""
  if openssl x509 -in "$der" -inform DER -noout >/dev/null 2>&1; then
    format="DER"
  elif openssl x509 -in "$der" -inform PEM -noout >/dev/null 2>&1; then
    format="PEM"
  else
    fail "$file não é um certificado X.509 legível."
  fi

  subject="$(openssl x509 -in "$der" -inform "$format" -noout -subject | sed 's/^subject=//')"
  issuer="$(openssl x509 -in "$der" -inform "$format" -noout -issuer | sed 's/^issuer=//')"
  not_before="$(openssl x509 -in "$der" -inform "$format" -noout -startdate | cut -d= -f2-)"
  not_after="$(openssl x509 -in "$der" -inform "$format" -noout -enddate | cut -d= -f2-)"

  [[ "$subject" == "$issuer" ]] || fail "$file não é autoassinado; recusando como AC Raiz."

  basic_constraints="$(openssl x509 -in "$der" -inform "$format" -noout -text \
    | awk '/X509v3 Basic Constraints/{getline; gsub(/^[[:space:]]+/, ""); print; exit}')"
  printf '%s' "$basic_constraints" | grep -q 'CA:TRUE' \
    || fail "$file não declara CA:TRUE."

  # Não instala raiz já expirada. As versões selecionadas devem estar vigentes na
  # data da execução; se o ITI fizer rollover, isso força revisão explícita.
  openssl x509 -in "$der" -inform "$format" -checkend 0 -noout >/dev/null \
    || fail "$file está expirado; atualize a allowlist antes de prosseguir."

  # Converte para PEM canônico para o runtime .NET; o hash de auditoria continua
  # sendo calculado sobre os bytes oficiais baixados, não sobre a serialização PEM.
  openssl x509 -in "$der" -inform "$format" -outform PEM -out "$pem"

  sha_der="$(sha256sum "$der" | awk '{print toupper($1)}')"
  sha_pem="$(sha256sum "$pem" | awk '{print toupper($1)}')"
  printf '%s  %s\n' "$sha_pem" "$(basename "$pem")" >> "$TMP/manifest.sha256"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(basename "$pem")" "$url" "$subject" "$not_before" "$not_after" "$sha_der" \
    >> "$TMP/manifest.tsv"

  msg "  · OK: $subject"
  msg "    DER SHA-256: $sha_der"
done

COUNT="$(find "$TMP/out" -maxdepth 1 -type f -name '*.pem' | wc -l | tr -d ' ')"
[[ "$COUNT" == "${#ROOT_FILES[@]}" ]] \
  || fail "esperava ${#ROOT_FILES[@]} raízes validadas, encontrei $COUNT."

# 3) Troca atômica lógica: só remove os PEM gerenciados depois que TODOS os novos
# certificados passaram. README permanece versionado.
mkdir -p "$DEST"
find "$DEST" -maxdepth 1 -type f -name 'ICP-Brasilv*.pem' -delete
cp "$TMP/out"/*.pem "$DEST/"
cp "$TMP/manifest.sha256" "$MANIFEST"
cp "$TMP/manifest.tsv" "$META"

# 4) Revalida o conteúdo já no destino e imprime a allowlist a ser usada pelo app.
msg ""
msg "Validando trust store materializado…"
(
  cd "$DEST"
  sha256sum -c manifest.sha256 >/dev/null
) || fail "manifest.sha256 não confere após a cópia."

msg "  ${#ROOT_FILES[@]}/${#ROOT_FILES[@]} raízes íntegras."
msg ""
msg "Thumbprints X.509 SHA-256 para IcpBrasilSignature:TrustedRootThumbprints:"
for pem in "$DEST"/ICP-Brasilv*.pem; do
  thumb="$(openssl x509 -in "$pem" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g')"
  msg "  $thumb  $(basename "$pem")"
done

msg ""
msg "Arquivos gerados:"
msg "  $DEST/ICP-Brasilv{4,5,6,7,12,13}.pem"
msg "  $MANIFEST"
msg "  $META"
msg ""
msg "Próximo gate: registre os thumbprints em produção, reconstrua a imagem e execute"
msg "os testes de IcpBrasilTrustStore. Não habilite RequireTimestamp até provar um PDF"
msg "real no validar.iti.gov.br."
