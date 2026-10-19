-- StarMed 010: portal do paciente (contas, convites single-use, CRM outbox,
-- solicitações de agendamento). LGPD: cada conta vê apenas o próprio cadastro.
BEGIN;

CREATE TABLE portal_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  patient_id UUID NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  auth_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, patient_id),
  UNIQUE(org_id, email)
);
CREATE INDEX portal_accounts_email_idx ON portal_accounts(org_id, lower(email));

CREATE TABLE portal_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  patient_id UUID NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id),
  FOREIGN KEY(created_by,org_id) REFERENCES users(id,org_id)
);

CREATE TABLE crm_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email','sms')),
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  rendered TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  provider_message_id TEXT,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_outbox_status_idx ON crm_outbox(org_id, status, created_at DESC);

CREATE TABLE appointment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  patient_id UUID NOT NULL,
  preferred_specialty TEXT NOT NULL,
  preferred_period TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','scheduled','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(patient_id,org_id) REFERENCES patients(id,org_id)
);
CREATE INDEX appointment_requests_org_idx ON appointment_requests(org_id, status, created_at DESC);

COMMIT;
