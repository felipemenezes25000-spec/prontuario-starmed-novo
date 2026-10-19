-- StarMed MVP schema. Execute only on a new disposable DB or through reviewed migrations.
-- No production migration strategy or RLS is assumed.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 name TEXT NOT NULL,
 ai_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 email TEXT NOT NULL,
 display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK (role IN ('admin','doctor','nurse','reception')),
 active BOOLEAN NOT NULL DEFAULT TRUE,
 auth_version INT NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(org_id, email), UNIQUE(id,org_id)
);
CREATE UNIQUE INDEX users_email_lower_unique ON users(org_id, lower(email));

CREATE TABLE patients (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 external_id TEXT,
 full_name TEXT NOT NULL,
 birth_date DATE NOT NULL,
 administrative_gender TEXT CHECK (administrative_gender IN ('male','female','other','unknown')),
 phone TEXT,
 insurance_id TEXT,
 social_determinants JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(id,org_id),
 UNIQUE(org_id,external_id)
);
CREATE INDEX patients_name_idx ON patients(org_id,lower(full_name));

CREATE TABLE appointments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 patient_id UUID NOT NULL,
 practitioner_id UUID NOT NULL,
 scheduled_at TIMESTAMPTZ NOT NULL,
 duration_minutes INT NOT NULL DEFAULT 30 CHECK(duration_minutes BETWEEN 5 AND 720),
 status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','checked_in','completed','cancelled','no_show')),
 kind TEXT NOT NULL DEFAULT 'consultation' CHECK(kind IN ('consultation','follow_up','teleconsultation')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(id,org_id),
 FOREIGN KEY (patient_id,org_id) REFERENCES patients(id,org_id),
 FOREIGN KEY (practitioner_id,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX appointments_schedule_idx ON appointments(org_id, scheduled_at);

CREATE TABLE encounters (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 patient_id UUID NOT NULL,
 doctor_id UUID NOT NULL,
 appointment_id UUID,
 specialty TEXT NOT NULL DEFAULT 'general',
 type TEXT NOT NULL CHECK(type IN ('consultation','follow_up','emergency','teleconsultation')),
 status TEXT NOT NULL DEFAULT 'in-progress' CHECK(status IN ('planned','in-progress','finished','cancelled')),
 reason_for_visit TEXT NOT NULL DEFAULT '',
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 ended_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(id,org_id),
 FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id),
 FOREIGN KEY(doctor_id,org_id) REFERENCES users(id,org_id),
 FOREIGN KEY(appointment_id,org_id) REFERENCES appointments(id,org_id)
);
CREATE INDEX encounters_patient_idx ON encounters(org_id,patient_id,started_at DESC);

CREATE TABLE clinical_notes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 encounter_id UUID NOT NULL,
 author_id UUID NOT NULL,
 signed_by UUID,
 template_id TEXT NOT NULL,
 content JSONB NOT NULL DEFAULT '{"sections":{}}'::jsonb CHECK(jsonb_typeof(content)='object'),
 version INT NOT NULL DEFAULT 1 CHECK(version>=1),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','signed')),
 signed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(encounter_id), UNIQUE(id,org_id),
 FOREIGN KEY(encounter_id,org_id) REFERENCES encounters(id,org_id),
 FOREIGN KEY(author_id,org_id) REFERENCES users(id,org_id),
 FOREIGN KEY(signed_by,org_id) REFERENCES users(id,org_id),
 CHECK ((status='draft' AND signed_at IS NULL AND signed_by IS NULL) OR
        (status='signed' AND signed_at IS NOT NULL AND signed_by IS NOT NULL))
);

CREATE TABLE prescriptions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 encounter_id UUID NOT NULL,
 prescriber_id UUID NOT NULL,
 medication_code TEXT,
 medication_name TEXT NOT NULL,
 dose TEXT,
 route TEXT,
 frequency TEXT,
 duration TEXT,
 instructions TEXT,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','cancelled','signed')),
 signed_document_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(encounter_id,org_id) REFERENCES encounters(id,org_id),
 FOREIGN KEY(prescriber_id,org_id) REFERENCES users(id,org_id)
);

CREATE TABLE clinical_documents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 patient_id UUID NOT NULL,
 encounter_id UUID,
 doc_type TEXT NOT NULL,
 storage_key TEXT NOT NULL,
 mime_type TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 created_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id),
 FOREIGN KEY(encounter_id,org_id) REFERENCES encounters(id,org_id),
 FOREIGN KEY(created_by,org_id) REFERENCES users(id,org_id)
);

CREATE TABLE billing (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 encounter_id UUID NOT NULL,
 amount_cents BIGINT NOT NULL CHECK(amount_cents >= 0),
 currency CHAR(3) NOT NULL DEFAULT 'BRL',
 payer_name TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(encounter_id,org_id) REFERENCES encounters(id,org_id)
);

CREATE TABLE inventory (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 sku TEXT NOT NULL,
 description TEXT NOT NULL,
 quantity NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(quantity>=0),
 unit TEXT NOT NULL DEFAULT 'unit',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(org_id,sku)
);

CREATE TABLE audit_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 actor_id UUID,
 action TEXT NOT NULL,
 target_type TEXT NOT NULL,
 target_id UUID,
 details JSONB NOT NULL DEFAULT '{}'::jsonb,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(actor_id,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX audit_events_org_time_idx ON audit_events(org_id, occurred_at DESC);

CREATE TABLE idempotency_keys (
 org_id UUID NOT NULL REFERENCES organizations(id),
 key UUID NOT NULL,
 operation TEXT NOT NULL,
 response JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,key)
);

CREATE FUNCTION forbid_signed_note_mutations() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='signed' THEN
    RAISE EXCEPTION 'Signed clinical notes are immutable. Append an amendment instead.';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER clinical_notes_immutable BEFORE UPDATE OR DELETE ON clinical_notes
FOR EACH ROW EXECUTE FUNCTION forbid_signed_note_mutations();

CREATE FUNCTION forbid_audit_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are append-only';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

COMMIT;
