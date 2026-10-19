// StarMed interop — TISS 4.01.00 builder (PURE module).
//
// Estrutura conforme o esquema OFICIAL da ANS em schemas/tiss/4.01.00/
// (Padrão TISS Comunicação 04.01.00, veja FONTE.md — hashes SHA-256 conferidos):
//   mensagemTISS → cabecalho (identificacaoTransacao, origem, destino, Padrao)
//               → prestadorParaOperadora → loteGuias (numeroLote, guiasTISS)
//               → epilogo (hash de integridade do documento)
// guiasTISS aceita guiaConsulta (ctm_consultaGuia, máx. 100) para solicitação de consulta.
// Namespace canônico: http://www.ans.gov.br/padroes/tiss/schemas (elementFormDefault=qualified).
// O XML é validável contra tissV4_01_00.xsd — ver scripts/tiss/validate-tiss.ps1.
// Nota: dm_UF usa CÓDIGO IBGE (2 dígitos, ex.: SP=35), não sigla.

import { createHash } from 'node:crypto';

export const TISS_NAMESPACE = 'http://www.ans.gov.br/padroes/tiss/schemas';
export const TISS_VERSION = '4.01.00';

export type TissConsultaInput = {
  loteId: string;
  sequencialTransacao: string;          // st_texto12
  dataRegistro: string;                 // st_data (YYYY-MM-DD)
  horaRegistro: string;                 // st_hora (HH:MM:SS)
  prestador: { cnpj: string };          // ct_prestadorIdentificacao (origem)
  registroAnsOperadora: string;         // st_registroANS (6 dígitos, destino)
  numeroGuiaPrestador: string;          // st_texto20
  beneficiario: { numeroCarteira: string; atendimentoRN: 'S' | 'N' };
  contratadoExecutante: { cnpj: string; cnes: string };   // CNES st_texto7
  profissionalExecutante: {
    nome?: string;                      // st_texto70 opcional
    conselho: string;                   // dm_conselhoProfissional (2 dígitos, CRM=02)
    numeroRegistro: string;             // st_texto15
    uf: string;                         // dm_UF = código IBGE (2 dígitos)
    cbos: string;                       // dm_CBOS (6 dígitos)
  };
  indicacaoAcidente: '0' | '1' | '2' | '9';  // dm_indicadorAcidente
  atendimento: {
    regime: '01' | '02' | '03' | '04' | '05';  // dm_regimeAtendimento (01 ambulatorial…05 telessaúde)
    data: string;                       // st_data
    tipoConsulta: '1' | '2' | '3' | '4';       // dm_tipoConsulta (1ª/segui./pré-natal/encam.)
  };
  procedimento: {
    codigoTabela: '18' | '19' | '20' | '22' | '90' | '98' | '00';  // dm_tabela (22=procedimentos)
    codigo: string;                     // st_texto10 (TUSS)
    valor: number;                      // st_decimal8-2
  };
};

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function escapeXml(value: string): string {
  return String(value).replace(/[&<>"']/g, char => XML_ESCAPES[char]);
}

function money(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('TISS: valor do procedimento inválido');
  return value.toFixed(2);
}

function validate(input: TissConsultaInput): void {
  const errors: string[] = [];
  if (!/^\d{1,12}$/.test(input.sequencialTransacao)) errors.push('sequencialTransacao deve ser numérico (st_texto12)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dataRegistro)) errors.push('dataRegistro deve ser YYYY-MM-DD');
  if (!/^\d{2}:\d{2}:\d{2}$/.test(input.horaRegistro)) errors.push('horaRegistro deve ser HH:MM:SS');
  if (!/^\d{14}$/.test(input.prestador.cnpj)) errors.push('prestador.cnpj deve ter 14 dígitos');
  if (!/^\d{6}$/.test(input.registroAnsOperadora)) errors.push('registroAnsOperadora deve ter 6 dígitos');
  if (!/^\d{1,20}$/.test(input.numeroGuiaPrestador)) errors.push('numeroGuiaPrestador numérico (st_texto20)');
  if (!/^[\w\-]{1,20}$/.test(input.beneficiario.numeroCarteira)) errors.push('numeroCarteira (st_texto20)');
  if (!/^\d{14}$/.test(input.contratadoExecutante.cnpj)) errors.push('contratadoExecutante.cnpj deve ter 14 dígitos');
  if (!/^\d{1,7}$/.test(input.contratadoExecutante.cnes)) errors.push('CNES numérico (st_texto7)');
  if (!/^\d{2}$/.test(input.profissionalExecutante.conselho)) errors.push('conselho deve ter 2 dígitos (dm_conselhoProfissional, CRM=02)');
  if (!/^\d{1,15}$/.test(input.profissionalExecutante.numeroRegistro)) errors.push('numeroRegistro do profissional numérico (st_texto15)');
  if (!/^\d{2}$/.test(input.profissionalExecutante.uf)) errors.push('uf deve ser código IBGE de 2 dígitos (dm_UF)');
  if (!/^\d{6}$/.test(input.profissionalExecutante.cbos)) errors.push('cbos deve ter 6 dígitos (dm_CBOS)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.atendimento.data)) errors.push('atendimento.data deve ser YYYY-MM-DD');
  if (!/^\d{1,10}$/.test(input.procedimento.codigo)) errors.push('procedimento.codigo numérico (st_texto10)');
  if (errors.length) throw new Error('TISS: entrada inválida — ' + errors.join('; '));
}

function guiaConsultaXml(guide: TissConsultaInput, ns: string): string {
  const p = guide.profissionalExecutante;
  return [
    `    <${ns}:guiaConsulta>`,
    `      <${ns}:cabecalhoConsulta>`,
    `        <${ns}:registroANS>${escapeXml(guide.registroAnsOperadora)}</${ns}:registroANS>`,
    `        <${ns}:numeroGuiaPrestador>${escapeXml(guide.numeroGuiaPrestador)}</${ns}:numeroGuiaPrestador>`,
    `      </${ns}:cabecalhoConsulta>`,
    `      <${ns}:dadosBeneficiario>`,
    `        <${ns}:numeroCarteira>${escapeXml(guide.beneficiario.numeroCarteira)}</${ns}:numeroCarteira>`,
    `        <${ns}:atendimentoRN>${guide.beneficiario.atendimentoRN}</${ns}:atendimentoRN>`,
    `      </${ns}:dadosBeneficiario>`,
    `      <${ns}:contratadoExecutante>`,
    `        <${ns}:cnpjContratado>${escapeXml(guide.contratadoExecutante.cnpj)}</${ns}:cnpjContratado>`,
    `        <${ns}:CNES>${escapeXml(guide.contratadoExecutante.cnes)}</${ns}:CNES>`,
    `      </${ns}:contratadoExecutante>`,
    `      <${ns}:profissionalExecutante>`,
    p.nome ? `        <${ns}:nomeProfissional>${escapeXml(p.nome)}</${ns}:nomeProfissional>` : null,
    `        <${ns}:conselhoProfissional>${escapeXml(p.conselho)}</${ns}:conselhoProfissional>`,
    `        <${ns}:numeroConselhoProfissional>${escapeXml(p.numeroRegistro)}</${ns}:numeroConselhoProfissional>`,
    `        <${ns}:UF>${escapeXml(p.uf)}</${ns}:UF>`,
    `        <${ns}:CBOS>${escapeXml(p.cbos)}</${ns}:CBOS>`,
    `      </${ns}:profissionalExecutante>`,
    `      <${ns}:indicacaoAcidente>${guide.indicacaoAcidente}</${ns}:indicacaoAcidente>`,
    `      <${ns}:dadosAtendimento>`,
    `        <${ns}:regimeAtendimento>${guide.atendimento.regime}</${ns}:regimeAtendimento>`,
    `        <${ns}:dataAtendimento>${escapeXml(guide.atendimento.data)}</${ns}:dataAtendimento>`,
    `        <${ns}:tipoConsulta>${guide.atendimento.tipoConsulta}</${ns}:tipoConsulta>`,
    `        <${ns}:procedimento>`,
    `          <${ns}:codigoTabela>${guide.procedimento.codigoTabela}</${ns}:codigoTabela>`,
    `          <${ns}:codigoProcedimento>${escapeXml(guide.procedimento.codigo)}</${ns}:codigoProcedimento>`,
    `          <${ns}:valorProcedimento>${money(guide.procedimento.valor)}</${ns}:valorProcedimento>`,
    `        </${ns}:procedimento>`,
    `      </${ns}:dadosAtendimento>`,
    `    </${ns}:guiaConsulta>`
  ].filter((line): line is string => line !== null).join('\n');
}

/**
 * Monta uma mensagemTISS 4.01.00 de ENVIO_LOTE_GUIAS com N guias de consulta.
 * Determinístico para um mesmo input (hashes de lote estáveis).
 * O epilogo/hash recebe o SHA-256 do documento sem o próprio epilogo (integridade local;
 * a operadora valida contra o hash MD5 do conteúdo — plugar quando o canal exigir).
 */
export function buildTissLote(guides: TissConsultaInput[]): string {
  if (guides.length === 0) throw new Error('TISS: lote sem guias');
  if (guides.length > 100) throw new Error('TISS: máximo de 100 guias por lote (guiaConsulta maxOccurs=100)');
  const first = guides[0];
  for (const g of guides) {
    if (g.prestador.cnpj !== first.prestador.cnpj) throw new Error('TISS: lote deve ter um único prestador');
    if (g.registroAnsOperadora !== first.registroAnsOperadora) throw new Error('TISS: lote deve ter uma única operadora');
  }
  validate(first);
  const ns = 'tiss';
  const guias = guides.map(g => guiaConsultaXml(g, ns)).join('\n');
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${ns}:mensagemTISS xmlns:${ns}="${TISS_NAMESPACE}">`,
    `  <${ns}:cabecalho>`,
    `    <${ns}:identificacaoTransacao>`,
    `      <${ns}:tipoTransacao>ENVIO_LOTE_GUIAS</${ns}:tipoTransacao>`,
    `      <${ns}:sequencialTransacao>${escapeXml(first.sequencialTransacao)}</${ns}:sequencialTransacao>`,
    `      <${ns}:dataRegistroTransacao>${escapeXml(first.dataRegistro)}</${ns}:dataRegistroTransacao>`,
    `      <${ns}:horaRegistroTransacao>${escapeXml(first.horaRegistro)}</${ns}:horaRegistroTransacao>`,
    `    </${ns}:identificacaoTransacao>`,
    `    <${ns}:origem>`,
    `      <${ns}:identificacaoPrestador>`,
    `        <${ns}:CNPJ>${escapeXml(first.prestador.cnpj)}</${ns}:CNPJ>`,
    `      </${ns}:identificacaoPrestador>`,
    `    </${ns}:origem>`,
    `    <${ns}:destino>`,
    `      <${ns}:registroANS>${escapeXml(first.registroAnsOperadora)}</${ns}:registroANS>`,
    `    </${ns}:destino>`,
    `    <${ns}:Padrao>${TISS_VERSION}</${ns}:Padrao>`,
    `  </${ns}:cabecalho>`,
    `  <${ns}:prestadorParaOperadora>`,
    `    <${ns}:loteGuias>`,
    `      <${ns}:numeroLote>${escapeXml(first.loteId)}</${ns}:numeroLote>`,
    `      <${ns}:guiasTISS>`,
    guias,
    `      </${ns}:guiasTISS>`,
    `    </${ns}:loteGuias>`,
    `  </${ns}:prestadorParaOperadora>`,
    `  <${ns}:epilogo>`,
    `    <${ns}:hash>__HASH__</${ns}:hash>`,
    `  </${ns}:epilogo>`,
    `</${ns}:mensagemTISS>`
  ].join('\n');
  const hash = createHash('sha256').update(body, 'utf8').digest('hex');
  return body.replace('__HASH__', hash);
}

/** Compat: uma única guia vira um lote de 1. */
export function buildTissConsulta(input: TissConsultaInput): string {
  return buildTissLote([input]);
}

/** sha256 (hex) de um documento TISS (integridade do lote fora do canal). */
export function extractLoteHash(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex');
}
