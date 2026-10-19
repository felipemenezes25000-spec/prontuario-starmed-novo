// StarMed interop controller — HL7v2 / TISS / NFSe endpoints.
// All routes are authenticated (JwtGuard) except none here: no @Public routes.

import { Body, Controller, Get, Header, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../db';
import { Actor, audit, requireRole } from '../security';
import { parse } from '../domain';
import { buildAck, getFieldValue, parseHL7V2, mapperAdtToEncounterFields, parseADT_A01, parseADT_A03, parseORU_R01 } from './hl7v2';
import { buildTissConsulta, buildTissLote, extractLoteHash, type TissConsultaInput } from './tiss';
import { buildNfseEmissao, hashNfse, type NfseInput } from './nfse';

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
