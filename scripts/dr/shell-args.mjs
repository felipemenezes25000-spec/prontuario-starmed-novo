/**
 * Guarda contra a armadilha do `spawnSync(..., { shell: true })` no Windows.
 *
 * Com `shell: false` (Linux/macOS) o Node entrega cada elemento de `args` como um
 * argumento separado, espacos inclusive. Com `shell: true` ele JUNTA tudo numa linha de
 * comando e deixa o shell separar de novo — sem aspas. O resultado e que qualquer
 * argumento com espaco vira varios.
 *
 * Foi assim que o canary do restore drill parou de rodar: o SQL passado em
 * `psql -c "CREATE TABLE ...; INSERT ..."` chegou ao psql como dezenas de argumentos
 * soltos, e o comando morreu com `syntax error at end of input`. No Linux o mesmo codigo
 * funciona, entao o CI nunca viu.
 *
 * A correcao de fundo e nao passar texto com espaco por argumento: SQL vai por stdin
 * (`docker exec -i ... psql`), arquivo vai por caminho sem espaco. Esta funcao existe para
 * a proxima ocorrencia falhar alto, na hora, com o argumento culpado no erro — em vez de
 * virar um comando truncado cujo output ninguem le.
 */

/** Caracteres que o shell trata como separador ou operador. */
const PERIGOSOS = /[\s"'`$&|<>^%()!]/;

/**
 * @param {readonly string[]} args
 * @param {{ command?: string, shell?: boolean }} [opcoes]
 * @throws {Error} quando algum argumento seria remontado errado pelo shell
 */
export function assertShellSafeArgs(args, opcoes = {}) {
  const { command = 'comando', shell = true } = opcoes;
  if (!shell) return;

  const culpados = args
    .map((arg, indice) => ({ arg, indice }))
    .filter(({ arg }) => typeof arg === 'string' && PERIGOSOS.test(arg));

  if (culpados.length === 0) return;

  const lista = culpados.map(({ arg, indice }) => `  [${indice}] ${JSON.stringify(arg)}`).join('\n');
  throw new Error(
    `${command}: argumento com caractere de shell sendo passado com shell:true.\n${lista}\n` +
      'Com shell:true o Node nao poe aspas, e o shell reparte o argumento. ' +
      'Passe o conteudo por stdin (ex.: `docker exec -i ... psql` lendo o SQL da entrada) ' +
      'ou use um caminho sem espacos.',
  );
}
