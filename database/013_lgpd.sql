-- StarMed 013: direitos do titular de dados (LGPD/ANPD) — pedidos de acesso,
-- portabilidade, correção, exclusão/anonimização e revogação de consentimento.
-- Todo atendimento a pedido gera trilha auditável (lgpd_requests + audit_events).
BEGIN;

CREATE TABLE lgpd_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  patient_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access','portability','correction','deletion','anonymization','consent_revocation')),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','in_progress','completed','refused')),
  deadline_days INT NOT NULL DEFAULT 15 CHECK (deadline_days BETWEEN 1 AND 15),
  due_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 days'),
  fulfilled_at TIMESTAMPTZ,
  refused_reason TEXT,
  requested_channel TEXT NOT NULL DEFAULT 'portal' CHECK (requested_channel IN ('portal','in_person','phone','email')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id),
  CHECK ((status='completed' AND fulfilled_at IS NOT NULL) OR (status<>'completed' AND fulfilled_at IS NULL)),
  CHECK ((status='refused' AND refused_reason IS NOT NULL) OR (status<>'refused'))
);
CREATE INDEX lgpd_requests_org_idx ON lgpd_requests(org_id, status, due_at);
CREATE INDEX lgpd_requests_patient_idx ON lgpd_requests(org_id, patient_id, created_at DESC);

-- Consentimento versionado por finalidade (opt-in; revogação é append-only).
CREATE TABLE lgpd_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  patient_id UUID NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('treatment','research','marketing','ai_training','third_party_sharing')),
  granted BOOLEAN NOT NULL,
  recorded_by UUID,
  source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','portal')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id)
);
CREATE INDEX lgpd_consents_latest_idx ON lgpd_consents(org_id, patient_id, purpose, created_at DESC);
CREATE TRIGGER lgpd_consents_append_only
BEFORE UPDATE OR DELETE ON lgpd_consents
FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

COMMIT;
