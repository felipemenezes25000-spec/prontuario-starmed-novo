import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAck,
  getFieldValue,
  mapperAdtToEncounterFields,
  parseADT_A01,
  parseADT_A03,
  parseHL7V2,
  parseORU_R01,
  unwrapMllp,
  wrapMllp
} from './hl7v2';
import { buildTissConsulta, buildTissLote, extractLoteHash } from './tiss';
import { buildNfseEmissao, hashNfse, sanitizeXml } from './nfse';

// Sample ADT^A01 exercising all five HL7 escapes:
//   \S\ -> '^' (PID-5 family name), \T\ -> '&' (PID-5 given name),
//   \R\ -> '~' (PID-3 repetition), \F\ -> '|' (PID-6), \E\ -> '\' (NTE).
const ADT_A01 = [
  'MSH|^~\\&|HISLAB|HOSP SAO JOSE\\T\\CENTRAL|STARMed|CTB|20250101120000||ADT^A01|CTRL-0001|P|2.5',
  'EVN|A01|20250101120000',
  'PID|1||EXT-42^^^HOSP^MR||SILVA\\S\\NETO^MARIA\\T\\JOSEFA||19850312|F|||RUA A, 100\\T\\APTO 100^^SAO PAULO^SP^01001000^BRA||(11) 99999-0000\\R\\(11) 88888-0000',
  'PV1|1|CLINICA-2|ALA-SUL^101^B' + '|'.repeat(40) + '|20250101083000',
  'NTE|1||Paciente comparece com \\E\\ de escape'
].join('\r');

test('HL7 round-trip: parse + escapes + getFieldValue', () => {
  const { segmentos } = parseHL7V2(ADT_A01);
  assert.ok(segmentos instanceof Map);
  for (const name of ['MSH', 'EVN', 'PID', 'PV1', 'NTE']) assert.ok(segmentos.has(name), `segmento ${name} presente`);

  const msh = segmentos.get('MSH')![0];
  assert.equal(getFieldValue(msh, 1), '|', 'MSH-1 é o próprio separador de campos');
  assert.equal(getFieldValue(msh, 2), '^~\\&');
  assert.equal(getFieldValue(msh, 9, 1), 'ADT');
  assert.equal(getFieldValue(msh, 9, 2), 'A01');
  assert.equal(getFieldValue(msh, 10), 'CTRL-0001');

  const pid = segmentos.get('PID')![0];
  assert.equal(getFieldValue(pid, 3), 'EXT-42^^^HOSP^MR', 'PID-3 identificador do paciente (com assigning authority)');
  assert.equal(getFieldValue(pid, 3, 1), 'EXT-42');
  assert.equal(getFieldValue(pid, 5, 1), 'SILVA^NETO', '\\S\\ decodifica para separador de componente');
  assert.equal(getFieldValue(pid, 5, 2), 'MARIA&JOSEFA', '\\T\\ decodifica para separador de subcomponente');
  assert.equal(getFieldValue(pid, 7), '19850312');
  assert.equal(getFieldValue(pid, 13), '(11) 99999-0000~(11) 88888-0000', '\\R\\ decodifica para separador de repetição');
  assert.equal(getFieldValue(segmentos.get('NTE')![0], 3), 'Paciente comparece com \\ de escape', '\\E\\ decodifica para o próprio escape');
});

test('ADT^A01 mapping to encounter fields', () => {
  const fields = parseADT_A01(ADT_A01);
  assert.equal(fields.clinic, 'CLINICA-2', 'PV1-2 é a clínica');
  const mapped = mapperAdtToEncounterFields(fields);
  assert.deepEqual(mapped, {
    patientExternalId: 'EXT-42',
    patientName: 'SILVA^NETO MARIA&JOSEFA',
    birthDate: '1985-03-12',
    ward: 'ALA-SUL',
    room: '101',
    bed: 'B',
    admissionAt: '2025-01-01T08:30:00'
  });
});

test('ADT^A03 parses discharge datetime (PV1-45)', () => {
  const a03 = ADT_A01.replace('ADT^A01', 'ADT^A03').replace('EVN|A01|', 'EVN|A03|')
    .replace('|20250101083000', '|20250101083000|20250103114500');
  const fields = parseADT_A03(a03);
  assert.equal(fields.admissionAt, '2025-01-01T08:30:00');
  assert.equal(fields.dischargeAt, '2025-01-03T11:45:00');
});

test('ACK AA/AE preserves original MSA-2 (SequenceNumber) and trigger', () => {
  const aa = parseHL7V2(buildAck(ADT_A01, 'AA'));
  const aaMsh = aa.segmentos.get('MSH')![0];
  assert.equal(getFieldValue(aaMsh, 9, 1), 'ACK');
  assert.equal(getFieldValue(aaMsh, 9, 2), 'A01');
  const aaMsa = aa.segmentos.get('MSA')![0];
  assert.equal(getFieldValue(aaMsa, 1), 'AA');
  assert.equal(getFieldValue(aaMsa, 2), 'CTRL-0001', 'MSA-2 preserva o controle original');

  const ae = parseHL7V2(buildAck(ADT_A01, 'AE', 'Campo PID-3 | inválido'));
  const aeMsa = ae.segmentos.get('MSA')![0];
  assert.equal(getFieldValue(aeMsa, 1), 'AE');
  assert.equal(getFieldValue(aeMsa, 2), 'CTRL-0001');
  assert.equal(getFieldValue(aeMsa, 3), 'Campo PID-3 | inválido', 'erro chega decodificado (escape \F\ aplicado na montagem)');
});

test('MLLP wrap/unwrap and delimiter validation', () => {
  const frame = wrapMllp(ADT_A01);
  assert.equal(frame[0], 0x0b, 'inicia com <VT>');
  assert.equal(frame[frame.length - 2], 0x1c, 'termina com <FS>');
  assert.equal(frame[frame.length - 1], 0x0d, 'termina com <CR>');
  assert.equal(unwrapMllp(frame).toString('utf8'), ADT_A01);

  assert.throws(() => unwrapMllp(Buffer.from('MSH|^~\\&|sem delimitadores\r', 'utf8')), /VT/, 'rejeita payload sem <VT>');
  assert.throws(() => unwrapMllp(Buffer.concat([Buffer.from([0x0b]), Buffer.from('MSH|...', 'utf8')])), /FS/, 'rejeita payload sem <FS><CR>');
});

test('ORU^R01 minimal parse reads OBX-3/5/6/7/8', () => {
  const oru = [
    'MSH|^~\\&|LABEXT|HOSP SAO JOSE|STARMed|CTB|20250102103000||ORU^R01|CTRL-ORU-7|P|2.5',
    'PID|1||EXT-42^^^HOSP^MR||SILVA^MARIA||19850312|F',
    'OBX|1|NM|2345-7^Glicose^LN||150|mg/dL|70-99|H|||F'
  ].join('\r');
  const result = parseORU_R01(oru);
  assert.equal(result.controlId, 'CTRL-ORU-7');
  assert.equal(result.patientExternalId, 'EXT-42');
  assert.equal(result.observations.length, 1);
  assert.deepEqual(result.observations[0], {
    identifier: '2345-7',
    text: 'Glicose',
    value: '150',
    units: 'mg/dL',
    referenceRange: '70-99',
    abnormalFlags: 'H'
  });
});

const TISS_INPUT = {
  loteId: 'LOTE-2025-0001',
  prestador: { cnpj: '12345678000199', registroAns: '305039' },
  beneficiario: { numeroCarteira: 'CART-8899', nome: 'MARIA & JOSE DA SILVA', nascimento: '1985-03-12' },
  procedimento: { codigoTUSS: '2.14.02.003-0', dataExecucao: '2025-01-15', valor: 250.5 },
  solicitante: { nome: 'DRA. ANA & CIA', conselho: 'CRM', numeroRegistro: '123456' }
};

test('TISS consulta contains ANS/card/beneficiary/TUSS tags and escapes "&"', () => {
  const xml = buildTissConsulta(TISS_INPUT);
  assert.match(xml, /<tiss:tourFeConteudoMedico xmlns:tiss="http:\/\/www\.ans\.gov\.br\/padroes\/tiss"/);
  assert.match(xml, /<tiss:cnpjCartaoANS>12345678000199<\/tiss:cnpjCartaoANS>/);
  assert.match(xml, /<tiss:numeroGuiaBeneficiario>LOTE-2025-0001<\/tiss:numeroGuiaBeneficiario>/);
  assert.match(xml, /<tiss:codigoTUSS>2\.14\.02\.003-0<\/tiss:codigoTUSS>/);
  assert.ok(xml.includes('MARIA &amp; JOSE DA SILVA'), 'nome do beneficiário escapado');
  assert.ok(xml.includes('DRA. ANA &amp; CIA'), 'nome do solicitante escapado');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'nenhum & solto no XML');
});

test('TISS lote hash is stable for identical input', () => {
  const first = buildTissLote([TISS_INPUT, { ...TISS_INPUT, loteId: 'LOTE-2025-0002' }]);
  const second = buildTissLote([TISS_INPUT, { ...TISS_INPUT, loteId: 'LOTE-2025-0002' }]);
  assert.equal(first.hash, second.hash, 'mesmo lote -> mesmo hash');
  assert.equal(first.hash, extractLoteHash(first.xml), 'hash = sha256 do XML do lote');
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.ok(first.xml.includes('<tiss:lot '), 'lote envolvido em <tiss:lot>');
  const other = buildTissLote([{ ...TISS_INPUT, procedimento: { ...TISS_INPUT.procedimento, valor: 999.99 } }]);
  assert.notEqual(first.hash, other.hash, 'conteúdo diferente -> hash diferente');
});

const NFSE_INPUT = {
  prestador: { cnpj: '12345678000199', im: '12345' },
  tomador: { cnpjCpf: '98765432100', razao: 'FARMACIA SAO & JOSE "FILHOS"', endereco: 'RUA X, 10' },
  servico: { codigoMunicipio: '3550308', itemLista: '17.06', aliquota: 5, valorLiquidoNfse: 157.3 },
  competencia: '2025-01',
  numero: 42
};

test('NFSe ABRASF contains valorLiquidoNfse and escapes the tomador', () => {
  const xml = buildNfseEmissao(NFSE_INPUT);
  assert.ok(xml.includes('<gerarNfse xmlns="http://www.abrasf.org.br/nfse.xsd">'));
  assert.ok(xml.includes('<valorLiquidoNfse>157.30</valorLiquidoNfse>'));
  assert.ok(xml.includes('<razaoSocial>FARMACIA SAO &amp; JOSE &quot;FILHOS&quot;</razaoSocial>'));
  assert.ok(xml.includes('<competencia>2025-01</competencia>'));
  assert.ok(xml.includes('<identificacaoEmitente>'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'nenhum & solto no XML');
  assert.equal(hashNfse(xml), hashNfse(xml), 'hash NFSe determinístico');
  assert.match(hashNfse(xml), /^[0-9a-f]{64}$/);
});

test('sanitizeXml escapes all five mandatory characters', () => {
  assert.equal(sanitizeXml(`& < > " '`), '&amp; &lt; &gt; &quot; &apos;');
});
