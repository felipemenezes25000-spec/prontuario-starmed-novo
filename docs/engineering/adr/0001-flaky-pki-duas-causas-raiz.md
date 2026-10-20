# ADR-0001 — Estabilização do teste flaky "carimbo de ACT" (duas causas raiz)

**Data:** 21/10/2026 · **Status:** Aceito · **Decisor:** engenharia (execução técnica)
**Contexto:** `pki.test.ts` "carimbo de ACT vira atributo unsigned (AD-RT)" falhava
~1 em 10 execuções no CI (run `39491059280`, re-run verde) — um flaky mascarava
qualquer regressão real na suíte.

## Investigação (executada, não especulada)

1. Reprodução local: 1 falha em 15 execuções — `error:0480006C:PEM routines::no start line`
   em `new X509Certificate`.
2. Fuzz dirigido do gerador de certificados de teste (400 → 1000 execuções) com
   discriminação de estágio (build/DER/PEM) e preservação dos DERs problemáticos.

## Causa raiz 1 — serial INTEGER não-mínimo (estágio DER)

`makeCertificate`/`serialWithPositiveHead` geravam o serial como 8 bytes aleatórios
com `byte[0] &= 0x7f`. Quando o primeiro byte era `0x00` **e** o segundo era `< 0x80`
(p ≈ 1/128 por certificado; a suíte gera ~20 certs/run), o INTEGER saía com um zero
redundante → **OpenSSL 3 recusa o certificado** e o Node cai no fallback de parse PEM
("no start line"). A suíte roda ~20 gerações → ~10% de risco por run — batendo com a
frequência observada.

**Correção:** `positiveMinimalIntegerBytes()` em `test-pki.ts` — remove zeros à
esquerda redundantes, preserva o `0x00` de preenchimento só quando o byte seguinte
é `≥ 0x80`, e nunca devolve serial zero.

## Causa raiz 2 — linha vazia antes de `-----END CERTIFICATE-----` (estágio PEM)

`pem()` monta o corpo com `replace(/(.{64})/g, '$1\n')` e depois `\n${body}\n`.
Quando o base64 tem múltiplo de 64 chars (DER ≡ 0 mod 3 ⇄ tamanhos como 718–720),
o corpo termina com `\n` e o template acrescenta **outro** → PEM com linha vazia antes
do END. O OpenSSL embarcado no Node (22 e 24) **rejeita** esse PEM com
`asn1 encoding routines::wrong tag` — provado de forma determinística (mesmo DER:
com linha vazia falha, sem ela passa; mesmo cert fixo: 0/2000 falhas). O comprimento
do DER varia com CN/serial/SPKI, daí a aleatoriedade por run.

**Correção:** `pem()` remove os `\n` finais do corpo. Regressão determinística em
`pki.test.ts` (der de 48 bytes → base64 exatamente 64 chars; round-trip da raiz real).

## Efeito colateral corrigido (entrada de usuário em produção)

O mesmo PEM com linha vazia vindo **do usuário** (exports de tokens/carteiras frequentemente
trazem linha vazia/`\r\n`) era rejeitado como "PEM ilegível" em
`POST /prescriptions/:id/sign-pades` e no fluxo de notas (`signature.ts`). Decisão:
normalizar a entrada externa **antes** de parsear — `pki/pem.ts` (`normalizeCertificatePem`)
aplicado em `prescriptions.ts`, `signature.ts`, `pades.ts` e `trust-store.ts`.

## Evidência

- Fuzz do gerador: **0/1000** falhas (antes: 95/1000 no estágio PEM + 2/400 no DER).
- Suíte `pki.test.ts`: **0/30 execuções** com falha (antes ~1/10).
- Suíte completa: **115/115** verdes; `npm run build` verde.

**Consequências:** nenhum gate desligado, nenhum teste apagado; a correção é no
gerador/formatter de teste + normalização de input real (melhora robustez de produção).
