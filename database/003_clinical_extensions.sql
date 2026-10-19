-- StarMed 003: immutable signed-note addenda and appointment conflict protection.
-- Run once on a reviewed backup; existing overlapping appointments must be resolved first.
BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE appointments ADD COLUMN scheduled_end_at TIMESTAMPTZ;
UPDATE appointments SET scheduled_end_at=scheduled_at+(duration_minutes * interval '1 minute');
ALTER TABLE appointments ALTER COLUMN scheduled_end_at SET NOT NULL;
ALTER TABLE appointments ADD CONSTRAINT appointments_valid_interval CHECK (scheduled_end_at>scheduled_at);
ALTER TABLE appointments ADD CONSTRAINT appointments_duration_matches CHECK (scheduled_end_at=scheduled_at+(duration_minutes * interval '1 minute'));
ALTER TABLE appointments ADD CONSTRAINT appointments_practitioner_no_overlap EXCLUDE USING gist (
  org_id WITH =,
  practitioner_id WITH =,
  tstzrange(scheduled_at,scheduled_end_at,'[)') WITH &&
) WHERE (status IN ('scheduled','checked_in'));

CREATE TABLE clinical_note_addenda (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  note_id UUID NOT NULL,
  author_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 8 AND 1000),
  content TEXT NOT NULL CHECK(length(btrim(content)) BETWEEN 10 AND 10000),
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(note_id,org_id) REFERENCES clinical_notes(id,org_id),
  FOREIGN KEY(author_id,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX clinical_note_addenda_note_idx ON clinical_note_addenda(org_id,note_id,signed_at);
CREATE TRIGGER clinical_addenda_immutable
BEFORE UPDATE OR DELETE ON clinical_note_addenda
FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();
COMMIT;
