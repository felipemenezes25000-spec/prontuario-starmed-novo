// StarMed interop controller — HL7v2 / TISS / NFSe endpoints.
// All routes are authenticated (JwtGuard) except none here: no @Public routes.

import { BadGatewayException, Body, ConflictException, Controller, Get, Header, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../db';
import { Actor, audit, requireRole } from '../security';
import { parse } from '../domain';
import { buildAck, getFieldValue, parseHL7V2, mapperAdtToEncounterFields, parseADT_A01, parseADT_A03, parseORU_R01 } from './hl7v2';
import { buildTissConsulta, buildTissLote, extractLoteHash, type TissConsultaInput } from './tiss';
import { buildNfseEmissao, hashNfse, type NfseInput } from './nfse';
import { INTEROP_CHANNELS, dispatchInterop, outboundConfigFromEnv } from './outbound';
import { sendHl7MllpTls } from './mllp';
import { dicomwebConfigFromEnv, qidoSearch } from './dicomweb';

type R = { actor: Actor };
const a = (r: R) => r.actor;

const hl7MessageSchema = z.object({ message: z.string().min(8).max(1000000) }).strict();

const tissGuideSchema = z.object({
  loteId: z.string().min(1).max(12),
  sequencialTransacao: z.string().regex(/^\d{1,12}$/),
  dataRegistro: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  horaRegistro: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  prestador: z.object({ cnpj: z.string().regex(/^\d{14}$/) }).strict(),
  registroAnsOperadora: z.string().regex(/^\d{6}$/),
  numeroGuiaPrestador: z.string().regex(/^\d{1,20}$/),
  beneficiario: z.object({ numeroCarteira: z.string().regex(/^\d{1,20}$/), atendimentoRN: z.enum(['S', 'N']) }).strict(),
  contratadoExecutante: z.object({ cnpj: z.string().regex(/^\d{14}$/), cnes: z.string().regex(/^\d{1,7}$/) }).strict(),
  profissionalExecutante: z.object({
    nome: z.string().min(1).max(70).optional(),
    conselho: z.string().regex(/^\d{2}$/),                 // dm_conselhoProfissional (CRM=02)
    numeroRegistro: z.string().regex(/^\d{1,15}$/),
    uf: z.string().regex(/^\d{2}$/),                        // dm_UF = código IBGE
    cbos: z.string().regex(/^\d{6}$/)
  }).strict(),
  indicacaoAcidente: z.enum(['0', '1', '2', '9']),
  atendimento: z.object({
    regime: z.enum(['01', '02', '03', '04', '05']),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tipoConsulta: z.enum(['1', '2', '3', '4'])
  }).strict(),
  procedimento: z.object({
    codigoTabela: z.enum(['18', '19', '20', '22', '90', '98', '00']),
    codigo: z.string().regex(/^\d{1,10}$/),
    valor: z.number().nonnegative()
  }).strict()
}).strict();

const tissLoteSchema = z.object({ guides: z.array(tissGuideSchema).min(1).max(100) }).strict();

const nfseSchema = z.object({
  prestador: z.object({ cnpj: z.string().min(14).max(14), im: z.string().min(1).max(20) }).strict(),
  tomador: z.object({ cnpjCpf: z.string().min(11).max(14), razao: z.string().min(1).max(160), endereco: z.string().min(1).max(240) }).strict(),
  servico: z.object({
    codigoMunicipio: z.string().min(1).max(10),
    itemLista: z.string().min(1).max(10),
    aliquota: z.number().nonnegative().max(100),
    valorLiquidoNfse: z.number().nonnegative(),
    issRetido: z.boolean().optional()
  }).strict(),
  competencia: z.string().min(7).max(7),
  numero: z.union([z.number().int().nonnegative(), z.string().min(1).max(20)])
}).strict();

const SUPPORTED_HL7_TYPES = new Set(['ADT^A01', 'ADT^A03', 'ORU^R01']);

// Fase 6 — schemas dos adapters de saída (ST-P1-009/010).
const interopChannelSchema = z.enum(INTEROP_CHANNELS);
const interopDispatchSchema = z.object({ channel: interopChannelSchema }).strict();
const hl7SendSchema = z.object({
  message: z.string().min(8).max(1000000),
  patientRef: z.string().min(1).max(120).optional()
}).strict();
const dicomwebQidoSchema = z.object({
  patientId: z.string().min(1).max(120),
  modalities: z.array(z.string().min(1).max(16)).max(10).optional()
}).strict();

@Controller('interop')
export class InteropController {
  constructor(private db: Db) {}

  @Post('hl7v2/message')
  async hl7Message(@Req() req: R, @Body() raw: unknown) {
    const actor = a(req);
    requireRole(actor, ['admin', 'doctor', 'nurse', 'reception']);
    const { message } = parse(hl7MessageSchema, raw);

    let parsed: ReturnType<typeof parseHL7V2>;
    let msh: string[] | undefined;
    let messageType = '';
    let controlId = '';
    try {
      parsed = parseHL7V2(message);
      msh = parsed.segmentos.get('MSH')?.[0];
      const code = getFieldValue(msh, 9, 1);
      const trigger = getFieldValue(msh, 9, 2);
      messageType = trigger ? `${code}^${trigger}` : code;
      controlId = getFieldValue(msh, 10);
      if (!controlId) throw new Error('MSH-10 (SequenceNumber) ausente');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Mensagem HL7 inválida';
      await audit(this.db, actor, 'interop.hl7v2.rejected', 'inbound_message', null, { errorMessage });
      return { ackCode: 'AE' as const, errorMessage };
    }

    if (!SUPPORTED_HL7_TYPES.has(messageType)) {
      const errorMessage = `Tipo de mensagem não suportado: ${messageType}`;
      await audit(this.db, actor, 'interop.hl7v2.rejected', 'inbound_message', null, { messageType, controlId });
      return { ackCode: 'AR' as const, errorMessage };
    }

    // Valid clinical message: persist for the inbound ledger and audit before ACK.
    try {
      if (messageType === 'ADT^A01') mapperAdtToEncounterFields(parseADT_A01(message));
      else if (messageType === 'ADT^A03') mapperAdtToEncounterFields(parseADT_A03(message));
      else if (messageType === 'ORU^R01') parseORU_R01(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Falha ao interpretar mensagem';
      await audit(this.db, actor, 'interop.hl7v2.rejected', 'inbound_message', null, { messageType, controlId, errorMessage });
      return { ackCode: 'AE' as const, errorMessage };
    }

    const ackCode = 'AA' as const;
    await this.db.query(
      'INSERT INTO inbound_messages(org_id,direction,protocol,message_type,external_control_id,payload,status) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [actor.org_id, 'inbound', 'hl7v2-mllp', messageType, controlId, message, 'received']
    );
    await audit(this.db, actor, 'interop.hl7v2.received', 'inbound_message', null, { messageType, controlId, ackCode });
    return { ackCode, controlId };
  }

  @Get('tiss/consulta/preview')
  @Header('Content-Type', 'application/xml')
  async tissConsultaPreview(@Req() req: R, @Query() query: Record<string, unknown>) {
    const actor = a(req);
    requireRole(actor, ['doctor']);
    const params = parse(tissPreviewSchema, query);
    const xml = buildTissConsulta(params);
    await audit(this.db, actor, 'interop.tiss.preview', 'organization', actor.org_id, { loteId: params.loteId });
    return xml;
  }

  @Post('tiss/lote')
  async tissLote(@Req() req: R, @Body() raw: unknown) {
    const actor = a(req);
    requireRole(actor, ['doctor']);
    const { guides } = parse(tissLoteSchema, raw);
    const xml = buildTissLote(guides as TissConsultaInput[]);
    await this.db.query(
      'INSERT INTO inbound_messages(org_id,direction,protocol,message_type,external_control_id,payload,status) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [actor.org_id, 'outbound', 'tiss', 'TISS_LOTE', guides[0]?.loteId ?? null, xml, 'processed']
    );
    const hash = extractLoteHash(xml);
    await audit(this.db, actor, 'interop.tiss.lote', 'organization', actor.org_id, { guides: guides.length, hash });
    return { hash, xml };
  }

  @Post('nfse/preview')
  @Header('Content-Type', 'application/xml')
  async nfsePreview(@Req() req: R, @Body() raw: unknown) {
    const actor = a(req);
    requireRole(actor, ['admin']);
    const input = parse(nfseSchema, raw) as NfseInput;
    const xml = buildNfseEmissao(input);
    await audit(this.db, actor, 'interop.nfse.preview', 'organization', actor.org_id, { numero: String(input.numero), hash: hashNfse(xml) });
    return xml;
  }

  // ------------------- Fase 6 — adapters de SAÍDA (ST-P1-009/010) -------------------

  /**
   * Drenagem administrativa do outbox de interoperabilidade: até 20 itens
   * VENCIDOS de UM canal por chamada — mesmo shape do despacho hospitalar
   * (/hospital/orders/outbox/dispatch). Canal desligado → skippedChannelDisabled
   * (a mensagem fica na fila; ZERO bytes na rede); circuito open → blockedByCircuit.
   */
  @Post('outbox/dispatch')
  async dispatchInteropOutbox(@Req() req: R, @Body() raw: unknown) {
    const actor = a(req);
    requireRole(actor, ['admin']);
    const { channel } = parse(interopDispatchSchema, raw);
    const outcome = await dispatchInterop(this.db, actor, channel);
    await audit(this.db, actor, 'interop.outbox.dispatch', 'organization', actor.org_id, { channel, ...outcome });
    return outcome;
  }

  /**
   * Status do outbox (admin): SEM payload cru — só metadados de entrega
   * (status/attempts/erros), porque o payload pode referenciar pacientes.
   */
  @Get('outbox')
  async listInteropOutbox(@Req() req: R, @Query() query: Record<string, unknown>) {
    const actor = a(req);
    requireRole(actor, ['admin']);
    const channel =
      query.channel === undefined || query.channel === '' ? null : parse(interopChannelSchema, query.channel);
    const values: unknown[] = [actor.org_id];
    let where = 'org_id = $1';
    if (channel) {
      values.push(channel);
      where += ` AND channel = $${values.length}`;
    }
    const rows = await this.db.query(
      `SELECT id, channel, order_id, status, attempts, last_error, next_attempt_at, created_at, updated_at
         FROM integration_outbox WHERE ${where}
         ORDER BY created_at DESC LIMIT 100`,
      values
    );
    return { items: rows.rows };
  }

  /**
   * Envio HL7 por MLLP sobre TLS (ST-P1-009). Desligado → 409 com o motivo e
   * NENHUMA conexão (CA própria obrigatória — ver mllp.ts). Sandbox →
   * status 'sandbox' sem rede. Real → envia e devolve o ACK; audit SOMENTE com
   * metadados (tipo MSH-9, controle MSH-10, código do ACK) — nunca o texto.
   */
  @Post('hl7/send')
  async hl7Send(@Req() req: R, @Body() raw: unknown) {
    const actor = a(req);
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const body = parse(hl7SendSchema, raw);
    const cfg = outboundConfigFromEnv('hl7');
    if (!cfg.enabled) throw new ConflictException(cfg.reason ?? 'hl7 desligado (HL7_MLLP_HOST ausente)');

    let messageType = '';
    let controlId = '';
    try {
      const msh = parseHL7V2(body.message).segmentos.get('MSH')?.[0];
      const code = getFieldValue(msh, 9, 1);
      const trigger = getFieldValue(msh, 9, 2);
      messageType = trigger ? `${code}^${trigger}` : code;
      controlId = getFieldValue(msh, 10);
    } catch {
      throw new ConflictException('Mensagem HL7 inválida (MSH ilegível) — nada foi enviado');
    }

    if (cfg.sandbox) {
      await audit(this.db, actor, 'interop.hl7.sent', 'inbound_message', null, {
        channel: 'hl7', sandbox: true, messageType, controlId, status: 'sandbox', patientRefInformed: Boolean(body.patientRef)
      });
      return {
        status: 'sandbox' as const,
        ack: null,
        sandbox: true,
        note: 'HL7_MLLP_SANDBOX=true: nenhum byte saiu da máquina e nenhum ACK real existe.'
      };
    }

    let result;
    try {
      result = await sendHl7MllpTls({
        host: cfg.host!,
        port: cfg.port!,
        message: body.message,
        caPath: cfg.caPath,
        certPath: cfg.clientCertPath,
        keyPath: cfg.clientKeyPath
      });
    } catch (e) {
      throw new BadGatewayException(e instanceof Error ? e.message : 'falha MLLP (timeout 5s ou TLS)');
    }
    const ackCode = result.ack?.code ?? null;
    const status = ackCode === 'AA' ? ('sent' as const) : ('rejected' as const);
    await audit(this.db, actor, 'interop.hl7.sent', 'inbound_message', null, {
      channel: 'hl7', messageType, controlId, ackCode, bytes: result.bytes, status, patientRefInformed: Boolean(body.patientRef)
    });
    return { status, ack: result.ack, bytes: result.bytes };
  }

  /**
   * QIDO-RS de estudos (ST-P1-010). Desligado → 409 sem rede. Sandbox →
   * `matches: []` HONESTO (nada consultado ⇒ nada encontrado — nunca
   * inventamos exame). Real → 1 tentativa com timeout 5s; erro honesto.
   */
  @Post('dicomweb/qido')
  async dicomwebQido(@Req() req: R, @Body() raw: unknown) {
    const actor = a(req);
    requireRole(actor, ['admin', 'doctor', 'nurse']);
    const body = parse(dicomwebQidoSchema, raw);
    const cfg = dicomwebConfigFromEnv();
    if (!cfg.enabled) throw new ConflictException(cfg.reason ?? 'dicom desligado (DICOMWEB_URL ausente)');
    const result = await qidoSearch(cfg, { patientId: body.patientId, modalities: body.modalities });
    await audit(this.db, actor, 'interop.dicomweb.qido', 'organization', actor.org_id, {
      sandbox: cfg.sandbox, status: result.status, matches: result.matches.length, modalities: body.modalities ?? null
    });
    return result;
  }
}

// Preview query accepts the same shape as a TISS 4.01.00 guide (flat camelCase keys).
const tissPreviewSchema = z.object({
  loteId: z.string().min(1).max(12),
  sequencialTransacao: z.string().regex(/^\d{1,12}$/),
  dataRegistro: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  horaRegistro: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  prestadorCnpj: z.string().regex(/^\d{14}$/),
  registroAnsOperadora: z.string().regex(/^\d{6}$/),
  numeroGuiaPrestador: z.string().regex(/^\d{1,20}$/),
  numeroCarteira: z.string().regex(/^[\w\-]{1,20}$/),
  atendimentoRN: z.enum(['S', 'N']),
  contratadoCnpj: z.string().regex(/^\d{14}$/),
  cnes: z.string().regex(/^\d{1,7}$/),
  nomeProfissional: z.string().min(1).max(70).optional(),
  conselhoProfissional: z.string().regex(/^\d{2}$/),
  numeroConselho: z.string().regex(/^\d{1,15}$/),
  uf: z.string().regex(/^\d{2}$/),
  cbos: z.string().regex(/^\d{6}$/),
  indicacaoAcidente: z.enum(['0', '1', '2', '9']),
  regimeAtendimento: z.enum(['01', '02', '03', '04', '05']),
  dataAtendimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tipoConsulta: z.enum(['1', '2', '3', '4']),
  codigoTabela: z.enum(['18', '19', '20', '22', '90', '98', '00']),
  codigoProcedimento: z.string().regex(/^\d{1,10}$/),
  valor: z.coerce.number().nonnegative()
}).strict().transform<TissConsultaInput>(q => ({
  loteId: q.loteId,
  sequencialTransacao: q.sequencialTransacao,
  dataRegistro: q.dataRegistro,
  horaRegistro: q.horaRegistro,
  prestador: { cnpj: q.prestadorCnpj },
  registroAnsOperadora: q.registroAnsOperadora,
  numeroGuiaPrestador: q.numeroGuiaPrestador,
  beneficiario: { numeroCarteira: q.numeroCarteira, atendimentoRN: q.atendimentoRN },
  contratadoExecutante: { cnpj: q.contratadoCnpj, cnes: q.cnes },
  profissionalExecutante: { nome: q.nomeProfissional, conselho: q.conselhoProfissional, numeroRegistro: q.numeroConselho, uf: q.uf, cbos: q.cbos },
  indicacaoAcidente: q.indicacaoAcidente,
  atendimento: { regime: q.regimeAtendimento, data: q.dataAtendimento, tipoConsulta: q.tipoConsulta },
  procedimento: { codigoTabela: q.codigoTabela, codigo: q.codigoProcedimento, valor: q.valor }
}));
