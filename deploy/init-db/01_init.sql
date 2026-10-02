-- ==============================================================================
-- Bitfinex Lending Bot - PostgreSQL 初始化腳本 (Oracle VM 本機專用)
-- ==============================================================================

-- 啟用 UUID 擴充功能
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. 本地使用者表 (取代 Supabase auth.users)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    role VARCHAR(50) DEFAULT 'admin',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 預設插入本地管理員 (固定 UUID 確保單人或遷移時無縫對接)
INSERT INTO users (id, email, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'admin@lending-bot.local', 'admin')
ON CONFLICT (id) DO NOTHING;

-- 2. 全域機器人設定
CREATE TABLE IF NOT EXISTS bot_settings (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO bot_settings (key, value) VALUES
  ('strategy', '{"mode": "balanced", "frrDelta": 0.0001, "minRate": 0.0001, "maxRate": 0.01}'),
  ('risk', '{"reserveRatio": 0.1, "maxSingleAmount": 10000, "pauseOnVolatility": true}'),
  ('general', '{"currencies": ["USD", "USDT"], "minOfferAmount": 150, "enabled": true}')
ON CONFLICT (key) DO NOTHING;

-- 3. 用戶放貸設定表 (user_bot_settings)
CREATE TABLE IF NOT EXISTS user_bot_settings (
    user_id UUID PRIMARY KEY,
    bitfinex_api_key TEXT,
    bitfinex_api_secret TEXT,
    telegram_bot_token TEXT,
    telegram_chat_id TEXT,
    lending_currencies VARCHAR(10)[] DEFAULT ARRAY['USD', 'USDT'],
    min_offer_amount DECIMAL(20, 8) DEFAULT 150.0,
    status VARCHAR(20) DEFAULT 'stopped',
    strategy_config JSONB DEFAULT '{"mode": "simplified"}',
    compounding_enabled BOOLEAN DEFAULT true,
    auto_transfer_enabled BOOLEAN DEFAULT false,
    auto_transfer_threshold INT DEFAULT 500,
    pause_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_bot_settings_telegram_chat_id_unique
    ON user_bot_settings (btrim(telegram_chat_id))
    WHERE telegram_chat_id IS NOT NULL AND btrim(telegram_chat_id) <> '';

CREATE INDEX IF NOT EXISTS user_bot_settings_telegram_chat_id_lookup
    ON user_bot_settings (telegram_chat_id);

-- 4. 放貸掛單紀錄 (funding_offers)
CREATE TABLE IF NOT EXISTS funding_offers (
    id SERIAL PRIMARY KEY,
    offer_id BIGINT UNIQUE,
    currency VARCHAR(10) NOT NULL,
    amount DECIMAL(20, 8) NOT NULL,
    rate DECIMAL(20, 10) NOT NULL,
    period INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    user_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_funding_offers_status ON funding_offers (status);
CREATE INDEX IF NOT EXISTS idx_funding_offers_user ON funding_offers (user_id);

-- 5. 活躍貸款紀錄 (funding_loans)
CREATE TABLE IF NOT EXISTS funding_loans (
    id SERIAL PRIMARY KEY,
    loan_id BIGINT UNIQUE,
    currency VARCHAR(10) NOT NULL,
    amount DECIMAL(20, 8) NOT NULL,
    rate DECIMAL(20, 10) NOT NULL,
    period INTEGER NOT NULL,
    opened_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    interest_earned DECIMAL(20, 8) DEFAULT 0,
    user_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funding_loans_status ON funding_loans (status);
CREATE INDEX IF NOT EXISTS idx_funding_loans_user ON funding_loans (user_id);

-- 6. 收益紀錄 (earnings)
CREATE TABLE IF NOT EXISTS earnings (
    id SERIAL PRIMARY KEY,
    currency VARCHAR(10) NOT NULL,
    amount DECIMAL(20, 8) NOT NULL,
    rate DECIMAL(20, 10) NOT NULL,
    period INTEGER,
    earned_at TIMESTAMPTZ DEFAULT NOW(),
    user_id UUID
);

CREATE INDEX IF NOT EXISTS idx_earnings_currency_time ON earnings (currency, earned_at DESC);
CREATE INDEX IF NOT EXISTS idx_earnings_user ON earnings (user_id);

-- 7. 歷史利率 (rate_history)
CREATE TABLE IF NOT EXISTS rate_history (
    id SERIAL PRIMARY KEY,
    currency VARCHAR(10) NOT NULL,
    frr DECIMAL(20, 10),
    avg_rate DECIMAL(20, 10),
    high_rate DECIMAL(20, 10),
    low_rate DECIMAL(20, 10),
    volume DECIMAL(20, 8),
    bid_depth DECIMAL(20, 8),
    ask_depth DECIMAL(20, 8),
    demand_supply_ratio DOUBLE PRECISION,
    active_offers_count INTEGER,
    active_credits_count INTEGER,
    wallet_balance DOUBLE PRECISION,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_history_currency_time ON rate_history (currency, recorded_at DESC);

-- 8. 訂單簿快照 (order_book_snapshots)
CREATE TABLE IF NOT EXISTS order_book_snapshots (
    id BIGSERIAL PRIMARY KEY,
    currency TEXT NOT NULL,
    frr DOUBLE PRECISION,
    bids JSONB,
    asks JSONB,
    bid_total DOUBLE PRECISION,
    ask_total DOUBLE PRECISION,
    spread DOUBLE PRECISION,
    best_bid_rate DOUBLE PRECISION,
    best_ask_rate DOUBLE PRECISION,
    demand_supply_ratio DOUBLE PRECISION,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obs_cur_time ON order_book_snapshots(currency, recorded_at DESC);

-- 9. 操作日誌 (operation_logs)
CREATE TABLE IF NOT EXISTS operation_logs (
    id SERIAL PRIMARY KEY,
    level VARCHAR(10) NOT NULL DEFAULT 'info',
    category VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB,
    user_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_time ON operation_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_category ON operation_logs (category);
CREATE INDEX IF NOT EXISTS idx_logs_user ON operation_logs (user_id);

-- 10. FRR 歷史平均值聚合函數
CREATE OR REPLACE FUNCTION get_average_frr(p_currency VARCHAR, p_hours INT)
RETURNS NUMERIC AS $$
BEGIN
    RETURN (
        SELECT AVG(frr)
        FROM rate_history
        WHERE currency = p_currency
          AND recorded_at >= NOW() - (p_hours || ' hours')::INTERVAL
          AND frr IS NOT NULL
    );
END;
$$ LANGUAGE plpgsql;
