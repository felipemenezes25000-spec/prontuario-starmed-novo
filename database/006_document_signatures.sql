-- Migration 006: evidências de assinatura PAdES/ICP-Brasil dos documentos clínicos.
-- Cada linha é a evidência (CMS detached) de uma nota clínica assinada com certificado
-- ICP-Brasil, mais os metadados de qualificação exigidos pelo Guia do ITI.
-- Os códigos de verificação pública (Guia ITI Cap. IV) vivem em tabela SEPARADA:
-- document_signatures é append-only (trigger abaixo), e o consumo do código exige
-- UPDATE (used_at). Colocar code_hash/used_at na própria document_signatures faria o
-- trigger de imutabilidade barar o consumo do código.
BEGIN;

CREATE TABLE document_signatures (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 note_id UUID NOT NULL,
 signer_user_id UUID NOT NULL,
 cms BYTEA NOT NULL,
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
 document_type TEXT NOT NULL CHECK(document_type IN ('prescription','exam-request')),
 council_number TEXT NOT NULL CHECK(council_number ~ '^[0-9]{4,6}$'),
 council_state TEXT NOT NULL CHECK(council_state ~ '^[A-Z]{2}$'),
 policy_oid TEXT NOT NULL,
 -- URL efetiva da autoridade de carimbo de tempo; NULL quando não há carimbo.
 timestamp_authority TEXT,
 -- true SÓ quando OIDs ITI + carimbo entraram no CMS; NULL = qualificação desconhecida
 -- (nunca false silencioso — false só com avaliação positiva de ausência de carimbo).
 signature_is_qualified BOOLEAN,
 -- caminho de cadeia validado no momento da emissão (JSON: subject/serial de cada cert).
 signature_path TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(note_id, content_digest),
 FOREIGN KEY(note_id,org_id) REFERENCES clinical_notes(id,org_id),
 FOREIGN KEY(signer_user_id,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX document_signatures_note_idx ON document_signatures(org_id, note_id, created_at DESC);
CREATE INDEX document_signatures_signer_idx ON document_signatures(org_id, signer_user_id);

-- Códigos de verificação pública (validador ITI): guarda apenas o HASH do secretCode
-- (normalizado: sem hífen, caixa baixa, SHA-256 hex), nunca o secret em claro.
-- Uso único: o endpoint de download do documento marca used_at; código consumido (ou
-- qualquer tentativa de adulteração da evidência) nunca passa despercebido.
CREATE TABLE signature_verify_codes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 document_id UUID NOT NULL REFERENCES document_signatures(id),
 code_hash TEXT NOT NULL CHECK(length(code_hash)=64),
 used_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(code_hash)
);
CREATE INDEX signature_verify_codes_document_idx ON signature_verify_codes(org_id, document_id);

-- Imutabilidade: evidências de assinatura são append-only, reaproveitando o mesmo
-- trigger de audit_events (forbid_audit_change já existe no schema base).
CREATE TRIGGER document_signatures_append_only BEFORE UPDATE OR DELETE ON document_signatures
FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

COMMIT;
