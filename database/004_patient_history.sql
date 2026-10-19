-- StarMed 004: structured patient allergy and problem records.
-- Records are not auto-populated by AI; clinicians are responsible for verification.
BEGIN;
CREATE TABLE patient_allergies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  patient_id UUID NOT NULL,
  recorded_by UUID NOT NULL,
  substance TEXT NOT NULL CHECK(length(btrim(substance)) BETWEEN 2 AND 200),
  reaction TEXT,
  criticality TEXT NOT NULL DEFAULT 'unable-to-assess' CHECK(criticality IN ('low','high','unable-to-assess')),
  clinical_status TEXT NOT NULL DEFAULT 'active' CHECK(clinical_status IN ('active','inactive','resolved')),
  verification_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(verification_status IN ('unconfirmed','confirmed')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id),
  FOREIGN KEY(recorded_by,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX patient_allergies_patient_idx ON patient_allergies(org_id,patient_id,recorded_at DESC);

CREATE TABLE patient_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  patient_id UUID NOT NULL,
  recorded_by UUID NOT NULL,
  display TEXT NOT NULL CHECK(length(btrim(display)) BETWEEN 3 AND 300),
  code_system TEXT,
  code TEXT,
  clinical_status TEXT NOT NULL DEFAULT 'active' CHECK(clinical_status IN ('active','resolved')),
  verification_status TEXT NOT NULL DEFAULT 'provisional' CHECK(verification_status IN ('provisional','confirmed')),
  onset_date DATE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id),
  FOREIGN KEY(recorded_by,org_id) REFERENCES users(id,org_id),
  CHECK ((code IS NULL AND code_system IS NULL) OR (code IS NOT NULL AND code_system IS NOT NULL))
);
CREATE INDEX patient_conditions_patient_idx ON patient_conditions(org_id,patient_id,recorded_at DESC);
COMMIT;
