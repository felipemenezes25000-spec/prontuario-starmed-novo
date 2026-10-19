-- StarMed 011: hospitalar — leitos, admissões (ADT), antimicrobianos 344,
-- pedidos diagnósticos LIS/PACS. EXCLUDE gist impede dupla ocupação do leito.
BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE hospital_wards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  specialty TEXT NOT NULL DEFAULT 'general',
  UNIQUE(org_id, code),
  UNIQUE(id, org_id)
);

CREATE TABLE hospital_beds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  ward_id UUID NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','cleaning','maintenance')),
  UNIQUE(org_id, ward_id, label),
  UNIQUE(id, org_id),
  FOREIGN KEY(ward_id,org_id) REFERENCES hospital_wards(id,org_id)
);
CREATE INDEX hospital_beds_status_idx ON hospital_beds(org_id, status);

CREATE TABLE hospital_admissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  patient_id UUID NOT NULL,
  encounter_id UUID,
  ward_id UUID NOT NULL,
  bed_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted','transferred','discharged')),
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  discharged_at TIMESTAMPTZ,
  discharge_disposition TEXT CHECK (discharge_disposition IN ('home','transfer_other','deceased','left_without_permission')),
  UNIQUE(id,org_id),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id),
  FOREIGN KEY(ward_id,org_id) REFERENCES hospital_wards(id,org_id),
  FOREIGN KEY(bed_id,org_id) REFERENCES hospital_beds(id,org_id),
  -- Uma admissão ativa por leito (cobre admitido e em transferência dentro do mesmo range).
  CONSTRAINT hospital_beds_no_overlap EXCLUDE USING gist (
    org_id WITH =,
    bed_id WITH =,
    tstzrange(admitted_at, COALESCE(discharged_at, 'infinity'::timestamptz), '[)') WITH &&
  ) WHERE (status IN ('admitted','transferred'))
);
CREATE INDEX hospital_admissions_patient_idx ON hospital_admissions(org_id, patient_id, admitted_at DESC);
CREATE INDEX hospital_admissions_status_idx ON hospital_admissions(org_id, status);

CREATE TABLE antimicrobial_344 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  admission_id UUID,
  patient_id UUID NOT NULL,
  medication_name TEXT NOT NULL,
  tuss_code TEXT,
  justification TEXT NOT NULL CHECK (length(btrim(justification)) BETWEEN 20 AND 2000),
  prescriber_id UUID NOT NULL,
  culture_sent BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','suspended')),
  suspend_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id),
  FOREIGN KEY(admission_id,org_id) REFERENCES hospital_admissions(id,org_id),
  FOREIGN KEY(prescriber_id,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX antimicrobial_344_admission_idx ON antimicrobial_344(org_id, admission_id);

CREATE TABLE diagnostic_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  patient_id UUID NOT NULL,
  requester_id UUID NOT NULL,
  order_type TEXT NOT NULL CHECK (order_type IN ('lab','imaging')),
  loinc_code TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','in_progress','completed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent')),
  result_summary TEXT,
  pacs_url TEXT,
  ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id),
  FOREIGN KEY(requester_id,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX diagnostic_orders_patient_idx ON diagnostic_orders(org_id, patient_id, ordered_at DESC);
CREATE INDEX diagnostic_orders_status_idx ON diagnostic_orders(org_id, status);

COMMIT;
