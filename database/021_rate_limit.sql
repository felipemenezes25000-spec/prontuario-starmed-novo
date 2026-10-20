-- StarMed 021: rate limit distribuído (P0-07) — contador em Postgres.
--
-- O limitador em memória (express-rate-limit) não vale em múltiplas instâncias:
-- cada réplica contava sozinha. Este armazenamento é compartilhado por todas as
-- conexões do banco, sem dependência nova (usa o pg já presente) e sem segredo.
-- Janela fixa por bucket (bucket + window_start); a limpeza de janelas antigas
-- é barata e pode ser agendada (DELETE WHERE window_start < now() - interval).
-- Tabela SEM org_id (o contador é por IP/rota, pré-autenticação) — por isso não
-- entra no scan de RLS do 018; o papel da aplicação nasce com privilégios via
-- ALTER DEFAULT PRIVILEGES do 018.
BEGIN;

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits INT NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits(window_start);

-- Limpeza conservadora: janelas com mais de 1 dia nunca mais são consultadas.
DELETE FROM rate_limits WHERE window_start < now() - interval '1 day';

COMMIT;
