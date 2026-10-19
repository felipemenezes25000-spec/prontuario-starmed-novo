// StarMed interop — NFSe emission preview, ABRASF v2 layout (PURE module).
// Structural reference only: ABRASF "gerarNfse" envelope with InfNfse containing
// prestador / tomador / servico / valores / competencia and identificacaoEmitente.
// No tax calculation (INSS/ISS math) is performed here — only value pass-through
// and the ISS retention flag (issRetido) rendered per field.

import { createHash } from 'node:crypto';

export type NfseInput = {
  prestador: { cnpj: string; im: string };
  tomador: { cnpjCpf: string; razao: string; endereco: string };
  servico: { codigoMunicipio: string; itemLista: string; aliquota: number; valorLiquidoNfse: number; issRetido?: boolean };
  competencia: string;
  numero: number | string;
};

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Escapes the five mandatory XML characters. */
export function sanitizeXml(value: string): string {
  return String(value).replace(/[&<>"']/g, char => XML_ESCAPES[char]);
}

function decimal(value: number, field: string): string {
  if (!Number.isFinite(value)) throw new Error(`NFSe: ${field} inválida`);
  return value.toFixed(2);
}

/** Builds an ABRASF v2 gerarNfse document (emission preview) as an XML string. */
export function buildNfseEmissao(input: NfseInput): string {
  const { prestador, tomador, servico, competencia, numero } = input;
  const valor = decimal(servico.valorLiquidoNfse, 'valorLiquidoNfse');
  const aliquota = decimal(servico.aliquota, 'aliquota');
  const issRetido = servico.issRetido ? '1' : '0';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gerarNfse xmlns="http://www.abrasf.org.br/nfse.xsd">',
    '  <nfse>',
    `    <InfNfse Id="NFSe${sanitizeXml(String(numero))}">`,
    `      <numero>${sanitizeXml(String(numero))}</numero>`,
    '      <valoresNfse>',
    `        <baseCalculo>${valor}</baseCalculo>`,
    `        <aliquota>${aliquota}</aliquota>`,
    `        <issRetido>${issRetido}</issRetido>`,
    `        <valorLiquidoNfse>${valor}</valorLiquidoNfse>`,
    '      </valoresNfse>',
    '      <prestador>',
    `        <Cnpj>${sanitizeXml(prestador.cnpj)}</Cnpj>`,
    `        <InscricaoMunicipal>${sanitizeXml(prestador.im)}</InscricaoMunicipal>`,
    '      </prestador>',
    '      <tomador>',
    '        <identificacaoTomador>',
    '          <CpfCnpj>',
    `            <Cnpj>${sanitizeXml(tomador.cnpjCpf)}</Cnpj>`,
    '          </CpfCnpj>',
    '        </identificacaoTomador>',
    `        <razaoSocial>${sanitizeXml(tomador.razao)}</razaoSocial>`,
    '        <endereco>',
    `          <endereco>${sanitizeXml(tomador.endereco)}</endereco>`,
    '        </endereco>',
    '      </tomador>',
    '      <servico>',
    '        <valores>',
    `          <valorServicos>${valor}</valorServicos>`,
    `          <aliquota>${aliquota}</aliquota>`,
    `          <issRetido>${issRetido}</issRetido>`,
    '        </valores>',
    `        <codigoMunicipio>${sanitizeXml(servico.codigoMunicipio)}</codigoMunicipio>`,
    `        <itemListaServico>${sanitizeXml(servico.itemLista)}</itemListaServico>`,
    '      </servico>',
    `      <competencia>${sanitizeXml(competencia)}</competencia>`,
    '      <identificacaoEmitente>',
    `        <Cnpj>${sanitizeXml(prestador.cnpj)}</Cnpj>`,
    `        <InscricaoMunicipal>${sanitizeXml(prestador.im)}</InscricaoMunicipal>`,
    '      </identificacaoEmitente>',
    '    </InfNfse>',
    '  </nfse>',
    '</gerarNfse>'
  ].join('\n');
}

/** sha256 (hex) of an NFSe document, for emission integrity checks. */
export function hashNfse(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex');
}
