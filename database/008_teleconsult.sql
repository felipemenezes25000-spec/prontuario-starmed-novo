-- StarMed 008: teleconsulta (salas, signaling append-only, convites single-use).
BEGIN;

CREATE TABLE teleconsult_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  encounter_id UUID NOT NULL UNIQUE REFERENCES encounters(id),
  appointment_id UUID,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','open','closed')),
  recording_consent BOOLEAN,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  FOREIGN KEY(created_by,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX teleconsult_rooms_org_idx ON teleconsult_rooms(org_id, created_at DESC);

CREATE TABLE teleconsult_signals (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES teleconsult_rooms(id),
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('clinician','patient')),
  kind TEXT NOT NULL CHECK (kind IN ('offer','answer','ice','bye')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  seq INT NOT NULL CHECK (seq > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(room_id, seq)
);
CREATE TRIGGER teleconsult_signals_append_only
BEFORE UPDATE OR DELETE ON teleconsult_signals
FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

CREATE TABLE teleconsult_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  room_id UUID NOT NULL REFERENCES teleconsult_rooms(id),
  patient_id UUID NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id)
);
CREATE INDEX teleconsult_invites_room_idx ON teleconsult_invites(room_id);

COMMIT;
