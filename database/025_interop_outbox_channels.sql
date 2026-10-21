-- StarMed 025: interoperabilidade (ST-P1-009/010) — adapters de SAÍDA com
-- retry exponencial/DLQ herdando o outbox já criado no 03 (023) do hospitalar.
--
-- O integration_outbox nasceu com canais 'lis'|'pacs'; a Fase 6 abre o MESMO
-- contrato (pending→sent|failed→dead + backoff 2^n + circuit breaker por
-- canal/org) para os demais protocolos — um único mecanismo auditado em vez de
-- filas paralelas. Todos os canais NASCEM DESLIGADOS: sem o env correspondente
-- (HL7_MLLP_HOST / RNDS_SUBMIT_URL / …) não há um byte na rede.
--
-- Migração de execução única (schema_migrations + sha256).
BEGIN;

ALTER TABLE integration_outbox
  DROP CONSTRAINT IF EXISTS integration_outbox_channel_check;
ALTER TABLE integration_outbox
  ADD CONSTRAINT integration_outbox_channel_check
  CHECK (channel IN ('lis', 'pacs', 'hl7', 'tiss', 'nfse', 'rnds', 'dicom'));

COMMIT;
