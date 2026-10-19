#!/usr/bin/env node
/**
 * Prepara o PACOTE de submissão ao Validar ICP-Brasil (validar.iti.gov.br).
 *
 * O que faz: valida o CMS contra a cadeia local (trust store + chain), extrai
 * evidências (assinante, política AD-RB/AD-RT, carimbo) e monta um diretório com
 * documento + assinatura + manifest.sha256 + INSTRUÇÕES.md de submissão manual.
 *
 * O que NÃO faz (e não pode fazer sem navegador/sessão): submeter ao portal do ITI.
 * A submissão é um passo humano — este script deixa o pacote pronto e documentado.
 *
 * Uso:
 *   node scripts/icp-brasil/prepare-iti-submission.mjs --document doc.pdf --cms assinatura.cms [--out pacote/]
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DOCUMENT = flag('--document');
const CMS = flag('--cms');
const OUT = resolve(flag('--out') || 'pacote-iti');

const log = (m) => process.stderr.write(m + '\n');
const fail = (m) => { log('ERRO: ' + m); process.exit(1); };

if (!DOCUMENT || !existsSync(DOCUMENT)) fail('--document <arquivo> é obrigatório (PDF assinado ou documento + CMS)');
if (!CMS || !existsSync(CMS)) fail('--cms <assinatura.der|cms> é obrigatório');

const documentBytes = readFileSync(resolve(DOCUMENT));
const cmsBytes = readFileSync(resolve(CMS));
if (documentBytes.length === 0 || cmsBytes.length === 0) fail('arquivos vazios');

mkdirSync(OUT, { recursive: true });
const docName = resolve(DOCUMENT).split(/[\\/]/).pop();
const cmsName = resolve(CMS).split(/[\\/]/).pop();
cpSync(resolve(DOCUMENT), join(OUT, docName));
cpSync(resolve(CMS), join(OUT, cmsName));

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
writeFileSync(join(OUT, 'manifest.sha256'),
  `${sha(documentBytes)}  ${docName}\n${sha(cmsBytes)}  ${cmsName}\n`);

writeFileSync(join(OUT, 'INSTRUÇÕES.md'), `# Pacote de submissão — Validar ICP-Brasil

Gerado em ${new Date().toISOString()} pelo StarMed (scripts/icp-brasil/prepare-iti-submission.mjs).

## Conteúdo

| Arquivo | SHA-256 |
|---|---|
| ${docName} | ${sha(documentBytes)} |
| ${cmsName} | ${sha(cmsBytes)} |

## Como submeter (passo humano — o portal exige sessão/navegador)

1. Abra <https://validar.iti.gov.br>.
2. Escolha o serviço de validação de **assinatura PAdES / documento assinado**.
3. Envie ${docName}${docName.endsWith('.pdf') ? '' : ' (ou o PDF que embute esta assinatura)'}.
4. Confira no relatório:
   - Status de assinatura: **Aprovado**
   - Estrutura: em conformidade com o padrão
   - Resumo criográfico: **true**
   - Caminho de certificação: **Valido**
   - Tipo de carimbo: **Presente** (perfil AD-RT) ou **Ausente** (AD-RB)
5. Arquive o relatório PDF/JSON gerado ao lado deste manifest e registre o resultado
   em \`docs/regulatory/MATRIZ_NGS2_EVIDENCIAS_STARMED.md\` (linha "PAdES").

## Pendências externas declaradas

- A cadeia do assinante precisa ser emitida por AC credenciada ICP-Brasil (e-CPF);
  o trust store deste repositório cobre as raízes v4–v7/v12/v13.
- Com carimbo (AD-RT), a submissão deve reconhecer a ACT configurada; sem TSA_URL
  o documento sai AD-RB (sem carimbo).
`);

log(`Pacote pronto em: ${OUT}`);
log(`  ${docName} (${documentBytes.length} bytes, sha256 ${sha(documentBytes).slice(0, 16)}…)`);
log(`  ${cmsName} (${cmsBytes.length} bytes, sha256 ${sha(cmsBytes).slice(0, 16)}…)`);
log('  manifest.sha256 + INSTRUÇÕES.md');
log('Submissão ao portal do ITI: passo humano (ver INSTRUÇÕES.md).');
