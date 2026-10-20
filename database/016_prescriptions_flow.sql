-- Migration 016: fluxo de prescrição eletrônica — campos estruturados, rastro de
-- assinatura/cancelamento e imutabilidade da prescrição assinada.
-- Transacional e idempotente: ADD COLUMN IF NOT EXISTS; constraints nomeadas
-- verificadas em DO antes do ADD CONSTRAINT. Sem comandos de cliente (psql).
BEGIN;

-- Campos estruturados do rascunho (dose vira {value,unit}; o TEXT legado 'dose'
-- continua sendo espelhado pela aplicação para compatibilidade de leitura).
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS medication_form TEXT;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS medication_concentration TEXT;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS dose_value NUMERIC;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS dose_unit TEXT;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS quantity INT CHECK (quantity > 0);
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS times JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(times)='array');
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS indication TEXT;
-- Classe especial: NULL por padrão; a aplicação recusa valor enviado enquanto
-- não existir configuração ativa (409), nunca emite documento com classe inválida.
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS special_class TEXT;
-- Justificativa de override dos alertas de revisão obrigatória (gravada também na auditoria).
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS override_justification TEXT;

-- Rastro de assinatura e cancelamento (nunca apagamos; signed → cancelled é permitido).
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS signed_by UUID;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS cancelled_by UUID;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
-- 'attested' = PDF emitido e hasheado; 'pades' = assinatura digital aplicada.
-- Enquanto a integração PAdES não existir para prescrições, só 'none'/'attested'
-- ocorrem — nunca "assinatura válida" sem evidência.
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS signature_status TEXT NOT NULL DEFAULT 'none'
  CHECK (signature_status IN ('none','attested','pades'));
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='prescriptions_signed_by_fkey') THEN
    ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_signed_by_fkey
      FOREIGN KEY (signed_by, org_id) REFERENCES users(id, org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='prescriptions_cancelled_by_fkey') THEN
    ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_cancelled_by_fkey
      FOREIGN KEY (cancelled_by, org_id) REFERENCES users(id, org_id);
  END IF;
END $$;

-- Imutabilidade no banco: prescrição assinada não muda conteúdo e nunca é apagada;
-- a única transição permitida é signed → cancelled (campos clínicos inalterados).
CREATE OR REPLACE FUNCTION forbid_signed_prescription_changes() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'signed' THEN
      RAISE EXCEPTION 'Prescrições assinadas nunca são apagadas';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'signed' AND (
       NEW.medication_code   IS DISTINCT FROM OLD.medication_code OR
       NEW.medication_name   IS DISTINCT FROM OLD.medication_name OR
       NEW.dose              IS DISTINCT FROM OLD.dose OR
       NEW.dose_value        IS DISTINCT FROM OLD.dose_value OR
       NEW.dose_unit         IS DISTINCT FROM OLD.dose_unit OR
       NEW.medication_form   IS DISTINCT FROM OLD.medication_form OR
       NEW.medication_concentration IS DISTINCT FROM OLD.medication_concentration OR
       NEW.route             IS DISTINCT FROM OLD.route OR
       NEW.frequency         IS DISTINCT FROM OLD.frequency OR
       NEW.duration          IS DISTINCT FROM OLD.duration OR
       NEW.times             IS DISTINCT FROM OLD.times OR
       NEW.quantity          IS DISTINCT FROM OLD.quantity OR
       NEW.indication        IS DISTINCT FROM OLD.indication OR
       NEW.instructions      IS DISTINCT FROM OLD.instructions OR
       NEW.special_class     IS DISTINCT FROM OLD.special_class) THEN
    RAISE EXCEPTION 'Prescrições assinadas são imutáveis';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS prescriptions_immutable ON prescriptions;
CREATE TRIGGER prescriptions_immutable BEFORE UPDATE OR DELETE ON prescriptions
FOR EACH ROW EXECUTE FUNCTION forbid_signed_prescription_changes();

CREATE INDEX IF NOT EXISTS prescriptions_encounter_idx ON prescriptions(org_id, encounter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prescriptions_status_idx ON prescriptions(org_id, status);

COMMIT;
