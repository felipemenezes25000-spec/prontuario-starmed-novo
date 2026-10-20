-- StarMed 018: RLS REAL (P0-05 / ST-P0-005) — cobertura total, papel de
-- aplicação não-owner e política em dois níveis.
--
-- O que muda em relação ao 014 (opt-in):
--   1. TODA tabela com coluna org_id recebe policy (o 014 tinha lista fixa e
--      deixou de fora, por exemplo, clinical_documents, billing, inventory,
--      org_settings e mfa_recovery_codes). teleconsult_signals ganha org_id.
--   2. Papel de aplicação `starmed_app`: NÃO é dono, NÃO é superuser, NÃO tem
--      BYPASSRLS. Em produção a API conecta com ele e as policies valem de fato
--      (mesmo sem FORCE). O CI também roda a API com ele — é lá que o
--      isolamento é provado (scripts/db/setup-app-role.mjs dá login à senha).
--   3. FORCE ROW LEVEL SECURITY nas tabelas de DADO (tier1): nem o dono
--      não-superusuário contorna. Observação operacional: em dev/CI o dono é
--      superusuário (contorna mesmo com FORCE) e os jobs de backup/worker
--      devem rodar como dono/serviço privilegiado OU com a org certa setada —
--      produção: ver runbook.
--
-- MODELO EM DOIS NÍVEIS (não é atalho: é a semântica correta):
--   tier1 (dado clínico/negócio): policy ESTRICTA — sem contexto de tenant a
--     leitura devolve vazio e a escrita é rejeitada (fail-closed). Todo caminho
--     autenticado publica o contexto via requestContext/setOrgContext (guard,
--     sessão do portal, convite/código de verificação, audit()).
--   tier2 (credencial/capabilidade pré-autenticação: users, portal_accounts,
--     portal_invites, teleconsult_invites, signature_verify_codes): o lookup
--     ANTEDEDE ao contexto de tenant (login por e-mail, convite por segredo,
--     código do validador ITI). A policy permite leitura/escrita SEM contexto —
--     protegidas por segredo hasheado + filtro da aplicação + auditoria — e
--     vira estrita ASSIM QUE o contexto existe (todas as rotas autenticadas).
--     Nunca devolver essas tabelas inteiras numa rota: o filtro por e-mail/id
--     continua obrigatório no código.
BEGIN;

-- 1) teleconsult_signals sem org_id: adicionar, backfill pela sala e tornar NOT NULL.
ALTER TABLE teleconsult_signals ADD COLUMN IF NOT EXISTS org_id UUID;
UPDATE teleconsult_signals s SET org_id = r.org_id
  FROM teleconsult_rooms r WHERE r.id = s.room_id AND s.org_id IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM teleconsult_signals WHERE org_id IS NULL) THEN
    ALTER TABLE teleconsult_signals ALTER COLUMN org_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teleconsult_signals_org_fk'
      AND conrelid = 'teleconsult_signals'::regclass
  ) THEN
    ALTER TABLE teleconsult_signals
      ADD CONSTRAINT teleconsult_signals_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS teleconsult_signals_org_idx ON teleconsult_signals(org_id);

-- 2) Papel de aplicação (não-owner, sem BYPASSRLS, sem superuser).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'starmed_app') THEN
    CREATE ROLE starmed_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO starmed_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO starmed_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO starmed_app;
-- Tabelas criadas FUTURO pelo próprio dono já nascem compartilhadas com o papel.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO starmed_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO starmed_app;
-- Auditoria é append-only para a aplicação: nem DELETE nem UPDATE (o trigger
-- forbid/append-only é camada extra; o revoke vale mesmo se o trigger faltar).
REVOKE UPDATE, DELETE ON audit_events FROM starmed_app;

-- 3) Cobertura total + dois níveis (descritos no cabeçalho deste arquivo).
DO $$
DECLARE
  t text;
  tier2 text[] := ARRAY[
    'users','portal_accounts','portal_invites','teleconsult_invites','signature_verify_codes'
  ];
BEGIN
  FOR t IN
    SELECT DISTINCT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
       AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY 1
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_org_isolation', t);
    IF t = ANY(tier2) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (current_org_id() IS NULL OR org_id = current_org_id()) WITH CHECK (current_org_id() IS NULL OR org_id = current_org_id())',
        t || '_org_isolation', t);
      EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    ELSE
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
        t || '_org_isolation', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
