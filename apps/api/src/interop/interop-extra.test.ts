import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTEROP_CHANNELS,
  OUTBOUND_ENVS,
  circuitAllows,
  nextBackoff,
  outboundConfigFromEnv,
  retryDecision
} from './outbound';
import { buildQidoUrl, dicomwebConfigFromEnv, mapQidoStudy } from './dicomweb';
import { frameMllp, readMllpResponse } from './mllp';
import { parseAck } from './hl7v2';

// Env primário de cada canal — se mudar, muda também o motivo honesto.
const ENV_POR_CANAL = {
  lis: 'LIS_URL',
  pacs: 'PACS_URL',
  hl7: 'HL7_MLLP_HOST',
  tiss: 'TISS_LOTE_URL',
  nfse: 'NFSE_URL',
  rnds: 'RNDS_SUBMIT_URL',
  dicom: 'DICOMWEB_URL'
} as const;

test('outbound: TODOS os canais nascem desligados sem env (zero bytes na rede)', () => {
  assert.deepEqual([...INTEROP_CHANNELS], ['lis', 'pacs', 'hl7', 'tiss', 'nfse', 'rnds', 'dicom']);
  for (const channel of INTEROP_CHANNELS) {
    const cfg = outboundConfigFromEnv(channel, {});
    assert.equal(cfg.enabled, false, `${channel} deve nascer desligado`);
    assert.equal(cfg.url, null);
    assert.equal(cfg.reason, `${channel} desligado (${ENV_POR_CANAL[channel]} ausente)`, `motivo honesto p/ ${channel}`);
    assert.equal(OUTBOUND_ENVS[channel].primary, ENV_POR_CANAL[channel]);
  }
});

test('outbound: env primário presente liga o canal (sem sandbox)', () => {
  for (const channel of INTEROP_CHANNELS) {
    if (channel === 'hl7') continue; // hl7 exige CA própria: tratado à parte
    const cfg = outboundConfigFromEnv(channel, { [ENV_POR_CANAL[channel]]: 'https://exemplo.invalid/x' });
    assert.equal(cfg.enabled, true, `${channel} ligado com env presente`);
    assert.equal(cfg.reason, null);
    assert.equal(cfg.url, 'https://exemplo.invalid/x');
    assert.equal(cfg.sandbox, false);
  }
});

test('outbound hl7: TLS com CA própria é o ÚNICO transporte (fail-closed)', () => {
  const semCa = outboundConfigFromEnv('hl7', { HL7_MLLP_HOST: 'hl7.exemplo.invalid' });
  assert.equal(semCa.enabled, false, 'host sem HL7_MLLP_CA NÃO liga o canal');
  assert.equal(semCa.reason, 'hl7 desligado (HL7_MLLP_CA ausente — TLS com CA própria é obrigatório)');

  const tlsOff = outboundConfigFromEnv('hl7', { HL7_MLLP_HOST: 'hl7.exemplo.invalid', HL7_MLLP_TLS: 'false' });
  assert.equal(tlsOff.enabled, false, 'HL7_MLLP_TLS=false é rejeitado — MLLP sem TLS não existe aqui');

  const ligado = outboundConfigFromEnv('hl7', { HL7_MLLP_HOST: 'hl7.exemplo.invalid', HL7_MLLP_CA: '/etc/starmed/ca.pem' });
  assert.equal(ligado.enabled, true);
  assert.equal(ligado.tls, true);
  assert.equal(ligado.port, 2575, 'porta padrão MLLP quando HL7_MLLP_PORT ausente');
  assert.equal(ligado.caPath, '/etc/starmed/ca.pem');

  const porta = outboundConfigFromEnv('hl7', {
    HL7_MLLP_HOST: 'hl7.exemplo.invalid',
    HL7_MLLP_CA: '/ca.pem',
    HL7_MLLP_PORT: '2576'
  });
  assert.equal(porta.port, 2576);
});

test('outbound: *_SANDBOX=true opera simulado; LIS_SANDBOX cobre lis e pacs', () => {
  const rnds = outboundConfigFromEnv('rnds', { RNDS_SANDBOX: 'true' });
  assert.equal(rnds.enabled, true, 'sandbox habilita operação simulada');
  assert.equal(rnds.sandbox, true);
  assert.equal(rnds.url, null);

  const pacs = outboundConfigFromEnv('pacs', { LIS_SANDBOX: 'true' });
  assert.equal(pacs.enabled, true, 'LIS_SANDBOX cobre pacs, como no despacho hospitalar (orders.ts)');

  const hl7Sandbox = outboundConfigFromEnv('hl7', { HL7_MLLP_SANDBOX: 'true' });
  assert.equal(hl7Sandbox.enabled, true, 'sandbox do hl7 dispensa CA (não haverá rede)');
  assert.equal(hl7Sandbox.sandbox, true);
});

test('re-export: nextBackoff/retryDecision/circuitAllows são as funções testadas do hospitalar', () => {
  assert.equal(nextBackoff(0), 1);
  assert.equal(nextBackoff(4), 16);
  assert.equal(nextBackoff(99), 1440, 'teto de 24h (minutos)');
  assert.deepEqual(retryDecision(2), { status: 'failed', delayMinutes: 4 });
  assert.deepEqual(retryDecision(5), { status: 'dead', delayMinutes: 0 }, '5ª falha vira DLQ');

  const now = new Date('2026-01-01T00:01:00Z');
  assert.equal(circuitAllows('closed', null, now), true);
  assert.equal(circuitAllows('half_open', null, now), true);
  assert.equal(circuitAllows('open', new Date('2026-01-01T00:00:30Z'), now), false, 'janela de 60s ainda aberta');
  assert.equal(circuitAllows('open', new Date('2026-01-01T00:00:00Z'), now), true, 'janela vencida deixa tentar');
});

test('dicomweb: nasce desligado; env liga; sandbox é simulado honesto', () => {
  const off = dicomwebConfigFromEnv({});
  assert.equal(off.enabled, false);
  assert.equal(off.reason, 'dicom desligado (DICOMWEB_URL ausente)');

  const on = dicomwebConfigFromEnv({ DICOMWEB_URL: 'https://pacs.exemplo/dicomweb', DICOMWEB_AETITLE: 'STARMed' });
  assert.equal(on.enabled, true);
  assert.equal(on.reason, null);
  assert.equal(on.sandbox, false);
  assert.equal(on.aetitle, 'STARMed');

  const sandbox = dicomwebConfigFromEnv({ DICOMWEB_SANDBOX: 'true' });
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.sandbox, true);
  assert.equal(sandbox.url, null);
});

test('buildQidoUrl monta a consulta QIDO-RS de estudos', () => {
  const url = buildQidoUrl('https://pacs.exemplo/dicomweb', { patientId: 'p-1', modalities: ['CT', 'MR'] });
  assert.equal(url, 'https://pacs.exemplo/dicomweb/studies?PatientID=p-1&Modalities=CT&Modalities=MR');
  const semMod = buildQidoUrl('https://pacs.exemplo/dicomweb/', { patientId: 'p-1' });
  assert.equal(semMod, 'https://pacs.exemplo/dicomweb/studies?PatientID=p-1');
});

test('mapQidoStudy extrai só metadados presentes (nada inventado)', () => {
  const match = mapQidoStudy({
    '0020000D': { vr: 'UI', Value: ['1.2.840.113619.2.1'] },
    '00080061': { vr: 'CS', Value: ['CT'] },
    '00080020': { vr: 'DA', Value: ['20250101'] }
  });
  assert.deepEqual(match, {
    studyInstanceUID: '1.2.840.113619.2.1',
    accessionNumber: null,
    modalities: ['CT'],
    studyDate: '20250101'
  });
  assert.deepEqual(mapQidoStudy({}), {
    studyInstanceUID: null,
    accessionNumber: null,
    modalities: [],
    studyDate: null
  });
});

test('MLLP frame: bytes exatos <VT> mensagem <FS><CR>', () => {
  const mensagem = 'MSH|^~\\&|A|A|B|B|20250101120000||ADT^A01|CTRL-0001|P|2.5';
  const frame = frameMllp(mensagem);
  assert.deepEqual([...frame], [0x0b, ...Buffer.from(mensagem, 'utf8'), 0x1c, 0x0d]);
  assert.equal(frame[0], 0x0b, 'FSA: <VT>');
  assert.equal(frame[frame.length - 2], 0x1c, '<FS>');
  assert.equal(frame[frame.length - 1], 0x0d, '<CR>');
});

test('readMllpResponse: parcial, completa e contagem de consumidos', () => {
  const parcial = readMllpResponse(Buffer.from([0x0b, 0x4d, 0x53, 0x48]));
  assert.equal(parcial.complete, false, 'sem <FS> ainda não há payload');
  assert.equal(parcial.payload, null);
  assert.equal(parcial.consumed, 4);

  const ack = 'MSH|^~\\&|LAB|LAB|STAR|CTB|20250101120000||ACK|ACK-1|P|2.5\rMSA|AA|CTRL-0001\r';
  const frame = frameMllp(ack);
  const leitura = readMllpResponse(frame);
  assert.equal(leitura.complete, true);
  assert.equal(leitura.payload!.toString('utf8'), ack, 'payload sem os delimitadores');
  assert.equal(leitura.consumed, frame.length, 'consome o frame inteiro (inclui <FS><CR>)');
});

test('parseAck extrai MSA-1 (código) e MSA-2 (controle); sem MSA = erro', () => {
  const ok = parseAck('MSH|^~\\&|LAB|LAB|STAR|CTB|20250101120000||ACK|ACK-1|P|2.5\rMSA|AA|CTRL-0001\r');
  assert.deepEqual(ok, { code: 'AA', controlId: 'CTRL-0001', error: null });

  const ar = parseAck('MSH|^~\\&|LAB|LAB|STAR|CTB|20250101120000||ACK|ACK-1|P|2.5\rMSA|AR|CTRL-0002|Tipo nao suportado\r');
  assert.equal(ar.code, 'AR');
  assert.equal(ar.error, 'Tipo nao suportado');

  assert.throws(() => parseAck('MSH|^~\\&|LAB|LAB|STAR|CTB|20250101120000||ACK|ACK-1|P|2.5\r'), /MSA/);
});
