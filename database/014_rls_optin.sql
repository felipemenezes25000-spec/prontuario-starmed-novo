-- StarMed 014: RLS opt-in (defesa em profundidade multi-tenant).
--
-- ENABLE (sem FORCE): o papel DONO das tabelas (o usuário da API em desenvolvimento)
-- mantém o comportamento atual — nada quebra; as policies valem para QUALQUER outro
-- papel (BI, leitura, migração) que não seja owner. Ativar FORCE + criar papel de
-- aplicação separado é passo de implantação (ver CONTINUE-STARMED.md / runbook).
-- O isolamento primário já existe na aplicação: toda query filtra org_id.
-- O acesso é decidido pela GUC de sessão starmed.org_id (definida por conexão).
BEGIN;

CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('starmed.org_id', true), '')::uuid $$;

-- Tabelas tenant (todas têm org_id). Policies de leitura/escrita por organização.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','patients','appointments','encounters','clinical_notes','clinical_note_addenda',
    'prescriptions','patient_allergies','patient_conditions','audit_events','idempotency_keys',
    'inbound_messages','teleconsult_rooms','teleconsult_invites','ai_suggestions',
    'portal_accounts','portal_invites','crm_outbox','appointment_requests',
    'hospital_wards','hospital_beds','hospital_admissions','antimicrobial_344','diagnostic_orders',
    'document_signatures','signature_verify_codes','lgpd_requests','lgpd_consents',
    'clinical_templates','import_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_org_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t || '_org_isolation', t);
  END LOOP;
END $$;

COMMIT;
