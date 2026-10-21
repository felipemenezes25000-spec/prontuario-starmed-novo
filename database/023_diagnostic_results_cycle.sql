-- StarMed 023: ciclo de EXAMES e RESULTADOS (ST-P1-005 / J1 #12 extensão).
--
-- 1) Ciclo completo do pedido diagnóstico: ordered → accepted → collected →
--    preliminary → final → reviewed → communicated (+ 'cancelled' em qualquer
--    ponto anterior). Os status legados ('in_progress','completed') continuam
--    válidos: o smoke e os dados existentes os usam — NENHUM dado prévio é
--    reescrito aqui. A máquina de transições vale no CÓDIGO (orders.ts): este
--    CHECK só garante o vocabulário.
--
-- 2) Resultado estruturado + carimbos de instante por etapa (evidência de
--    QUANDO cada transição aconteceu, com revisor nomeado em 'reviewed').
--
-- 3) PDF do resultado referencia clinical_documents (bytes+sha256): o gatilho
--    da migração 022 versiona automaticamente (INSERT → v1 em document_versions)
--    — nenhum código de escrita novo é necessário para o versionamento.
--
-- 4) Integração LIS/PACS NASCE DESLIGADA: outbox (fila) + DLQ ('dead') +
--    circuit breaker por canal. Sem LIS_URL/PACS_URL configurados não há um
--    byte na rede (mesmo padrão "capacidade nasce desligada" da ACT/TSA).
--
-- RLS: tabelas novas com org_id recebem política tier1 + FORCE (padrão do 022;
-- os grants vêm do ALTER DEFAULT PRIVILEGES do 018).
BEGIN;

-- ------------------------------------------------------------- 1) ciclo ----
ALTER TABLE diagnostic_orders DROP CONSTRAINT IF EXISTS diagnostic_orders_status_check;
ALTER TABLE diagnostic_orders ADD CONSTRAINT diagnostic_orders_status_check
  CHECK (status IN (
    'ordered',      -- pedido criado
    'accepted',     -- laboratório/imagem aceitou
    'collected',    -- material coletado / exame realizado
    'preliminary',  -- resultado preliminar disponível
    'final',        -- resultado final
    'reviewed',     -- revisado por clínico (revisor registrado)
    'communicated', -- comunicado ao solicitante/paciente (auditado)
    -- legados (compat com smoke/UI existente):
    'in_progress', 'completed', 'cancelled'
  ));

-- ------------------------------------------------- 2) resultado + carimbos --
ALTER TABLE diagnostic_orders
  ADD COLUMN IF NOT EXISTS result_value TEXT,
  ADD COLUMN IF NOT EXISTS result_reference TEXT,   -- valores de referência (texto; sem base licenciada)
  ADD COLUMN IF NOT EXISTS result_units TEXT,
  ADD COLUMN IF NOT EXISTS preliminary_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS final_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS communicated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS communicated_to TEXT,    -- meio/destinatário da comunicação (metadado, sem PHI)
  ADD COLUMN IF NOT EXISTS result_document_id UUID REFERENCES clinical_documents(id);

ALTER TABLE diagnostic_orders DROP CONSTRAINT IF EXISTS diagnostic_orders_review_shape;
ALTER TABLE diagnostic_orders ADD CONSTRAINT diagnostic_orders_review_shape
  CHECK ((reviewed_at IS NULL AND reviewed_by IS NULL)
      OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL));

CREATE INDEX IF NOT EXISTS diagnostic_orders_cycle_idx
  ON diagnostic_orders(org_id, status, ordered_at DESC);

-- ------------------------------------------ 3/4) outbox LIS/PACS + breaker --
-- payload: JSON do pedido (sem dado clínico livre além do já existente no
-- pedido); status 'dead' É a DLQ (não há retry automático depois disso).
CREATE TABLE IF NOT EXISTS integration_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  channel TEXT NOT NULL CHECK (channel IN ('lis', 'pacs')),
  order_id UUID NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'dead')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  -- diagnostic_orders não tem UNIQUE(id, org_id) (só PK): FK de coluna única;
  -- o escopo de tenant vem da RLS + de toda query filtrar org_id.
  FOREIGN KEY (order_id) REFERENCES diagnostic_orders(id)
);
CREATE INDEX IF NOT EXISTS integration_outbox_due_idx
  ON integration_outbox(org_id, channel, next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- Circuit breaker por canal/org: 'open' = pausa envios; half-open permite 1
-- teste. Falhas consecutivas são contadas no código; o estado fica auditável.
CREATE TABLE IF NOT EXISTS integration_circuit (
  org_id UUID NOT NULL REFERENCES organizations(id),
  channel TEXT NOT NULL CHECK (channel IN ('lis', 'pacs')),
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  consecutive_failures INT NOT NULL DEFAULT 0,
  opened_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, channel)
);

-- ------------------------------------------------------------------ RLS -----
ALTER TABLE integration_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_outbox_org_isolation ON integration_outbox;
CREATE POLICY integration_outbox_org_isolation ON integration_outbox
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE integration_outbox FORCE ROW LEVEL SECURITY;

ALTER TABLE integration_circuit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_circuit_org_isolation ON integration_circuit;
CREATE POLICY integration_circuit_org_isolation ON integration_circuit
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
ALTER TABLE integration_circuit FORCE ROW LEVEL SECURITY;

COMMIT;
