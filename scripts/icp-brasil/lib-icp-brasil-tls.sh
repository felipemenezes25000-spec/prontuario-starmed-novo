#!/usr/bin/env bash
# Cadeia TLS dos servidores da ICP-Brasil: eles não enviam a intermediária.
#
# Medido em 04/09/2026, contra um bundle de CA limpo (container `curlimages/curl`, que é o
# mesmo estado do runner do GitHub):
#
#   curl https://politicas.icpbrasil.gov.br/   -> exit 60, "unable to get local issuer certificate"
#   openssl s_client ...                       -> Verify return code: 21
#   cadeia apresentada                         -> APENAS a folha (`0 s:CN=*.icpbrasil.gov.br`)
#
# O certificado é Let's Encrypt (`CN=YE1`), e a raiz dele (`ISRG Root YE`) JÁ está no bundle
# do sistema — o que falta é só a intermediária, que o servidor deveria enviar no handshake e
# não envia. Isso derrubou o deploy do backend (run 33915619645) no passo dos artefatos.
#
# A correção NÃO adiciona confiança: ela entrega ao curl um certificado que o servidor
# esqueceu de mandar. A intermediária vem da URL declarada no AIA (`CA Issuers`) do próprio
# certificado do servidor — o mecanismo padrão para isso — e só é aceita se ela mesma fechar
# a cadeia contra o bundle do sistema. Se não fechar, o script falha em vez de seguir.
#
# O que NÃO fazemos, e não devemos: `--insecure`. Estes downloads são raízes de confiança e
# políticas de assinatura; desligar a verificação aqui inverteria o propósito do passo.
# (As políticas PAdES ainda são conferidas por SHA-256 oficial depois do download; esta
# camada é a autenticidade do transporte, não substitui aquela.)

set -euo pipefail

# Emite no stdout o caminho de um bundle = CA do sistema + intermediária que falta.
# Uso:  CAFILE="$(icp_ca_bundle politicas.icpbrasil.gov.br)"
#       curl --cacert "$CAFILE" ...
icp_ca_bundle() {
  local host="$1"
  local dir
  dir="$(mktemp -d)"

  local sistema=""
  local candidato
  for candidato in \
    /etc/ssl/certs/ca-certificates.crt \
    /etc/pki/tls/certs/ca-bundle.crt \
    /etc/ssl/cert.pem
  do
    [ -r "$candidato" ] && { sistema="$candidato"; break; }
  done
  if [ -z "$sistema" ]; then
    echo "ERRO: bundle de CA do sistema não encontrado; sem ele não há como verificar." >&2
    return 1
  fi

  # Sobe a cadeia pelo AIA até chegar a algo que o sistema já confia.
  #
  # Um nível não basta neste caso: a intermediária `YE1` é emitida por `ISRG Root YE`, que é
  # uma raiz NOVA e ainda não está no ca-certificates (conferido no 22.04 e no 24.04, com o
  # pacote de junho/2026: só X1 e X2). Mas o AIA da própria YE1 aponta para a versão
  # CRUZ-ASSINADA de Root YE, emitida por `ISRG Root X2` — essa sim já confiável. Seguindo o
  # AIA de nível em nível, a cadeia fecha sem acrescentar âncora de confiança nenhuma.
  local aia
  aia="$(echo \
    | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null \
    | openssl x509 -noout -text 2>/dev/null \
    | grep -A1 'Authority Information Access' \
    | grep -Eo 'URI:http[^ ]*' | head -n1 | cut -d: -f2-)"

  if [ -z "$aia" ]; then
    echo "ERRO: $host não declarou CA Issuers no AIA; não dá para completar a cadeia." >&2
    return 1
  fi

  : > "$dir/extra.pem"
  local nivel=0
  while [ -n "$aia" ] && [ "$nivel" -lt 5 ]; do
    nivel=$((nivel + 1))

    # O AIA é servido por HTTP — é o padrão. Isso não afrouxa nada: o resultado só entra no
    # bundle depois de a cadeia inteira verificar contra o CA do sistema, no fim desta função.
    curl --fail --silent --show-error --location --max-time 30 "$aia" -o "$dir/n$nivel.bin" \
      || { echo "ERRO: falha ao baixar o emissor em $aia" >&2; return 1; }

    if openssl x509 -inform DER -in "$dir/n$nivel.bin" -out "$dir/n$nivel.pem" 2>/dev/null; then
      :
    elif openssl x509 -inform PEM -in "$dir/n$nivel.bin" -out "$dir/n$nivel.pem" 2>/dev/null; then
      :
    else
      echo "ERRO: o conteúdo de $aia não é um certificado." >&2
      return 1
    fi

    cat "$dir/n$nivel.pem" >> "$dir/extra.pem"

    # Chegou a algo que o sistema já valida? Então a cadeia fechou.
    if openssl verify -CAfile "$sistema" -untrusted "$dir/extra.pem" "$dir/n$nivel.pem" >/dev/null 2>&1; then
      break
    fi

    aia="$(openssl x509 -in "$dir/n$nivel.pem" -noout -text 2>/dev/null \
      | grep -A1 'Authority Information Access' \
      | grep -Eo 'URI:http[^ ]*' | head -n1 | cut -d: -f2-)"
  done

  # Guarda final: o que foi baixado TEM de fechar contra o bundle do sistema. É esta linha
  # que impede qualquer coisa vinda por HTTP de entrar no bundle sem verificação.
  if ! openssl verify -CAfile "$sistema" -untrusted "$dir/extra.pem" "$dir/n$nivel.pem" >/dev/null 2>&1; then
    echo "ERRO: a cadeia de $host não fecha contra o bundle do sistema — recusada." >&2
    return 1
  fi

  cat "$sistema" "$dir/extra.pem" > "$dir/bundle.pem"
  echo "$dir/bundle.pem"
}
