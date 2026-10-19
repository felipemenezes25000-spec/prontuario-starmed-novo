// StarMed interop — TISS (Troca de Informação em Saúde Suplementar) builder (PURE module).
//
// NOTE: this builder targets the TISS ~3.01 layout referenced by
// tissConsultasTiss/v3/tissConsultas.xsd (ANS). The official ANS XSD is PENDING validation —
// only the structural reference of that schema is enforced here (CabecalhoTPrestacao,
// GuiaSolicitacaoConsultas with CabecalhoGuia/DadosBeneficiario/DadosSolicitante/DadosProcedimento).
// Do not treat the output as certified until it is validated against the published ANS XSD.

import { createHash } from 'node:crypto';

export type TissConsultaInput = {
  loteId: string;
  prestador: { cnpj: string; registroAns: string };
  beneficiario: { numeroCarteira: string; nome: string; nascimento: string };
  procedimento: { codigoTUSS: string; dataExecucao: string; valor: number };
  solicitante: { nome: string; conselho: string; numeroRegistro: string };
};

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function escapeXml(value: string): string {
  return String(value).replace(/[&<>"']/g, char => XML_ESCAPES[char]);
}

function money(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('TISS: valor do procedimento inválido');
  return value.toFixed(2);
}

/**
 * Builds a TISS GuiaSolicitacaoConsultas document (single guide) as an XML string.
 * Output is deterministic for a given input so lote hashes are stable.
 */
export function buildTissConsulta(input: TissConsultaInput): string {
  const { loteId, prestador, beneficiario, procedimento, solicitante } = input;
  const valor = money(procedimento.valor);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tiss:tourFeConteudoMedico xmlns:tiss="http://www.ans.gov.br/padroes/tiss" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.ans.gov.br/padroes/tiss ../xsd/tissConsultasTiss/v3/tissConsultas.xsd">',
    '  <tiss:cabecalhoTPrestacao>',
    '    <tiss:dadosANS>',
    `      <tiss:numeroRegistroANS>${escapeXml(prestador.registroAns)}</tiss:numeroRegistroANS>`,
    `      <tiss:cnpjCartaoANS>${escapeXml(prestador.cnpj)}</tiss:cnpjCartaoANS>`,
    '    </tiss:dadosANS>',
    '    <tiss:prestador>',
    `      <tiss:cnpjPrestador>${escapeXml(prestador.cnpj)}</tiss:cnpjPrestador>`,
    `      <tiss:registroANS>${escapeXml(prestador.registroAns)}</tiss:registroANS>`,
    '    </tiss:prestador>',
    '  </tiss:cabecalhoTPrestacao>',
    '  <tiss:guias>',
    '    <tiss:guiaSolicitacaoConsultas>',
    '      <tiss:cabecalhoGuia>',
    `        <tiss:numeroGuiaBeneficiario>${escapeXml(loteId)}</tiss:numeroGuiaBeneficiario>`,
    `        <tiss:numeroGuiaPrestador>${escapeXml(loteId)}</tiss:numeroGuiaPrestador>`,
    `        <tiss:cnpjCartaoANS>${escapeXml(prestador.cnpj)}</tiss:cnpjCartaoANS>`,
    `        <tiss:dataEmissaoGuia>${escapeXml(procedimento.dataExecucao)}</tiss:dataEmissaoGuia>`,
    '      </tiss:cabecalhoGuia>',
    '      <tiss:dadosBeneficiario>',
    `        <tiss:numeroCarteira>${escapeXml(beneficiario.numeroCarteira)}</tiss:numeroCarteira>`,
    `        <tiss:nomeBeneficiario>${escapeXml(beneficiario.nome)}</tiss:nomeBeneficiario>`,
    `        <tiss:dataNascimento>${escapeXml(beneficiario.nascimento)}</tiss:dataNascimento>`,
    '      </tiss:dadosBeneficiario>',
    '      <tiss:dadosSolicitante>',
    '        <tiss:contratadoSolicitante>',
    `          <tiss:nomeContratado>${escapeXml(solicitante.nome)}</tiss:nomeContratado>`,
    '          <tiss:conselhoProfissional>',
    `            <tiss:conselho>${escapeXml(solicitante.conselho)}</tiss:conselho>`,
    `            <tiss:numeroRegistro>${escapeXml(solicitante.numeroRegistro)}</tiss:numeroRegistro>`,
    '          </tiss:conselhoProfissional>',
    '        </tiss:contratadoSolicitante>',
    '      </tiss:dadosSolicitante>',
    '      <tiss:dadosProcedimento>',
    '        <tiss:procedimento>',
    `          <tiss:codigoTUSS>${escapeXml(procedimento.codigoTUSS)}</tiss:codigoTUSS>`,
    '          <tiss:quantidade>1</tiss:quantidade>',
    `          <tiss:valorUnitario>${valor}</tiss:valorUnitario>`,
    `          <tiss:valorTotal>${valor}</tiss:valorTotal>`,
    '        </tiss:procedimento>',
    `        <tiss:dataExecucao>${escapeXml(procedimento.dataExecucao)}</tiss:dataExecucao>`,
    '      </tiss:dadosProcedimento>',
    '    </tiss:guiaSolicitacaoConsultas>',
    '  </tiss:guias>',
    '</tiss:tourFeConteudoMedico>'
  ].join('\n');
}

export type TissLote = { xml: string; hash: string };

/** Builds a multi-guide TISS lote (<tiss:lot>) plus its sha256 hash. */
export function buildTissLote(guides: TissConsultaInput[]): TissLote {
  if (guides.length === 0) throw new Error('TISS: lote sem guias');
  const body = guides
    .map(guide => buildTissConsulta(guide)
      .split('\n')
      .filter(line => !line.startsWith('<?xml') && !line.startsWith('<tiss:tourFeConteudoMedico') && !line.startsWith('</tiss:tourFeConteudoMedico'))
      .map(line => '  ' + line)
      .join('\n'))
    .join('\n');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tiss:lot xmlns:tiss="http://www.ans.gov.br/padroes/tiss" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    body,
    '</tiss:lot>'
  ].join('\n');
  return { xml, hash: extractLoteHash(xml) };
}

/** sha256 (hex) of a TISS document, used as the lote integrity hash. */
export function extractLoteHash(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex');
}
