-- StarMed 029: registro profissional do prescritor + tipo de receita (lote 2 do
-- porte do repositório de referência: CrmValidator, PrescriptionKind,
-- PrescriptionComplianceValidator).
--
-- A) practitioner_registrations: CRM/UF (RQE e contato profissional opcionais)
--    por usuário. Até aqui o PDF imprimia "Registro profissional (CRM/UF):
--    pendência - não cadastrado no sistema". CRM não tem DV nacional: o formato
--    (3–7 dígitos, UF entre as 27) é conferido na API e reforçado aqui.
--    Conferência no portal do CFM continua EXTERNA (não há API pública).
--
-- B) prescriptions.kind: 'simple' | 'antimicrobial' | 'controlled_special'.
--    - antimicrobial: RDC 471/2021 (validade de 10 dias, sexo/idade do paciente,
--      endereço do prescritor); entra atrás de FEATURE_ANTIMICROBIAL_RX.
--    - controlled_special: recusado na API até existir integração SNCR
--      homologada (BLOCKED_EXTERNAL); o valor existe só para o contrato.
--    valid_until: preenchido na assinatura quando o tipo tem validade regulatória.
--    prescriber_registration: snapshot do CRM/UF NO ATO da assinatura (o cadastro
--    pode mudar depois; o documento emitido não).
--
-- Migração de execução única (schema_migrations + sha256). RLS tier1 (padrão 018).
BEGIN;

CREATE TABLE practitioner_registrations (
  user_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  council TEXT NOT NULL DEFAULT 'CRM' CHECK (council IN ('CRM')),
  council_number TEXT NOT NULL CHECK (council_number ~ '^[0-9]{3,7}$' AND council_number !~ '^(\d)\1*$'),
  council_state TEXT NOT NULL CHECK (council_state IN ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT',
    'MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')),
  rqe TEXT CHECK (rqe IS NULL OR rqe ~ '^[0-9]{1,8}$'),
  specialty TEXT CHECK (specialty IS NULL OR length(specialty) BETWEEN 2 AND 120),
  professional_address TEXT CHECK (professional_address IS NULL OR length(professional_address) BETWEEN 5 AND 300),
  professional_phone TEXT CHECK (professional_phone IS NULL OR professional_phone ~ '^[0-9]{10,13}$'),
  updated_by UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id),
  FOREIGN KEY (updated_by, org_id) REFERENCES users(id, org_id),
  UNIQUE (org_id, council, council_state, council_number)
);

ALTER TABLE practitioner_registrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS practitioner_registrations_tenant ON practitioner_registrations;
CREATE POLICY practitioner_registrations_tenant ON practitioner_registrations
  USING (org_id = current_setting('starmed.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('starmed.org_id', true)::uuid);
ALTER TABLE practitioner_registrations FORCE ROW LEVEL SECURITY;

ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'simple'
  CHECK (kind IN ('simple','antimicrobial','controlled_special'));
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS valid_until DATE;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS prescriber_registration JSONB;

-- Imutabilidade pós-assinatura passa a cobrir também o tipo, a validade e o
-- snapshot do registro profissional (mesma função da 016, lista ampliada).
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
       NEW.special_class     IS DISTINCT FROM OLD.special_class OR
       NEW.kind              IS DISTINCT FROM OLD.kind OR
       NEW.valid_until       IS DISTINCT FROM OLD.valid_until OR
       NEW.prescriber_registration IS DISTINCT FROM OLD.prescriber_registration) THEN
    RAISE EXCEPTION 'Prescrições assinadas são imutáveis';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
