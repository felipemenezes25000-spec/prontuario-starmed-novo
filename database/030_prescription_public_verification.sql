-- StarMed 030: verificação pública da receita por token + código impresso no PDF
-- (lote 4 do porte do repositório de referência: VerificationService.cs,
-- 20260801_prescriptions_verify_code_salt.sql, Verify.tsx).
--
-- Diferenças DE PROPÓSITO em relação à referência:
--  * a etapa SEM código não mostra medicamento (revelaria condição de saúde):
--    só autenticidade — tipo, situação, datas, prescritor (CRM/UF), nível de
--    assinatura e SHA-256 do PDF; paciente apenas pelas iniciais;
--  * o identificador da URL/QR é um TOKEN ALEATÓRIO (não o UUID da prescrição);
--  * o código vem com HMAC-SHA256 + sal por documento desde o início (a
--    referência precisou migrar de SHA-256 sem sal) e há bloqueio após erros.
--
-- Tier2 (padrão 018): o lookup por token ANTECEDE o contexto de tenant; a
-- policy permite leitura sem contexto e vira estrita quando ele existe. O
-- controller nunca lista a tabela: sempre filtra pelo token exato.
-- Migração de execução única (schema_migrations + sha256).
BEGIN;

CREATE TABLE prescription_verifications (
  prescription_id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id),
  public_token TEXT NOT NULL UNIQUE CHECK (public_token ~ '^[A-Za-z0-9_-]{22,64}$'),
  code_salt BYTEA NOT NULL CHECK (length(code_salt) = 16),
  code_hmac BYTEA NOT NULL CHECK (length(code_hmac) = 32),
  failed_attempts INT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (prescription_id) REFERENCES prescriptions(id)
);
CREATE INDEX prescription_verifications_org_idx ON prescription_verifications(org_id);

ALTER TABLE prescription_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prescription_verifications_org_isolation ON prescription_verifications;
CREATE POLICY prescription_verifications_org_isolation ON prescription_verifications
  USING (current_org_id() IS NULL OR org_id = current_org_id())
  WITH CHECK (current_org_id() IS NULL OR org_id = current_org_id());
ALTER TABLE prescription_verifications NO FORCE ROW LEVEL SECURITY;

COMMIT;
