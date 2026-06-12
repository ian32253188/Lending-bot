-- 訂單簿快照表（供 AI 訓練用）
CREATE TABLE IF NOT EXISTS order_book_snapshots (
    id BIGSERIAL PRIMARY KEY,
    currency TEXT NOT NULL,
    frr DOUBLE PRECISION,
    bids JSONB,                          -- 完整 bids 陣列
    asks JSONB,                          -- 完整 asks 陣列
    bid_total DOUBLE PRECISION,          -- bids 總量
    ask_total DOUBLE PRECISION,          -- asks 總量
    spread DOUBLE PRECISION,             -- best_ask - best_bid
    best_bid_rate DOUBLE PRECISION,
    best_ask_rate DOUBLE PRECISION,
    demand_supply_ratio DOUBLE PRECISION,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obs_cur_time ON order_book_snapshots(currency, recorded_at DESC);

-- 強化 rate_history 欄位（如果欄位不存在才加）
ALTER TABLE rate_history ADD COLUMN IF NOT EXISTS demand_supply_ratio DOUBLE PRECISION;
ALTER TABLE rate_history ADD COLUMN IF NOT EXISTS active_offers_count INTEGER;
ALTER TABLE rate_history ADD COLUMN IF NOT EXISTS active_credits_count INTEGER;
ALTER TABLE rate_history ADD COLUMN IF NOT EXISTS wallet_balance DOUBLE PRECISION;
