import { Body, Controller, ConflictException, Get, HttpException, NotFoundException, Param, Post, Query, Req, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, Public, requireRole, setOrgContext } from './security';
import { signPades, verifyPades } from './pki/pades';
import { TsaFailureCategory, TsaError, requestTimestamp, tsaConfigFromEnv } from './pki/tsa';
import { TrustStore, TrustStoreError } from './pki/trust-store';
import { validateChain } from './pki/chain';
import { loadPolicy } from './pki/policy';
import { checkRevocation, revocationModeFromEnv } from './pki/revocation';
import { DocumentType, OIDS, documentTypeOid } from './pki/iti-oids';

/**
 * Endpoints de assinatura PAdES ICP-Brasil dos documentos clínicos.
 * A infra (signPades/verifyPades/requestTimestamp/TrustStore/loadPolicy/validateChain)
 * mora em src/pki; aqui fica orquestração, persistência da evidência e auditoria.
 * Revogação: pki/revocation.ts — REVOCATION_MODE=off|soft|hard (padrão off: CI sem
 * rede); 'soft' só REPORTA o estado OCSP na verificação, 'hard' BLOQUEIA o
 * sign-pades de prescrições com status 'revoked' ou 'unknown'.
 *
 * Segurança: a chave privada do profissional NUNCA é persistida — chega no request,
 * é usada em memória pelo signPades e descartada. MVP com chaves no request; a
 * evolução é custódia em KMS/HSM (docs/references/CERTIFICATE_KMS_SETUP.md).
 */

type AuthedRequest = { actor: Actor };

// ---------------------------------------------------------------------------
// Schemas e helpers puros (exportados para o teste sem banco/rede)
// ---------------------------------------------------------------------------

export const signPadesRequestSchema = z.object({
  expectedVersion: z.number().int().min(1),
  documentType: z.enum(['prescription', 'exam-request']),
  councilNumber: z.string().regex(/^[0-9]{4,6}$/, 'councilNumber deve ter 4 a 6 dígitos'),
  councilState: z.string().regex(/^[A-Z]{2}$/, 'councilState deve ser uma UF (duas letras maiúsculas)'),
  requireTimestamp: z.boolean().default(false),
  signerCertPem: z.string().trim().min(64, 'signerCertPem ausente ou truncado'),
  chainPems: z.array(z.string().trim().min(64)).max(10).default([]),
  privateKeyPkcs8Pem: z.string().trim().min(64, 'privateKeyPkcs8Pem ausente ou truncado')
}).strict();

export const verifySignatureRequestSchema = z.object({ signatureId: uuid }).strict();

export const itiVerifyQuerySchema = z.object({
  type: z.enum(['prescricao', 'exame']),
  _format: z.string().min(1),
  _secretCode: z.string().min(1).max(200)
});

/**
 * Bytes canonicamente assinados: o CMS é detached sobre EXATAMENTE este buffer.
 * A mesma nota na mesma versão sempre produz os mesmos bytes (JSON.stringify com
 * ordem fixa de chaves; o conteúdo vem do JSONB do Postgres, cuja ordenação de
 * chaves é determinística entre leituras), permitindo reconstruir o documento na
 * verificação.
 */
export function canonicalContentBytes(input: { noteId: string; version: number; content: unknown }): Buffer {
  return Buffer.from(JSON.stringify({ noteId: input.noteId, version: input.version, content: input.content }), 'utf8');
}

/**
 * Qualificação da assinatura (tri-estado, nunca "false silencioso"):
 *   true  — SOMENTE com carimbo de tempo aplicado no CMS E atributos OID ITI;
 *   false — avaliação positiva: comprovadamente sem carimbo (ex.: AD-RB);
 *   NULL  — desconhecido (algum dos fatores não pôde ser determinado).
 */
export function qualifySignature(timestampApplied: boolean | null, hasItiOids: boolean | null): boolean | null {
  if (timestampApplied === null || hasItiOids === null) return null;
  return Boolean(timestampApplied) && Boolean(hasItiOids);
}

/** Normaliza o secretCode de verificação: sem hífen e em caixa baixa. */
export function normalizeVerifyCode(code: string): string {
  return code.replace(/-/g, '').trim().toLowerCase();
}

/** Hash armazenado do secretCode (SHA-256 hex sobre o código normalizado). */
export function hashVerifyCode(code: string): string {
  return createHash('sha256').update(normalizeVerifyCode(code), 'utf8').digest('hex');
}

/** Mapeia categoria de falha da ACT para status HTTP — sem emitir AD-RB silencioso. */
export function tsaCategoryToHttpStatus(category: TsaFailureCategory): number {
  if (category === 'RequisicaoRecusada') return 502;
  if (category === 'AutoridadeIndisponivel') return 503;
  return 500; // CredencialInvalida / RespostaInvalida
}

/** type do Guia ITI Cap. IV (query string) → tipo de documento interno. */
export function itiQueryTypeToDocumentType(type: string): DocumentType | null {
  if (type === 'prescricao') return 'prescription';
  if (type === 'exame') return 'exam-request';
  return null;
}

/** Base pública do validador ITI (contrato Cap. IV). */
export function verifyBaseUrl(): string {
  return (process.env.VERIFY_BASE_URL || 'http://localhost:3001/api/verify').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Controller autenticado
// ---------------------------------------------------------------------------

@Controller('documents')
export class SignatureController {
  constructor(private readonly db: Db) {}

  /** Emissao PAdES (AD-RT com carimbo, ou AD-RB) sobre nota clínica já assinada. */
  @Post('encounters/:encounterId/notes/sign-pades')
  async signPadesDocument(
    @Param('encounterId') encounterId: string,
    @Body() raw: unknown,
    @Req() req: AuthedRequest
  ) {
    const actor = req.actor;
    requireRole(actor, ['doctor']);
    const body = parse(signPadesRequestSchema, raw);
    parse(uuid, encounterId);

    const { rows: noteRows } = await this.db.query(
      'SELECT id, org_id, encounter_id, version, status, content FROM clinical_notes WHERE encounter_id=$1 AND org_id=$2',
      [encounterId, actor.org_id]);
    const note = noteRows[0];
    if (!note) throw new NotFoundException('Nota clínica não encontrada');
    if (note.status !== 'signed')
      throw new BadRequestException('Somente notas clínicas com status signed podem receber assinatura PAdES');
    if (Number(note.version) !== body.expectedVersion)
      throw new ConflictException('Versão da nota divergente de expectedVersion');

    const content = canonicalContentBytes({ noteId: note.id, version: Number(note.version), content: note.content });

    // Cadeia do signer contra o trust store ICP-Brasil: falha FECHADA.
    let trust: TrustStore;
    try {
      trust = TrustStore.default();
    } catch (e) {
      // TrustStoreError: sem raízes não há validação de cadeia possível.
      throw new BadRequestException(e instanceof TrustStoreError ? e.message : 'Certificado fora do trust store ICP-Brasil');
    }
    let presented: X509Certificate[];
    try {
      presented = [new X509Certificate(body.signerCertPem), ...body.chainPems.map((p) => new X509Certificate(p))];
    } catch {
      throw new BadRequestException('Certificado ou cadeia PEM ilegível');
    }
    const chain = validateChain(presented[0], presented.slice(1), trust);
    if (!chain.ok) throw new BadRequestException('Certificado fora do trust store ICP-Brasil');

    // Carimbo de tempo: só com requireTimestamp E ACT configurada; falha da ACT com
    // requireTimestamp aborta a emissão (nunca cai silenciosamente para AD-RB).
    const tsa = tsaConfigFromEnv();
    if (body.requireTimestamp && !tsa)
      throw new BadRequestException('Carimbo de tempo exigido, mas nenhuma ACT está configurada (TSA_URL)');
    const wantsTimestamp = Boolean(body.requireTimestamp && tsa);
    let timestampTokenDer: Buffer | null = null;
    if (wantsTimestamp && tsa) {
      const imprint = createHash('sha256').update(content).digest(); // SHA-256 do documento
      try {
        const tst = await requestTimestamp({ imprint }, tsa);
        timestampTokenDer = tst.tokenDer;
      } catch (e) {
        if (e instanceof TsaError)
          throw new HttpException(`Falha no carimbo de tempo (ACT): ${e.message}`, tsaCategoryToHttpStatus(e.category));
        throw e;
      }
    }

    const policy = loadPolicy(wantsTimestamp ? 'ad-rt' : 'ad-rb');
    // Chave privada só em memória — nunca persistida (KMS posterior, ver docs).
    const signed = await signPades({
      content,
      signerCertPem: body.signerCertPem,
      chainPems: body.chainPems,
      privateKeyPkcs8Pem: body.privateKeyPkcs8Pem,
      documentType: body.documentType,
      councilNumber: body.councilNumber,
      councilState: body.councilState,
      policy,
      timestampTokenDer
    });

    const contentDigest = signed.digestSha256.toString('hex');
    const hasItiOids = documentTypeOid(body.documentType).startsWith(OIDS.POLICY_ARC + '.');
    // qualified=true SÓ se o carimbo entrou no CMS (timestampApplied) e os OIDs são ITI.
    const signatureIsQualified = qualifySignature(signed.timestampApplied, hasItiOids);
    const timestampAuthority = signed.timestampApplied ? (tsa?.url ?? null) : null;

    const { rows: inserted } = await this.db.query(
      `INSERT INTO document_signatures(org_id,note_id,signer_user_id,cms,content_digest,document_type,council_number,council_state,policy_oid,timestamp_authority,signature_is_qualified,signature_path)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, created_at`,
      [actor.org_id, note.id, actor.id, signed.cms, contentDigest, body.documentType, body.councilNumber,
       body.councilState, signed.policyOid, timestampAuthority, signatureIsQualified,
       JSON.stringify(chain.path.map((c) => ({ subject: c.subject, serialNumber: c.serialNumber, validTo: c.validTo })))]
    );
    const record = inserted[0];

    // secretCode de uso público (Guia ITI Cap. IV): só o hash sai do processo.
    const secretCode = randomBytes(20).toString('hex');
    await this.db.query(
      'INSERT INTO signature_verify_codes(org_id,document_id,code_hash) VALUES($1,$2,$3)',
      [actor.org_id, record.id, hashVerifyCode(secretCode)]);

    await audit(this.db, actor, 'document.signed.pades', 'clinical_note', note.id, {
      signatureId: record.id,
      documentType: body.documentType,
      contentDigest,
      policyOid: signed.policyOid,
      timestampAuthority,
      signatureIsQualified,
      councilNumber: body.councilNumber,
      councilState: body.councilState
    });

    return {
      signatureId: record.id,
      noteId: note.id,
      documentType: body.documentType,
      contentDigest,
      policyOid: signed.policyOid,
      timestampAuthority,
      signatureIsQualified,
      signer: { id: actor.id, councilNumber: body.councilNumber, councilState: body.councilState },
      secretCode,
      createdAt: record.created_at
    };
  }

  /** Evidências de assinatura do encontro (sem CMS cru). */
  @Get('encounters/:encounterId/notes/signatures')
  async listSignatures(@Param('encounterId') encounterId: string, @Req() req: AuthedRequest) {
    const actor = req.actor;
    requireRole(actor, ['doctor', 'nurse']);
    parse(uuid, encounterId);
    const { rows } = await this.db.query(
      `SELECT ds.id, ds.document_type, ds.content_digest, ds.policy_oid, ds.timestamp_authority,
              ds.signature_is_qualified, ds.created_at, u.id AS signer_id, u.display_name AS signer_name
         FROM document_signatures ds
         JOIN clinical_notes cn ON cn.id = ds.note_id AND cn.org_id = ds.org_id
         JOIN users u ON u.id = ds.signer_user_id AND u.org_id = ds.org_id
        WHERE cn.encounter_id = $1 AND ds.org_id = $2
        ORDER BY ds.created_at DESC`,
      [encounterId, actor.org_id]);
    return {
      signatures: rows.map((r: any) => ({
        id: r.id,
        documentType: r.document_type,
        contentDigest: r.content_digest,
        policyOid: r.policy_oid,
        timestampAuthority: r.timestamp_authority,
        signatureIsQualified: r.signature_is_qualified,
        // Rótulo honesto tri-estado (nunca "assinatura válida" sem evidência):
        // qualified = carimbo de tempo + OIDs ITI; not_qualified = sem carimbo
        // (ex.: AD-RB); unknown = indeterminado na emissão.
        qualification: r.signature_is_qualified === true ? 'qualified'
          : r.signature_is_qualified === false ? 'not_qualified' : 'unknown',
        timestamped: Boolean(r.timestamp_authority),
        createdAt: r.created_at,
        signer: { id: r.signer_id, displayName: r.signer_name }
      }))
    };
  }

  /** Verificação sob demanda: reconstrói os bytes, valida CMS e cadeia com data atual. */
  @Post('signatures/verify')
  async verifySignature(@Body() raw: unknown, @Req() req: AuthedRequest) {
    const actor = req.actor;
    requireRole(actor, ['doctor']);
    const body = parse(verifySignatureRequestSchema, raw);

    const { rows } = await this.db.query(
      `SELECT id, note_id, cms, content_digest, document_type, council_number, council_state, policy_oid,
              timestamp_authority, signature_is_qualified, created_at
         FROM document_signatures WHERE id = $1 AND org_id = $2`,
      [body.signatureId, actor.org_id]);
    const signature = rows[0];
    if (!signature) throw new NotFoundException('Assinatura não encontrada');

    const { rows: noteRows } = await this.db.query(
      'SELECT id, version, content FROM clinical_notes WHERE id = $1 AND org_id = $2',
      [signature.note_id, actor.org_id]);
    const note = noteRows[0];
    if (!note) throw new NotFoundException('Nota clínica da assinatura não encontrada');

    const content = canonicalContentBytes({ noteId: note.id, version: Number(note.version), content: note.content });
    const verified = await verifyPades(Buffer.from(signature.cms), content);

    let chainValid = false;
    let chainReason: string | undefined;
    let chainPath: X509Certificate[] = [];
    let signer: { subject: string | null; fingerprint: string | null } = { subject: null, fingerprint: null };
    if (verified.signerCert) {
      signer = { subject: verified.signerCert.subject, fingerprint: verified.signerCert.fingerprint256 };
      try {
        const validation = validateChain(verified.signerCert, [], TrustStore.default(), new Date());
        chainValid = validation.ok;
        chainPath = validation.path; // [leaf, emissor, ...]: fonte do emissor p/ CertID do OCSP
        if (!validation.ok) chainReason = validation.reason;
      } catch (e) {
        chainValid = false;
        chainReason = e instanceof TrustStoreError ? e.message : 'falha ao carregar o trust store ICP-Brasil';
      }
    } else {
      chainReason = 'certificado do assinante ausente no CMS';
    }

    await audit(this.db, actor, 'document.signature.verified', 'document_signature', signature.id, {
      signatureValid: verified.signatureValid,
      chainValid,
      timestampPresent: verified.timestampPresent
    });

    const qualification = qualifySignature(
      verified.timestampPresent,
      typeof verified.policyOid === 'string' ? verified.policyOid.startsWith(OIDS.POLICY_ARC + '.') : null
    );

    // Revogação: pki/revocation.ts — REVOCATION_MODE=off|soft|hard (padrão off,
    // CI sem rede). Com o modo ativo o campo carrega o estado real do OCSP
    // (good|revoked|unknown|unavailable); com off, checked:false + motivo honesto
    // (NUNCA afirma "não revogado" sem consulta — pendência P0-06 agora opcional).
    const revocation = await checkRevocation({
      leaf: verified.signerCert,
      issuer: chainPath.length > 1 ? chainPath[1]
        : verified.signerCert && verified.signerCert.subject === verified.signerCert.issuer ? verified.signerCert : null,
      mode: revocationModeFromEnv()
    });

    return {
      signatureValid: verified.signatureValid,
      chainValid,
      ...(chainReason ? { chainReason } : {}),
      // Tri-estado honesto da qualificação (mesma semântica da emissão).
      qualification: qualification === true ? 'qualified' : qualification === false ? 'not_qualified' : 'unknown',
      revocation,
      signer,
      timestampPresent: verified.timestampPresent,
      policyOid: verified.policyOid,
      documentOids: verified.documentOids,
      councilNumber: verified.councilNumber,
      councilState: verified.councilState,
      checkedAt: new Date().toISOString()
    };
  }
}

// ---------------------------------------------------------------------------
// Rota pública do validador ITI (Guia ITI Cap. IV) — sem sessão.
// ---------------------------------------------------------------------------

@Controller('verify')
export class SignatureVerifyController {
  constructor(private readonly db: Db) {}

  @Public()
  @Get(':id')
  async verifyForItiValidator(
    @Param('id') id: string,
    @Query() query: Record<string, string | undefined>
  ) {
    if (query._format !== 'application/validador-iti+json')
      throw new BadRequestException('_format deve ser application/validador-iti+json (Guia ITI Cap. IV)');
    const documentType = itiQueryTypeToDocumentType(query.type ?? '');
    if (!documentType) throw new BadRequestException('type deve ser prescricao ou exame');
    if (!query._secretCode) throw new UnauthorizedException('Código de verificação ausente (_secretCode)');

    const parsedId = uuid.safeParse(id);
    if (!parsedId.success) throw new NotFoundException('Documento assinado não encontrado');

    // 1) Consumo ATÔMICO de uso único (J1: replay não reutiliza o código) — e é
    //    o PRIMEIRO passo de propósito: a tabela de códigos é "tier2" (lookup por
    //    segredo, antes do contexto de tenant) e o RETURNING entrega a org que
    //    resolve o contexto para ler document_signatures (tier1, RLS estrito).
    //    Código errado E código já usado respondem 401 com a MESMA mensagem.
    const expected = hashVerifyCode(query._secretCode);
    const consumed = await this.db.query<{ org_id: string }>(
      `UPDATE signature_verify_codes SET used_at = now()
        WHERE document_id = $1 AND code_hash = $2 AND used_at IS NULL
        RETURNING org_id`,
      [parsedId.data, expected]);
    if (!consumed.rowCount) throw new UnauthorizedException('Código de verificação inválido');
    setOrgContext(consumed.rows[0].org_id);

    // 2) Com o contexto de tenant publicado, a assinatura só aparece se pertencer
    //    à org do código (RLS) — e o tipo precisa bater com o pedido do ITI.
    const { rows } = await this.db.query(
      'SELECT id, document_type FROM document_signatures WHERE id = $1', [parsedId.data]);
    const signature = rows[0];
    if (!signature || signature.document_type !== documentType)
      throw new NotFoundException('Documento assinado não encontrado');

    const baseUrl = verifyBaseUrl();
    const documentKey = documentType === 'prescription' ? 'prescription' : 'examRequest';
    return {
      version: '1.0.0',
      [documentKey]: {
        signatureFiles: [{
          url: `${baseUrl}/${signature.id}/document?code=${encodeURIComponent(query._secretCode)}`
        }]
      }
    };
  }
}
