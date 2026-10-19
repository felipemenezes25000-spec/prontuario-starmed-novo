-- StarMed 007: interoperability message ledger (HL7v2 / TISS / NFSe payloads).
-- Stores inbound/outbound integration messages per organization for audit and replay.
BEGIN;
CREATE TABLE inbound_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  protocol TEXT,
  message_type TEXT,
  external_control_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','rejected')),
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inbound_messages_org_created_idx ON inbound_messages(org_id, created_at DESC);
COMMIT;
