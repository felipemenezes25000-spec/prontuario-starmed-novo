#!/usr/bin/env node
/**
 * RNDS — valida instâncias FHIR (Bundles RIA/RAC/REL) com o validador oficial da HL7.
 *
 *   node scripts/rnds/validate-fhir.mjs <pasta-ou-arquivo.json>... [opções]
 *
 *   --saida <arquivo>          OperationOutcome gravado pelo validador (padrão: artifacts/rnds/validacao.json)
 *   --sem-tx                   sem servidor de terminologia (-tx n/a): códigos não são conferidos
 *   --tx <url>                 servidor de terminologia (padrão do validador: https://tx.fhir.org)
 *   --sem-definicoes-simplifier  só o pacote oficial rnds#1.0.0 (não baixa os perfis RIA/RAC do Simplifier)
 *   --so-linha                 imprime a linha de comando e sai (não baixa nada, não roda java)
 *
 * O que ele faz, na ordem:
 *   1. baixa validator_cli.jar da release fixada do github.com/hapifhir/org.hl7.fhir.core para
 *      artifacts/rnds/ e confere o SHA-256 publicado na release (arquivo com hash errado é apagado);
 *   2. baixa o pacote do guia (https://rnds-fhir.saude.gov.br/package.tgz, rnds#1.0.0) e confere o
 *      SHA-256 gravado aqui — o pacote NÃO está no registro público (packages.fhir.org/rnds → 404),
 *      então `-ig rnds#1.0.0` não resolveria sozinho; o validador recebe o .tgz local;
 *   3. baixa do Simplifier (API FHIR pública do projeto do Ministério) os perfis que só existem lá
 *      (RIA e RAC, espaço de nomes http://www.saude.gov.br/fhir/r4/) para uma pasta que entra como
 *      segundo -ig — é o que a página de validação do guia descreve ("-ig d:\definicoes");
 *   4. roda `java -jar validator_cli.jar <arquivos> -version 4.0.1 -ig <pacote> [-ig <pasta>] -output <saida>`;
 *   5. lê o OperationOutcome de saída, imprime erros por arquivo e sai com 1 se houver erro.
 *
 * Fontes (lidas em 24/09/2026):
 *   - opções -ig/-version/-tx/-recurse: ValidationEngineOptions.java; -output: ValidateCommand.java
 *     ("Results will be represented as an OperationOutcome"); exit code 1 quando há erro
 *     (ValidateCommand.call: SystemExitManager.getError() > 0 → return 1) — repositório hapifhir/org.hl7.fhir.core.
 *   - -ig aceita "a direct reference to a package ('package.tgz')" e "a local folder that contains a
 *     set of conformance resources": IgLoader.java (loadIgSource) do mesmo repositório.
 *   - validação de instâncias no guia: https://rnds-guia.saude.gov.br/docs/rnds/tools/validacao/
 *     ("java -jar validador_cli.jar amostra-invalida.json -ig d:\definicoes -recurse", "-version 4.0.1", "-output saida.json").
 *
 * Só Node (>= 20, fetch nativo) e java na máquina. Nada é executado nos testes: as funções puras
 * (linha de comando, hash, leitura do OperationOutcome) são exportadas para scripts/__tests__.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PASTA_ARTEFATOS = join(RAIZ, 'artifacts', 'rnds');

/** Versão do FHIR do guia (package.json do pacote: "fhirVersions": ["4.0.1"]). */
export const FHIR_VERSION = '4.0.1';

/**
 * Validador oficial da HL7, versão fixada. O hash vem do campo `digest` do asset na API de releases
 * do GitHub (https://api.github.com/repos/hapifhir/org.hl7.fhir.core/releases/tags/6.10.4, lido em
 * 24/09/2026); o script confere o arquivo baixado contra ele antes de executar qualquer coisa.
 */
export const VALIDADOR = Object.freeze({
  versao: '6.10.4',
  url: 'https://github.com/hapifhir/org.hl7.fhir.core/releases/download/6.10.4/validator_cli.jar',
  sha256: '1106b9d58f9e363e47bea7c4fc065841e5fc91fe9d062775c3bfdd212bd653cc',
  tamanho: 200_928_617,
  publicadoEm: '2026-09-04',
  arquivo: 'validator_cli-6.10.4.jar',
});

/**
 * Pacote do Guia de Implementação da RNDS. Nome e versão do package.json do próprio pacote
 * ("name": "rnds", "version": "1.0.0", build 14/12/2022); hash calculado no download de 24/09/2026 e
 * repetido em RndsProfiles.Guia.PacoteSha256 — o teste de contrato exige que os dois sejam iguais.
 */
export const PACOTE_GUIA = Object.freeze({
  nome: 'rnds',
  versao: '1.0.0',
  referencia: 'rnds#1.0.0',
  url: 'https://rnds-fhir.saude.gov.br/package.tgz',
  sha256: '2888bec577dd55c748c2b5aee70050a65b5e4e57c7464b7be23819410ab61bd8',
  arquivo: 'rnds-1.0.0.package.tgz',
});

/** API FHIR pública do projeto da RNDS no Simplifier (busca por canônica devolve um searchset). */
export const SIMPLIFIER_FHIR_API = 'https://fhir.simplifier.net/redenacionaldedadosemsaude';

/**
 * Definições que só existem no Simplifier (espaço de nomes http://www.saude.gov.br/fhir/r4/):
 * os perfis do RIA-Rotina e do RAC, o que eles referenciam e o cadastro/REL no mesmo espaço de nomes
 * (os exemplos do guia usam esta base, não a do pacote oficial). Cada URL foi lida no campo `url`
 * do recurso em 24/09/2026 e existe, com a mesma grafia, em RndsProfiles.cs (teste de contrato).
 */
export const DEFINICOES_SIMPLIFIER = Object.freeze([
  // cadastro
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRIndividuo-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BREstabelecimentoSaude-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRPessoaJuridicaProfissionalLiberal-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRProfissional-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRLotacaoProfissional-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRDocumentoIndividuo-1.0'],
  // RIA-Rotina (vigente e o par do exemplo do guia)
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRRegistroImunobiologicoAdministradoRotina-2.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRImunobiologicoAdministrado-3.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRRegistroImunobiologicoAdministradoRotina-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRImunobiologicoAdministrado-2.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BREstrategiaVacinacao-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BREstrategiaVacinacaoPesquisa-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRGrupoAtendimento'],
  // REL
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRResultadoExameLaboratorial-3.2.1'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRDiagnosticoLaboratorioClinico-3.2.1'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRAmostraBiologica-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRCondicaoSaude'],
  // RAC (rascunho no Simplifier; o guia ainda não publicou o modelo computacional)
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRRegistroAtendimentoClinico'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRConjuntoMinimoDados-1.1'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRContatoAssistencial-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRProblemaDiagnostico'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRProcedimentoRealizado-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRMedidaObservada'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRAlergiaReacaoAdversa-1.0'],
  ['StructureDefinition', 'http://www.saude.gov.br/fhir/r4/StructureDefinition/BRPlanoCuidados-1.0'],
  // terminologias que RIA e REL fixam como system
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BRTipoDocumento'],
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BRImunobiologico'],
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BRFabricantePNI'],
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BRLocalAplicacao'],
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BRViaAdministracao'],
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BREstrategiaVacinacao'],
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BRCBO'],
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BRDose'],
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BRGrupoAtendimento'],
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BRNomeExameLOINC'],
  ['CodeSystem', 'http://www.saude.gov.br/fhir/r4/CodeSystem/BRSubgrupoTabelaSUS'],
]);

const TIPOS_DEFINICAO = new Set(['StructureDefinition', 'CodeSystem', 'ValueSet']);

/* ─────────────────────────── funções puras (testadas) ─────────────────────────── */

/**
 * Monta a linha de comando do validador. Os alvos vêm antes das opções, como no exemplo do guia;
 * cada pacote/pasta vira um `-ig`; `-tx n/a` só quando pedido (sem terminologia o validador não
 * confere código nenhum, e isso tem de ser uma escolha explícita de quem roda).
 */
export function montarLinhaDeComando({ jar, alvos, pacotes, saida, tx = null, java = 'java', fhirVersion = FHIR_VERSION }) {
  if (!jar) throw new Error('jar do validador é obrigatório');
  if (!Array.isArray(alvos) || alvos.length === 0) throw new Error('informe ao menos um arquivo ou pasta para validar');
  if (!Array.isArray(pacotes) || pacotes.length === 0) throw new Error('informe ao menos um pacote/pasta de definições (-ig)');
  if (!saida) throw new Error('arquivo de saída (-output) é obrigatório');
  const args = ['-jar', jar, ...alvos, '-version', fhirVersion];
  for (const pacote of pacotes) args.push('-ig', pacote);
  args.push('-output', saida);
  if (tx) args.push('-tx', tx);
  return { comando: java, args };
}

/** SHA-256 em hexadecimal minúsculo de bytes em memória. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 de um arquivo, em fluxo (o jar tem 200 MB; não cabe ler tudo de uma vez). */
export async function sha256DoArquivo(caminho) {
  const hash = createHash('sha256');
  for await (const pedaco of createReadStream(caminho)) hash.update(pedaco);
  return hash.digest('hex');
}

/**
 * Compara hashes sem diferenciar maiúsculas e lança com os dois valores na mensagem: quem lê o
 * erro precisa ver o que veio e o que se esperava para decidir se a fonte mudou ou o download quebrou.
 */
export function conferirSha256(obtido, esperado, descricao = 'arquivo') {
  const a = String(obtido ?? '').trim().toLowerCase();
  const b = String(esperado ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(b)) throw new Error(`hash esperado de ${descricao} não é SHA-256 hexadecimal: "${esperado}"`);
  if (a !== b) {
    throw new Error(`SHA-256 de ${descricao} não confere.\n  obtido:   ${a || '(vazio)'}\n  esperado: ${b}`);
  }
  return true;
}

/** Arquivos .json de uma pasta (ou o próprio arquivo), em ordem estável. Não desce em subpastas. */
export function listarJsons(alvo) {
  const caminho = resolve(alvo);
  if (!existsSync(caminho)) throw new Error(`não encontrado: ${alvo}`);
  if (statSync(caminho).isFile()) return [caminho];
  return readdirSync(caminho)
    .filter((nome) => extname(nome).toLowerCase() === '.json')
    .sort((x, y) => x.localeCompare(y))
    .map((nome) => join(caminho, nome));
}

const SEVERIDADES_ERRO = new Set(['error', 'fatal']);

/**
 * Nome do arquivo a que um OperationOutcome se refere. O validador anota a origem numa extensão
 * do OperationOutcome cuja URL termina em "operationoutcome-file" (o nome exato não foi lido na
 * fonte, por isso o casamento é por sufixo); sem ela, cai na ordem em que os alvos foram passados.
 */
function arquivoDoOutcome(outcome, indice, alvos) {
  const ext = (outcome.extension ?? []).find((e) => typeof e?.url === 'string' && e.url.endsWith('operationoutcome-file'));
  if (ext && typeof ext.valueString === 'string' && ext.valueString) return ext.valueString;
  return alvos[indice] ?? `(recurso ${indice + 1})`;
}

/**
 * Resume a saída do validador: um OperationOutcome (um alvo) ou um Bundle de OperationOutcome
 * (vários alvos). Devolve por arquivo a lista de erros (severity error/fatal) e contagens de
 * avisos e informações; issues com código "informational" e severidade "information" que só dizem
 * "All OK" não contam como nada.
 */
export function resumirOperationOutcome(saida, alvos = []) {
  const documento = typeof saida === 'string' ? JSON.parse(saida) : saida;
  if (!documento || typeof documento !== 'object') throw new Error('saída do validador não é JSON de recurso');

  let outcomes;
  if (documento.resourceType === 'OperationOutcome') outcomes = [documento];
  else if (documento.resourceType === 'Bundle') {
    outcomes = (documento.entry ?? []).map((e) => e?.resource).filter((r) => r?.resourceType === 'OperationOutcome');
  } else throw new Error(`saída do validador inesperada: resourceType=${documento.resourceType}`);

  const porArquivo = outcomes.map((outcome, indice) => {
    const erros = [];
    let avisos = 0;
    let informacoes = 0;
    for (const issue of outcome.issue ?? []) {
      const severidade = String(issue.severity ?? '').toLowerCase();
      const texto = issue.details?.text ?? issue.diagnostics ?? '';
      if (SEVERIDADES_ERRO.has(severidade)) {
        erros.push({
          severidade,
          codigo: issue.code ?? '',
          caminho: (issue.expression ?? issue.location ?? []).join(' | '),
          mensagem: texto,
        });
      } else if (severidade === 'warning') avisos++;
      else if (severidade === 'information' && !/^all ok/i.test(texto)) informacoes++;
    }
    return { arquivo: arquivoDoOutcome(outcome, indice, alvos), erros, avisos, informacoes };
  });

  const totalErros = porArquivo.reduce((soma, item) => soma + item.erros.length, 0);
  return { porArquivo, totalErros, comErro: totalErros > 0 };
}

/** Texto do relatório: um bloco por arquivo, erros com caminho FHIRPath, e o total no fim. */
export function formatarRelatorio(resumo) {
  const linhas = [];
  for (const item of resumo.porArquivo) {
    const nome = basename(item.arquivo);
    if (item.erros.length === 0) {
      linhas.push(`OK    ${nome}  (avisos: ${item.avisos}, informações: ${item.informacoes})`);
      continue;
    }
    linhas.push(`ERRO  ${nome}  (${item.erros.length} erro(s), avisos: ${item.avisos})`);
    for (const erro of item.erros) {
      const onde = erro.caminho ? ` @ ${erro.caminho}` : '';
      linhas.push(`      [${erro.severidade}${erro.codigo ? '/' + erro.codigo : ''}]${onde}`);
      linhas.push(`        ${erro.mensagem}`);
    }
  }
  linhas.push(resumo.comErro ? `Total: ${resumo.totalErros} erro(s).` : 'Total: nenhum erro.');
  return linhas.join('\n');
}

/** Nome de arquivo estável para uma definição baixada do Simplifier: <Tipo>-<último segmento>.json. */
export function nomeArquivoDefinicao(tipo, url) {
  if (!TIPOS_DEFINICAO.has(tipo)) throw new Error(`tipo de definição não suportado: ${tipo}`);
  const segmento = url.split('/').filter(Boolean).at(-1);
  if (!segmento) throw new Error(`canônica sem caminho: ${url}`);
  return `${tipo}-${segmento.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

/** URL de busca por canônica na API do Simplifier. */
export function urlBuscaSimplifier(tipo, url, base = SIMPLIFIER_FHIR_API) {
  if (!TIPOS_DEFINICAO.has(tipo)) throw new Error(`tipo de definição não suportado: ${tipo}`);
  return `${base}/${tipo}?url=${encodeURIComponent(url)}`;
}

/**
 * Extrai o recurso de um searchset do Simplifier. Exige total 1 e que o `url` do recurso seja
 * exatamente a canônica pedida — uma busca que devolve outra coisa não pode virar definição.
 */
export function extrairDefinicaoDoSearchset(searchset, tipo, url) {
  const doc = typeof searchset === 'string' ? JSON.parse(searchset) : searchset;
  if (doc?.resourceType !== 'Bundle' || doc.type !== 'searchset') throw new Error(`resposta do Simplifier não é searchset para ${url}`);
  const recursos = (doc.entry ?? []).map((e) => e?.resource).filter(Boolean);
  const exato = recursos.find((r) => r.resourceType === tipo && r.url === url);
  if (!exato) throw new Error(`Simplifier não devolveu ${tipo} com url exatamente igual a ${url} (total=${doc.total ?? recursos.length})`);
  return exato;
}

/* ─────────────────────────── efeitos (não testados) ─────────────────────────── */

async function baixarParaArquivo(url, destino) {
  const resposta = await fetch(url, { redirect: 'follow' });
  if (!resposta.ok || !resposta.body) throw new Error(`download falhou: HTTP ${resposta.status} em ${url}`);
  const temporario = `${destino}.baixando`;
  await pipeline(Readable.fromWeb(resposta.body), createWriteStream(temporario));
  return temporario;
}

/**
 * Baixa só se não houver arquivo com o hash certo. Um arquivo existente com hash errado é apagado
 * antes de baixar de novo; um download com hash errado também é apagado — nunca fica no disco um
 * jar que ninguém conferiu.
 */
async function garantirArquivoConferido({ url, destino, sha256, descricao }) {
  mkdirSync(dirname(destino), { recursive: true });
  if (existsSync(destino)) {
    try {
      conferirSha256(await sha256DoArquivo(destino), sha256, descricao);
      return destino;
    } catch (erro) {
      console.warn(`${descricao}: ${erro.message}\n  apagando e baixando de novo.`);
      rmSync(destino, { force: true });
    }
  }
  console.log(`Baixando ${descricao} de ${url}`);
  const temporario = await baixarParaArquivo(url, destino);
  try {
    conferirSha256(await sha256DoArquivo(temporario), sha256, descricao);
  } catch (erro) {
    rmSync(temporario, { force: true });
    throw erro;
  }
  renameSync(temporario, destino);
  return destino;
}

/** Baixa as definições do Simplifier para a pasta; reaproveita o que já está lá (por nome). */
async function garantirDefinicoesSimplifier(pasta) {
  mkdirSync(pasta, { recursive: true });
  let baixadas = 0;
  for (const [tipo, url] of DEFINICOES_SIMPLIFIER) {
    const destino = join(pasta, nomeArquivoDefinicao(tipo, url));
    if (existsSync(destino)) continue;
    const resposta = await fetch(urlBuscaSimplifier(tipo, url), { headers: { Accept: 'application/fhir+json' } });
    if (!resposta.ok) throw new Error(`Simplifier respondeu HTTP ${resposta.status} para ${url}`);
    const recurso = extrairDefinicaoDoSearchset(await resposta.text(), tipo, url);
    writeFileSync(destino, JSON.stringify(recurso, null, 2) + '\n');
    baixadas++;
  }
  if (baixadas) console.log(`Definições do Simplifier: ${baixadas} baixada(s) em ${pasta}`);
  return pasta;
}

function lerOpcoes(argv) {
  const opcoes = { alvos: [], saida: join(PASTA_ARTEFATOS, 'validacao.json'), tx: null, semDefinicoes: false, soLinha: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--saida') opcoes.saida = resolve(argv[++i] ?? '');
    else if (arg === '--sem-tx') opcoes.tx = 'n/a';
    else if (arg === '--tx') opcoes.tx = argv[++i] ?? null;
    else if (arg === '--sem-definicoes-simplifier') opcoes.semDefinicoes = true;
    else if (arg === '--so-linha') opcoes.soLinha = true;
    else if (arg.startsWith('--')) throw new Error(`opção desconhecida: ${arg}`);
    else opcoes.alvos.push(arg);
  }
  if (opcoes.alvos.length === 0) throw new Error('uso: node scripts/rnds/validate-fhir.mjs <pasta-ou-arquivo.json>... [--saida f] [--sem-tx] [--tx url] [--sem-definicoes-simplifier] [--so-linha]');
  return opcoes;
}

async function main() {
  const opcoes = lerOpcoes(process.argv.slice(2));
  const alvos = opcoes.alvos.flatMap(listarJsons);
  if (alvos.length === 0) throw new Error('nenhum .json encontrado nos alvos informados');

  const jar = join(PASTA_ARTEFATOS, VALIDADOR.arquivo);
  const pacote = join(PASTA_ARTEFATOS, PACOTE_GUIA.arquivo);
  const pastaSimplifier = join(PASTA_ARTEFATOS, 'definicoes-simplifier');
  const pacotes = opcoes.semDefinicoes ? [pacote] : [pacote, pastaSimplifier];
  const linha = montarLinhaDeComando({ jar, alvos, pacotes, saida: opcoes.saida, tx: opcoes.tx });

  if (opcoes.soLinha) {
    console.log([linha.comando, ...linha.args].join(' '));
    return;
  }

  await garantirArquivoConferido({ url: VALIDADOR.url, destino: jar, sha256: VALIDADOR.sha256, descricao: `validator_cli.jar ${VALIDADOR.versao}` });
  await garantirArquivoConferido({ url: PACOTE_GUIA.url, destino: pacote, sha256: PACOTE_GUIA.sha256, descricao: `pacote ${PACOTE_GUIA.referencia}` });
  if (!opcoes.semDefinicoes) await garantirDefinicoesSimplifier(pastaSimplifier);

  mkdirSync(dirname(opcoes.saida), { recursive: true });
  rmSync(opcoes.saida, { force: true });
  console.log(`Validando ${alvos.length} arquivo(s) com FHIR ${FHIR_VERSION}, -ig ${pacotes.join(' -ig ')}`);
  // O validador escreve o progresso em stdout; deixamos passar para quem roda ver o carregamento
  // dos pacotes (que demora) e decidir se está travado ou só lento.
  const execucao = spawnSync(linha.comando, linha.args, { stdio: 'inherit', maxBuffer: 64 * 1024 * 1024 });
  if (execucao.error) {
    if (execucao.error.code === 'ENOENT') throw new Error('java não encontrado no PATH; instale um JRE 11+ ou aponte JAVA_HOME/bin no PATH');
    throw execucao.error;
  }

  if (!existsSync(opcoes.saida)) {
    // Sem OperationOutcome não há o que relatar por arquivo: o validador caiu antes de validar
    // (pacote inválido, sem rede para hl7.fhir.r4.core, JVM sem memória). O código de saída dele é a
    // única pista, e 0 aqui seria mentira.
    console.error(`O validador terminou com código ${execucao.status} sem gravar ${opcoes.saida}.`);
    process.exitCode = execucao.status || 1;
    return;
  }

  const resumo = resumirOperationOutcome(readFileSync(opcoes.saida, 'utf8'), alvos);
  console.log('');
  console.log(formatarRelatorio(resumo));
  console.log(`OperationOutcome completo em ${opcoes.saida}`);
  if (resumo.comErro || (execucao.status ?? 0) !== 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((erro) => {
    console.error(erro.message ?? erro);
    process.exitCode = 1;
  });
}
