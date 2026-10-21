#!/usr/bin/env node
/**
 * StarMed Fase 6 — gate do VALIDADOR OFICIAL da HL7 sobre as fixtures FHIR
 * sintéticas do StarMed (ST-P1-009/010). UX espelhada de validate-fhir.mjs:
 *
 *   node scripts/rnds/validate-official.mjs [opções]
 *
 *   --jar <path>                usa este validator_cli.jar (padrão: env
 *                               FHIR_VALIDATOR_JAR ou .cache/fhir-validator/validator_cli.jar)
 *   --fixtures-dir <dir>        pasta das fixtures (padrão: scripts/rnds/fixtures/fhir)
 *   --saida-dir <dir>           onde gravar os OperationOutcome XML (padrão: .cache/fhir-validator)
 *   --so-linha                  imprime as linhas de comando e sai (não baixa, não roda java)
 *   --aceitar-jar-nao-pinado    NÃO confere o sha256 do jar (escape explícito; CI NÃO usa)
 *
 * O que ele faz, na ordem:
 *   1. localiza o jar: --jar > FHIR_VALIDATOR_JAR > cache .cache/fhir-validator/;
 *   2. SEM jar em cache → baixa da release PINADA 7.0.2 do hapifhir/org.hl7.fhir.core
 *      (204.412.235 bytes; sha256 e3e50f06…2b377) e CONFERE o sha256 em fluxo —
 *      divergência ⇒ apaga e falha FECHADA ("jar que ninguém conferiu" não roda);
 *   3. roda `java -jar <jar> -version 4.0.1 -output <saida-dir>/out-<n>.xml <fixture>`
 *      para CADA fixture positiva: exit ≠ 0 ⇒ FAIL;
 *   4. roda o mesmo para a fixture NEGATIVA (fixtures/fhir/invalid/): exit 0 ⇒
 *      FAIL "gate inoperante" (uma inválida aceita significa gate morto);
 *   5. imprime resumo no stdout (APENAS nomes de arquivo e códigos — sem PHI)
 *      e sai com exit code agregado (0 só se tudo passou).
 *
 * Java ausente ⇒ erro claro (JRE 17+ exigido pelo validador 7.x; o CI instala
 * via setup-java e restaura o cache .cache/fhir-validator). Nada disso roda
 * nos testes npm: as funções puras são exportadas para scripts/__tests__.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = join(RAIZ, '.cache', 'fhir-validator');
export const FIXTURES_PADRAO = join(RAIZ, 'scripts', 'rnds', 'fixtures', 'fhir');

/** Versão do FHIR alvo (base R4; as fixtures NÃO usam perfis da RNDS). */
export const FHIR_VERSION = '4.0.1';

/**
 * Validador oficial, release PINADA. sha256 e tamanho conferidos contra o
 * asset publicado (hapifhir/org.hl7.fhir.core tag 7.0.2, validator_cli.jar);
 * qualquer divergência apaga o arquivo e aborta — fail closed por design.
 */
export const VALIDADOR = Object.freeze({
  versao: '7.0.2',
  url: 'https://github.com/hapifhir/org.hl7.fhir.core/releases/download/7.0.2/validator_cli.jar',
  bytes: 204412235,
  sha256: 'e3e50f06b806437821b7aef8189a1b790415cb96c5036e0812ed62981452b377',
  arquivo: 'validator_cli-7.0.2.jar'
});

/** SHA-256 hex de um arquivo em fluxo (o jar tem ~200 MB). */
export async function sha256DoArquivo(caminho) {
  const hash = createHash('sha256');
  for await (const pedaco of createReadStream(caminho)) hash.update(pedaco);
  return hash.digest('hex');
}

/**
 * Pura: classifica as fixtures — positivas (JSON direto na pasta) e negativas
 * (subpasta invalid/, que DEVE falhar no validador).
 */
export function classificarFixtures(dir) {
  const positivas = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => join(dir, e.name))
    .sort();
  const invalidDir = join(dir, 'invalid');
  const negativas = existsSync(invalidDir)
    ? readdirSync(invalidDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => join(invalidDir, e.name))
        .sort()
    : [];
  return { positivas, negativas };
}

/** Pura: linha de comando do validador (mesma forma usada pelo guia da RNDS). */
export function montarLinhaDeComando({ jar, fixture, saida, java = 'java' }) {
  if (!jar) throw new Error('jar do validador é obrigatório');
  if (!fixture) throw new Error('fixture é obrigatória');
  return { comando: java, args: ['-jar', jar, '-version', FHIR_VERSION, '-output', saida, fixture] };
}

export function lerOpcoes(argv) {
  const opcoes = {
    jar: null,
    fixturesDir: FIXTURES_PADRAO,
    saidaDir: CACHE_DIR,
    soLinha: false,
    conferirHash: true
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--jar') opcoes.jar = resolve(argv[++i] ?? '');
    else if (arg === '--fixtures-dir') opcoes.fixturesDir = resolve(argv[++i] ?? '');
    else if (arg === '--saida-dir') opcoes.saidaDir = resolve(argv[++i] ?? '');
    else if (arg === '--so-linha') opcoes.soLinha = true;
    else if (arg === '--aceitar-jar-nao-pinado') opcoes.conferirHash = false;
    else throw new Error(`opção desconhecida: ${arg}`);
  }
  return opcoes;
}

/** Baixa o jar pinado para o cache e confere tamanho + sha256 (fail closed). */
export async function garantirJarConferido(destino) {
  mkdirSync(dirname(destino), { recursive: true });
  console.log(`Baixando validator_cli.jar ${VALIDADOR.versao} (release pinada)…`);
  const resposta = await fetch(VALIDADOR.url);
  if (!resposta.ok || !resposta.body) throw new Error(`download falhou: HTTP ${resposta.status} em ${VALIDADOR.url}`);
  await pipeline(Readable.fromWeb(resposta.body), createWriteStream(destino));
  const tamanho = statSync(destino).size;
  if (tamanho !== VALIDADOR.bytes) {
    rmSync(destino, { force: true });
    throw new Error(`tamanho divergente (${tamanho} ≠ ${VALIDADOR.bytes} bytes) — jar apagado, nada roda`);
  }
  const sha = await sha256DoArquivo(destino);
  if (sha !== VALIDADOR.sha256) {
    rmSync(destino, { force: true });
    throw new Error(`sha256 divergente (${sha} ≠ ${VALIDADOR.sha256}) — jar apagado, nada roda`);
  }
  console.log(`Jar conferido: sha256 ${sha} (${tamanho} bytes).`);
  return destino;
}

async function main() {
  const opcoes = lerOpcoes(process.argv.slice(2));
  const { positivas, negativas } = classificarFixtures(opcoes.fixturesDir);
  if (positivas.length === 0) throw new Error(`nenhuma fixture positiva em ${opcoes.fixturesDir}`);
  if (negativas.length === 0) {
    throw new Error(`fixture NEGATIVA ausente em ${join(opcoes.fixturesDir, 'invalid')} — o gate negativo é obrigatório`);
  }

  const jar = opcoes.jar ?? process.env.FHIR_VALIDATOR_JAR ?? join(CACHE_DIR, VALIDADOR.arquivo);
  const alvos = [
    ...positivas.map((fixture, i) => ({ fixture, esperadoFalha: false, saida: join(opcoes.saidaDir, `out-pos-${i}.xml`) })),
    ...negativas.map((fixture, i) => ({ fixture, esperadoFalha: true, saida: join(opcoes.saidaDir, `out-neg-${i}.xml`) }))
  ];

  if (opcoes.soLinha) {
    for (const alvo of alvos) console.log(JSON.stringify(montarLinhaDeComando(alvo)));
    return;
  }

  if (!existsSync(jar)) await garantirJarConferido(jar);
  else if (opcoes.conferirHash) {
    const sha = await sha256DoArquivo(jar);
    if (sha !== VALIDADOR.sha256) {
      throw new Error(
        `jar em ${jar} não confere com o pin 7.0.2 (sha256 ${sha} ≠ ${VALIDADOR.sha256}) — ` +
          'aponte --jar para o jar pinado ou use --aceitar-jar-nao-pinado deliberadamente'
      );
    }
  }

  mkdirSync(opcoes.saidaDir, { recursive: true });
  const resultados = [];
  for (const alvo of alvos) {
    rmSync(alvo.saida, { force: true });
    const linha = montarLinhaDeComando({ jar, fixture: alvo.fixture, saida: alvo.saida });
    console.log(`\n>> ${linha.comando} ${linha.args.join(' ')}`);
    const execucao = spawnSync(linha.comando, linha.args, { stdio: 'inherit', maxBuffer: 64 * 1024 * 1024 });
    if (execucao.error) {
      if (execucao.error.code === 'ENOENT') {
        throw new Error('java não encontrado no PATH; instale um JRE 17+ (o CI usa setup-java) e rode de novo');
      }
      throw execucao.error;
    }
    const exitCode = execucao.status ?? 1;
    const nome = alvo.fixture.split(/[\\/]/).slice(-2).join('/');
    const ok = alvo.esperadoFalha ? exitCode !== 0 : exitCode === 0;
    resultados.push({ nome, esperadoFalha: alvo.esperadoFalha, exitCode, ok });
  }

  console.log('\n==== Resumo do gate do validador oficial (sem PHI — só nomes e códigos) ====');
  let falhas = 0;
  for (const r of resultados) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    if (!r.ok) falhas++;
    const detalhe = r.esperadoFalha
      ? r.ok
        ? `recusada como esperado (exit ${r.exitCode})`
        : `GATE INOPERANTE: inválida aceita (exit ${r.exitCode})`
      : r.ok
        ? `validada (exit ${r.exitCode})`
        : `rejeitada pelo validador (exit ${r.exitCode})`;
    console.log(`${tag}  ${r.nome}  —  ${detalhe}`);
  }
  console.log(
    `Fixtures: ${resultados.filter((r) => !r.esperadoFalha).length} positiva(s), ` +
      `${resultados.filter((r) => r.esperadoFalha).length} negativa(s); ${falhas} falha(s).`
  );
  if (falhas > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((erro) => {
    console.error(erro.message ?? erro);
    process.exitCode = 1;
  });
}
