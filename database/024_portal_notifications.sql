-- StarMed 024: Portal do paciente (ST-P1-008) — preferências de notificação,
-- opt-out de comunicação e comprovação de entrega.
--
-- 1) Preferências por CANAL (padrão: mensagens de serviço ativas, marketing
--    OPT-IN explícito = false — LGPD: opt-out simples para o que já estava ativo,
--    opt-in positivo para o que é comunicação promocional). Validação/merge no
--    servidor (zod em portal.ts); o JSONB guarda o estado por conta.
--
-- 2) Comprovação de entrega: `crm_outbox` já É a fila com status real
--    (queued→sent|failed pelo worker scripts/crm/dispatch-outbox.mjs); falta o
--    vínculo com o PACIENTE para o portal ler o próprio histórico (o recipient
--    por telefone/e-mail não é identidade suficiente).
--
-- RLS: ALTER em tabelas existentes (políticas do 018 permanecem); grants novos
-- vêm do ALTER DEFAULT PRIVILEGES do 018. Migração de execução única.
BEGIN;

ALTER TABLE portal_accounts
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT
    '{"whatsapp": true, "email": true, "sms": true, "marketing_opt_in": false}'::jsonb;

ALTER TABLE crm_outbox ADD COLUMN IF NOT EXISTS patient_id UUID;

DROP INDEX IF EXISTS crm_outbox_patient_idx;
CREATE INDEX crm_outbox_patient_idx
  ON crm_outbox(org_id, patient_id, created_at DESC)
  WHERE patient_id IS NOT NULL;

ALTER TABLE crm_outbox DROP CONSTRAINT IF EXISTS crm_outbox_patient_fk;
ALTER TABLE crm_outbox
  ADD CONSTRAINT crm_outbox_patient_fk FOREIGN KEY (patient_id) REFERENCES patients(id);

COMMIT;
