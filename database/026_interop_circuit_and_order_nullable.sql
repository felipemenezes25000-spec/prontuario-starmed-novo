-- StarMed 026: correções de contrato da Fase 6 (interop) apontadas na revisão
-- do orquestrador sobre o próprio código entregue:
--
-- 1) O 025 abriu os CANAIS do outbox, mas o CHECK do CIRCUIT BREAKER
--    (integration_circuit, criado inline no 023) continuava só em
--    ('lis','pacs') — breaker nunca funcionaria para hl7/tiss/nfse/rnds/dicom.
--
-- 2) `integration_outbox.order_id` nasceu NOT NULL + FK→diagnostic_orders
--    (padrão do canal lis/pacs). Mensagens interop SEM pedido diagnóstico
--    (envio HL7, submissão RNDS, lote TISS, NFSe) não têm order — a coluna
--    vira NULA; a FK permanece para quando HOUVER pedido (lis/pacs seguem
--    obrigatórios por contrato de código: enqueueInterop valida).
--
-- Migração de execução única (schema_migrations + sha256).
BEGIN;

ALTER TABLE integration_circuit
  DROP CONSTRAINT IF EXISTS integration_circuit_channel_check;
ALTER TABLE integration_circuit
  ADD CONSTRAINT integration_circuit_channel_check
  CHECK (channel IN ('lis', 'pacs', 'hl7', 'tiss', 'nfse', 'rnds', 'dicom'));

ALTER TABLE integration_outbox ALTER COLUMN order_id DROP NOT NULL;

COMMIT;
