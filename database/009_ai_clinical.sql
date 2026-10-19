-- StarMed 009: sugestões de IA com revisão humana obrigatória (CFM 2.454/2026).
BEGIN;

CREATE TABLE ai_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  encounter_id UUID,
  patient_id UUID,
  kind TEXT NOT NULL CHECK (kind IN ('dictation','discharge-summary','code-suggestion')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  model TEXT,
  created_by UUID NOT NULL,
  reviewed_by UUID,
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(encounter_id,org_id) REFERENCES encounters(id,org_id),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id),
  FOREIGN KEY(created_by,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY(reviewed_by,org_id) REFERENCES users(id,org_id),
  CHECK ((status='pending' AND reviewed_at IS NULL) OR (status<>'pending' AND reviewed_at IS NOT NULL))
);
CREATE INDEX ai_suggestions_org_idx ON ai_suggestions(org_id, created_at DESC);
CREATE INDEX ai_suggestions_review_idx ON ai_suggestions(org_id, status, created_at DESC) WHERE status='pending';

-- Revisão acontece UMA vez: pending → accepted|rejected não pode virar outra coisa depois.
CREATE FUNCTION forbid_suggestion_rereview() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' AND (NEW.status <> OLD.status OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at) THEN
    RAISE EXCEPTION 'Sugestão de IA já revisada é imutável';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_suggestions_review_once
BEFORE UPDATE ON ai_suggestions
FOR EACH ROW EXECUTE FUNCTION forbid_suggestion_rereview();

COMMIT;
