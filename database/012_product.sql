-- StarMed 012: camada de produto — templates clínicos versionados, execuções
-- de importação CSV, ajustes por organização.
BEGIN;

CREATE TABLE clinical_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  specialty TEXT NOT NULL DEFAULT 'general' CHECK (specialty IN ('general','cardiology','orthopedics','pediatrics','neurology','psychiatry')),
  sections JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sections)='object'),
  version INT NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(created_by,org_id) REFERENCES users(id,org_id),
  UNIQUE(org_id, code, version)
);
CREATE INDEX clinical_templates_lookup_idx ON clinical_templates(org_id, code, version DESC);
CREATE INDEX clinical_templates_status_idx ON clinical_templates(org_id, status, specialty);

CREATE TABLE import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('patients','templates')),
  filename TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  total_rows INT NOT NULL DEFAULT 0,
  valid_rows INT NOT NULL DEFAULT 0,
  invalid_rows INT NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors)='array'),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  FOREIGN KEY(created_by,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX import_runs_org_idx ON import_runs(org_id, created_at DESC);

CREATE TABLE org_settings (
  org_id UUID PRIMARY KEY REFERENCES organizations(id),
  ai_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  require_mfa_for_admins BOOLEAN NOT NULL DEFAULT FALSE,
  teleconsult_default_minutes INT NOT NULL DEFAULT 30 CHECK (teleconsult_default_minutes BETWEEN 5 AND 120),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
