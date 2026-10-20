-- Migration 019: prescrição eletrônica com PAdES (critérios C6 e J1 #8/#9/#10).
--
-- 1) clinical_documents.content: os bytes do PDF deixa de ser "perdidos" (antes só
--    o sha256 era persistido — o artefato assinável não existia no banco). O
--    endpoint GET /prescriptions/:id/pdf e a assinatura PAdES leem exatamente
--    estes bytes e conferem o hash antes de servir/assinar.
-- 2) document_signatures.prescription_id: a evidência PAdES pode apontar uma
--    PRESCRIÇÃO (note_id NULL) em vez de nota clínica; note_id deixa de ser
--    obrigatório. O CHECK de document_type já admite 'prescription' (006).
--
-- Transacional e idempotente: ADD COLUMN IF NOT EXISTS; constraints nomeadas
-- verificadas em DO antes do ADD CONSTRAINT; ALTER COLUMN ... DROP NOT NULL é
-- naturalmente idempotente (repetir é no-op). Sem comandos de cliente (psql).
BEGIN;

ALTER TABLE clinical_documents ADD COLUMN IF NOT EXISTS content BYTEA;

ALTER TABLE document_signatures ADD COLUMN IF NOT EXISTS prescription_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_signatures_prescription_id_fkey'
  ) THEN
    ALTER TABLE document_signatures
      ADD CONSTRAINT document_signatures_prescription_id_fkey
      FOREIGN KEY (prescription_id) REFERENCES prescriptions(id);
  END IF;
END $$;

-- Evidência de prescrição tem note_id NULL (a FK composta note_id/org_id do 006
-- aceita NULL; o escopo de tenant continua garantido por org_id + RLS).
ALTER TABLE document_signatures ALTER COLUMN note_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS document_signatures_prescription_idx
  ON document_signatures(org_id, prescription_id, created_at DESC)
  WHERE prescription_id IS NOT NULL;

-- UMA evidência PAdES por prescrição: document_signatures é append-only (trigger
-- 006), então re-emissão concorrente não pode duplicar evidência — a corrida
-- estoura em violação desta unique e a aplicação converte em 409 honesto.
CREATE UNIQUE INDEX IF NOT EXISTS document_signatures_prescription_uniq
  ON document_signatures(prescription_id)
  WHERE prescription_id IS NOT NULL;

COMMIT;
