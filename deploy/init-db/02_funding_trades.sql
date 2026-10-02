-- 公開 Funding 撮合紀錄：由 OCI VM 本機 PostgreSQL 保存，避免依賴 Supabase。
CREATE TABLE IF NOT EXISTS funding_trades (
    id BIGSERIAL PRIMARY KEY,
    currency VARCHAR(10) NOT NULL,
    trade_id BIGINT NOT NULL,
    executed_at TIMESTAMPTZ NOT NULL,
    amount NUMERIC(20, 8) NOT NULL,
    rate NUMERIC(20, 12) NOT NULL,
    period INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (currency, trade_id)
);

CREATE INDEX IF NOT EXISTS idx_funding_trades_currency_time
    ON funding_trades (currency, executed_at DESC);
