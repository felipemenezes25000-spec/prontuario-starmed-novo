-- StarMed 005: MFA (TOTP + recovery codes) and OIDC SSO plumbing.
-- Secrets are stored sealed (AES-256-GCM) by the API; recovery codes are stored hashed.
BEGIN;

ALTER TABLE users ADD COLUMN mfa_secret TEXT;
ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN mfa_enrolled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN sso_subject TEXT;
ALTER TABLE users ADD COLUMN sso_issuer TEXT;

CREATE UNIQUE INDEX users_sso_subject_unique ON users(sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL;

CREATE TABLE mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, user_id, code_hash),
  FOREIGN KEY(user_id,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes(org_id,user_id);

-- Single-use short-lived SSO authorization flows (PKCE verifier + nonce).
CREATE TABLE sso_flows (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX sso_flows_expiry_idx ON sso_flows(expires_at);

COMMIT;
