-- StarMed 020: vínculo de cuidado para prontuário completo (P0-05 / J1 #13).
--
-- A regra de autorização clínica (threat model §2.2.1): profissional lê o
-- prontuário COMPLETO de um paciente da própria organização somente com
-- CONTEXTO DE CUIDADO — encontro, agendamento ou ter sido quem cadastrou o
-- paciente — OU via BREAK-GLASS com justificativa obrigatória (header
-- X-Break-Glass-Reason, mínimo 20 caracteres), auditado em audit_events.
-- Sem contexto e sem justificativa: 403. Busca/listagem continua com dados
-- mínimos + auditoria (não é bloqueada).
--
-- created_by nasce nullable (histórico não tem vínculo gravado); o índice
-- sustenta o EXISTS do predicado de contexto.
BEGIN;

ALTER TABLE patients ADD COLUMN IF NOT EXISTS created_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patients_created_by_fk'
      AND conrelid = 'patients'::regclass
  ) THEN
    ALTER TABLE patients
      ADD CONSTRAINT patients_created_by_fk FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS patients_created_by_idx ON patients(org_id, created_by);

COMMIT;
