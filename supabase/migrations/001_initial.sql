-- Bitfinex Lending Bot - 資料表設計
-- Supabase (PostgreSQL)

-- 放貸紀錄
CREATE TABLE IF NOT EXISTS funding_offers (
  id SERIAL PRIMARY KEY,
  offer_id BIGINT UNIQUE,
  currency VARCHAR(10) NOT NULL,
  amount DECIMAL(20, 8) NOT NULL,
  rate DECIMAL(20, 10) NOT NULL,
  period INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  closed_at TIMESTAMP WITH TIME ZONE
);

-- 活躍貸款
CREATE TABLE IF NOT EXISTS funding_loans (
  id SERIAL PRIMARY KEY,
  loan_id BIGINT UNIQUE,
  currency VARCHAR(10) NOT NULL,
  amount DECIMAL(20, 8) NOT NULL,
  rate DECIMAL(20, 10) NOT NULL,
  period INTEGER NOT NULL,
  opened_at TIMESTAMP WITH TIME ZONE,
  closed_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  interest_earned DECIMAL(20, 8) DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 收益紀錄
CREATE TABLE IF NOT EXISTS earnings (
  id SERIAL PRIMARY KEY,
  currency VARCHAR(10) NOT NULL,
  amount DECIMAL(20, 8) NOT NULL,
  rate DECIMAL(20, 10) NOT NULL,
  period INTEGER,
  earned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 歷史利率（自行收集，用於回測和分析）
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
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 建立索引加速查詢
CREATE INDEX IF NOT EXISTS idx_rate_history_currency_time ON rate_history (currency, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_earnings_currency_time ON earnings (currency, earned_at DESC);
CREATE INDEX IF NOT EXISTS idx_funding_offers_status ON funding_offers (status);
CREATE INDEX IF NOT EXISTS idx_funding_loans_status ON funding_loans (status);

-- 操作日誌
CREATE TABLE IF NOT EXISTS operation_logs (
  id SERIAL PRIMARY KEY,
  level VARCHAR(10) NOT NULL DEFAULT 'info',
  category VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_time ON operation_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_category ON operation_logs (category);

-- 機器人設定
CREATE TABLE IF NOT EXISTS bot_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 插入預設設定
INSERT INTO bot_settings (key, value) VALUES
  ('strategy', '{"mode": "balanced", "frrDelta": 0.0001, "minRate": 0.0001, "maxRate": 0.01}'),
  ('risk', '{"reserveRatio": 0.1, "maxSingleAmount": 10000, "pauseOnVolatility": true}'),
  ('general', '{"currencies": ["USD"], "minOfferAmount": 150, "enabled": true}')
ON CONFLICT (key) DO NOTHING;
