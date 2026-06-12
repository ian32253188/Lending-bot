-- IBRR (Instant Best Return Rate) 即時最佳利率歷史記錄表
-- 用於 ML 模型訓練和策略回測分析

CREATE TABLE IF NOT EXISTS ibrr_history (
    id BIGSERIAL PRIMARY KEY,
    currency TEXT NOT NULL,
    ibrr DOUBLE PRECISION NOT NULL,            -- IBRR 即時最佳利率
    equilibrium_rate DOUBLE PRECISION,          -- 供需均衡利率
    frr DOUBLE PRECISION,                       -- 當時的 FRR
    frr_trend TEXT,                             -- FRR 趨勢 (rising/falling/stable)
    risk_level INTEGER,                         -- 風險指數 (1-10)
    demand_supply_ratio DOUBLE PRECISION,       -- 供需比
    total_demand DOUBLE PRECISION,              -- 總需求量
    total_supply DOUBLE PRECISION,              -- 總供給量
    ml_direction TEXT,                          -- ML 預測方向 (rising/falling/stable)
    ml_confidence DOUBLE PRECISION,             -- ML 信心度 (0-1)
    wall_detected BOOLEAN DEFAULT FALSE,        -- 是否偵測到 FRR 牆
    wall_rate DOUBLE PRECISION,                 -- FRR 牆的利率
    best_bid_rate DOUBLE PRECISION,             -- 最佳 bid 利率
    best_ask_rate DOUBLE PRECISION,             -- 最佳 ask 利率
    last_price DOUBLE PRECISION,                -- 最近成交利率
    method TEXT DEFAULT 'ibrr_v1',              -- 計算方法版本
    recorded_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引：按幣種和時間查詢（ML 訓練常用）
CREATE INDEX IF NOT EXISTS idx_ibrr_history_currency_time 
    ON ibrr_history (currency, recorded_at DESC);

-- 索引：按 ML 方向查詢（分析預測準確度）
CREATE INDEX IF NOT EXISTS idx_ibrr_history_ml_direction 
    ON ibrr_history (currency, ml_direction, recorded_at DESC);

-- 索引：按風險等級查詢
CREATE INDEX IF NOT EXISTS idx_ibrr_history_risk_level 
    ON ibrr_history (currency, risk_level, recorded_at DESC);

-- 啟用 RLS (Row Level Security)
ALTER TABLE ibrr_history ENABLE ROW LEVEL SECURITY;

-- RLS 策略：允許 service role 完整存取
CREATE POLICY "Service role full access on ibrr_history"
    ON ibrr_history
    USING (true)
    WITH CHECK (true);
