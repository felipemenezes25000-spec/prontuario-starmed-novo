#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEST="$ROOT/infra/icp-brasil/policies"
BASE="https://politicas.icpbrasil.gov.br"

# Mesma correção das raízes: o servidor omite a intermediária. Ver lib-icp-brasil-tls.sh.
# shellcheck source=lib-icp-brasil-tls.sh
. "$(dirname "$0")/lib-icp-brasil-tls.sh"
ICP_CA_BUNDLE="$(icp_ca_bundle politicas.icpbrasil.gov.br)" || exit 1

command -v curl >/dev/null || { echo "ERRO: curl não encontrado." >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "ERRO: sha256sum não encontrado." >&2; exit 1; }

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

install_policy() {
  local profile="$1"
  local der="$2"
  local official_hash_file="$3"

  echo "Baixando política PAdES $profile..."
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --cacert "$ICP_CA_BUNDLE" \
    --max-time 60 "$BASE/$der" -o "$TMP/$der"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --cacert "$ICP_CA_BUNDLE" \
    --max-time 60 "$BASE/$official_hash_file" -o "$TMP/$official_hash_file"

  local expected
  expected="$(grep -Eo '[0-9A-Fa-f]{64}' "$TMP/$official_hash_file" | head -n1 | tr '[:lower:]' '[:upper:]')"
  if [[ ! "$expected" =~ ^[0-9A-F]{64}$ ]]; then
    echo "ERRO: o arquivo oficial de hash de $profile não contém SHA-256 válido." >&2
    exit 1
  fi

  local actual
  actual="$(sha256sum "$TMP/$der" | awk '{print toupper($1)}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERRO: SHA-256 da política $profile diverge do valor publicado pelo ITI." >&2
    echo "esperado=$expected" >&2
    echo "calculado=$actual" >&2
    exit 1
  fi

  cp "$TMP/$der" "$DEST/$der"
  printf '%s  %s\n' "$expected" "$der" > "$DEST/$der.sha256"
  chmod 0644 "$DEST/$der" "$DEST/$der.sha256"

  echo "  OK: $der"
  echo "  SHA-256: $expected"
}

# Repositório oficial do ITI: versões PAdES 1.3 vigentes desde 23/07/2025.
install_policy "AD-RB v1.3" \
  "PA_PAdES_AD_RB_v1_3.der" \
  "PA_PAdES_AD_RB_v1_3der-sha256.txt"

install_policy "AD-RT v1.3" \
  "PA_PAdES_AD_RT_v1_3.der" \
  "PA_PAdES_AD_RT_v1_3der-sha256.txt"

echo
echo "Políticas instaladas e verificadas em: $DEST"
echo "Reconstrua a imagem do backend para copiá-las para /etc/icp-brasil/policies/."
