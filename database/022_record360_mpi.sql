-- StarMed 022: Prontuário 360° (ST-P1-001/002/003) — MPI/merge rastreável +
-- versionamento imutável de documentos clínicos.
--
-- 1) MPI/DEDUP: merge de pacientes NUNCA apaga histórico. O registro perdedor
--    permanece em `patients` com `merged_into_id` apontando para o mantido
--    (rastro legível), as filhas SOBEM de paciente numa transação auditada
--    (`patient_merges` guarda quem, quando, por quê e quantas linhas moveram).
--    A aplicação (mpi.ts) valida corrente (não fundir quem já foi fundido)
--    antes de mover qualquer linha.
--
-- 2) DOCUMENTOS VERSIONADOS: cada estado de `clinical_documents.content` vira
--    uma linha imutável em `document_versions` (sha256 + tipo de mudança).
--    Cobre automaticamente o embarque PAdES (UPDATE de content troca o PDF
--    atestado pelo embebido — v1 "created", v2 "content-updated"). Sem UPDATE
--    nem DELETE nesta tabela (append-only; a app nem tem revogado — ver 018).
--
-- ORDEM IMPORTANTE: backfill ANTES de habilitar RLS — o migrate roda como dono
-- sem GUC de tenant; com FORCE ligado o `INSERT ... SELECT` veria zero linhas.
-- Privilégios do papel da aplicação vêm do ALTER DEFAULT PRIVILEGES do 018.
BEGIN;

-- ---------------------------------------------------------------- 1) MPI ----
ALTER TABLE patients ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES patients(id);
CREATE INDEX IF NOT EXISTS patients_merged_into_idx ON patients(org_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS patient_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  keep_patient_id UUID NOT NULL,
  merged_patient_id UUID NOT NULL,
  performed_by UUID NOT NULL REFERENCES users(id),
  merge_reason TEXT NOT NULL CHECK (length(merge_reason) BETWEEN 20 AND 500),
  moved_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (keep_patient_id, merged_patient_id),
  FOREIGN KEY (keep_patient_id, org_id) REFERENCES patients(id, org_id),
  FOREIGN KEY (merged_patient_id, org_id) REFERENCES patients(id, org_id),
  CHECK (keep_patient_id <> merged_patient_id)
);
CREATE INDEX IF NOT EXISTS patient_merges_org_idx ON patient_merges(org_id, created_at DESC);
-- Um paciente só pode SER fundido uma vez (nunca o mesmo perdedor duas vezes).
CREATE UNIQUE INDEX IF NOT EXISTS patient_merges_merged_unique
  ON patient_merges(org_id, merged_patient_id);

-- ------------------------------------------------- 2) versionamento docs ----
CREATE TABLE IF NOT EXISTS document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL REFERENCES clinical_documents(id),
  version INT NOT NULL CHECK (version >= 1),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  mime_type TEXT,
  change_kind TEXT NOT NULL DEFAULT 'created' CHECK (change_kind IN ('created', 'content-updated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (document_id, version)
);
CREATE INDEX IF NOT EXISTS document_versions_doc_idx
  ON document_versions(org_id, document_id, version DESC);

-- Backfill do estado atual como v1 (histórico começa na observação do 022;
-- alterações futuras de conteúdo acrescentam v2+ pelo gatilho abaixo).
INSERT INTO document_versions (org_id, document_id, version, sha256, mime_type, change_kind, created_at)
SELECT org_id, id, 1, sha256, mime_type, 'created', created_at
FROM clinical_documents
WHERE sha256 IS NOT NULL
ON CONFLICT (document_id, version) DO NOTHING;

CREATE OR REPLACE FUNCTION document_versions_append() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO document_versions (org_id, document_id, version, sha256, mime_type, change_kind)
    VALUES (NEW.org_id, NEW.id, 1, NEW.sha256, NEW.mime_type, 'created')
    ON CONFLICT (document_id, version) DO NOTHING;
    RETURN NEW;
  END IF;
  -- UPDATE de conteúdo (embarque PAdES): anexa o novo estado como próxima versão.
  INSERT INTO document_versions (org_id, document_id, version, sha256, mime_type, change_kind)
  SELECT NEW.org_id, NEW.id, COALESCE(MAX(version), 0) + 1, NEW.sha256, NEW.mime_type, 'content-updated'
  FROM document_versions WHERE document_id = NEW.id
  ON CONFLICT (document_id, version) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clinical_documents_versions ON clinical_documents;
CREATE TRIGGER clinical_documents_versions
AFTER INSERT OR UPDATE OF content, sha256 ON clinical_documents
FOR EACH ROW EXECUTE FUNCTION document_versions_append();

-- ------------------------------------------------------------- 3) RLS ------
-- Tabelas novas com org_id fora do scan do 018: política tier1 idêntica
-- (leitura sem tenant = vazio; escrita sem tenant = rejeitada) + FORCE.
ALTER TABLE patient_merges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_merges_org_isolation ON patient_merges;
CREATE POLICY patient_merges_org_isolation ON patient_merges
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE patient_merges FORCE ROW LEVEL SECURITY;

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_versions_org_isolation ON document_versions;
CREATE POLICY document_versions_org_isolation ON document_versions
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;

COMMIT;
