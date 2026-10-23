-- StarMed 028: identificadores brasileiros do paciente (CPF e CNS) — FL-01.
--
-- Porte do repositório de referência (validação de CPF/CNS). Os campos são
-- OPCIONAIS: identificação segura não pode depender de documento que o paciente
-- nem sempre traz (urgência, estrangeiro, recém-nascido). Quando informados:
--   * só dígitos (a aplicação normaliza máscaras antes de gravar);
--   * dígito verificador conferido TAMBÉM no banco (CHECK com função IMMUTABLE),
--     para que scripts de importação/carga não contornem a regra da API;
--   * únicos por organização entre registros ATIVOS (merged_into_id IS NULL):
--     o perdedor de um merge MPI mantém o documento como rastro e não bloqueia.
--
-- DV correto só descarta erro de digitação — não prova titularidade.
-- Migração de execução única (schema_migrations + sha256).
BEGIN;

CREATE OR REPLACE FUNCTION starmed_cpf_valid(v TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE s INT; r INT; i INT;
BEGIN
  IF v !~ '^[0-9]{11}$' OR v ~ '^(\d)\1{10}$' THEN RETURN FALSE; END IF;
  s := 0; FOR i IN 1..9 LOOP s := s + substr(v, i, 1)::INT * (11 - i); END LOOP;
  r := s % 11; r := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  IF r <> substr(v, 10, 1)::INT THEN RETURN FALSE; END IF;
  s := 0; FOR i IN 1..10 LOOP s := s + substr(v, i, 1)::INT * (12 - i); END LOOP;
  r := s % 11; r := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  RETURN r = substr(v, 11, 1)::INT;
END $$;

CREATE OR REPLACE FUNCTION starmed_cns_valid(v TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE s INT := 0; i INT;
BEGIN
  IF v !~ '^[12789][0-9]{14}$' THEN RETURN FALSE; END IF;
  FOR i IN 1..15 LOOP s := s + substr(v, i, 1)::INT * (16 - i); END LOOP;
  RETURN s % 11 = 0;
END $$;

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS cpf TEXT,
  ADD COLUMN IF NOT EXISTS cns TEXT;

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_cpf_valid;
ALTER TABLE patients ADD CONSTRAINT patients_cpf_valid CHECK (cpf IS NULL OR starmed_cpf_valid(cpf));
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_cns_valid;
ALTER TABLE patients ADD CONSTRAINT patients_cns_valid CHECK (cns IS NULL OR starmed_cns_valid(cns));

CREATE UNIQUE INDEX IF NOT EXISTS patients_org_cpf_active_uq
  ON patients(org_id, cpf) WHERE cpf IS NOT NULL AND merged_into_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS patients_org_cns_active_uq
  ON patients(org_id, cns) WHERE cns IS NOT NULL AND merged_into_id IS NULL;

COMMIT;
