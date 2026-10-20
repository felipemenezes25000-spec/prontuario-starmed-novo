-- StarMed 017: resultado crítico de exame — confirmação de recebimento auditada.
-- Perigo H-12 (docs/clinical/HAZARD-LOG-FMEA.md, cenário J1 #12): um valor crítico
-- não pode ser "comunicado" apenas por notificação; exige reconhecimento explícito
-- registrado em auditoria com quem recebeu e quando.
-- Transacional e idempotente; nunca reaplicar em base populada sem o runner.
BEGIN;

ALTER TABLE diagnostic_orders
  ADD COLUMN IF NOT EXISTS critical BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS critical_ack_by UUID,
  ADD COLUMN IF NOT EXISTS critical_ack_at TIMESTAMPTZ;

-- Lista de pendências (crítico sem reconhecimento) é a tela de maior risco:
-- índice parcial cobre exatamente esse filtro.
CREATE INDEX IF NOT EXISTS diagnostic_orders_critical_pending_idx
  ON diagnostic_orders(org_id, critical)
  WHERE critical AND critical_ack_at IS NULL;

-- Invariante: só existe reconhecimento em pedido crítico.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'diagnostic_orders_critical_ack_shape'
      AND conrelid = 'diagnostic_orders'::regclass
  ) THEN
    ALTER TABLE diagnostic_orders
      ADD CONSTRAINT diagnostic_orders_critical_ack_shape
      CHECK (critical_ack_at IS NULL OR critical);
  END IF;
END $$;

COMMIT;
