-- StarMed 027: IA governada + hospitalar (Fase 8, ST-P1-013 e P1/ST-P1-006).
--
-- A) PROVENANCE das sugestões de IA (Fase 8): cada sugestão carrega qual
--    PROMPT/versão a gerou e QUANDO gerada — modelo já existe no009, as
--    incertezas já vivem em payload. A auditoria de aceite/rejeição/edição
--    permanece nos audit_events (nada de PHI novo aqui: só metadados).
--
-- B) ADMINISTRAÇÃO de medicação — fluxo de ENFERMAGEM (checagem): registro do
--    que foi efetivamente administrado ao INTERNO, com barcode OPCIONAL (a
--    checagem por código só entra quando o mercado/regulação exigir — nada de
--    scanner obrigatório hoje). Prescrição opcional: a checagem de planta pode
--    ser lançada sem vínculo; quando vier de prescrição, a FK garante a
--    integridade. NÃO administra nada sozinho: é livro de registro.
--
-- RLS tier1 (padrão do018): policy org_id + FORCE na role app.
-- Migração de execução única (schema_migrations + sha256).
BEGIN;

ALTER TABLE ai_suggestions
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ;

CREATE TABLE medication_administrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  admission_id UUID NOT NULL,
  prescription_id UUID,
  medication_name TEXT NOT NULL,
  dose TEXT,
  route TEXT,
  barcode TEXT,
  note TEXT,
  administered_by UUID NOT NULL,
  administered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id, org_id),
  FOREIGN KEY(admission_id, org_id) REFERENCES hospital_admissions(id, org_id),
  FOREIGN KEY(prescription_id) REFERENCES prescriptions(id),
  FOREIGN KEY(administered_by, org_id) REFERENCES users(id, org_id)
);
CREATE INDEX med_admin_admission_idx
  ON medication_administrations(org_id, admission_id, administered_at DESC);
CREATE INDEX med_admin_org_idx
  ON medication_administrations(org_id, administered_at DESC);

ALTER TABLE medication_administrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS med_admin_tenant ON medication_administrations;
CREATE POLICY med_admin_tenant ON medication_administrations
  USING (org_id = current_setting('starmed.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('starmed.org_id', true)::uuid);
ALTER TABLE medication_administrations FORCE ROW LEVEL SECURITY;

COMMIT;
