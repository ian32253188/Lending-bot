-- ==============================================================================
-- Bitfinex Lending Bot - 多用戶 SaaS 平台資料庫移轉腳本 (004_multi_tenant_saas.sql)
-- ==============================================================================

-- 1. 確保 UUID 與加密擴充功能已啟用
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgsodium;

-- 2. 建立多用戶放貸設定表 (user_bot_settings)
CREATE TABLE IF NOT EXISTS user_bot_settings (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    bitfinex_api_key TEXT,
    bitfinex_api_secret TEXT,
    telegram_bot_token TEXT,
    telegram_chat_id TEXT,
    lending_currencies VARCHAR(10)[] DEFAULT ARRAY['USD'],
    min_offer_amount DECIMAL(20, 8) DEFAULT 150.0,
    status VARCHAR(20) DEFAULT 'stopped', -- 'running', 'stopped'
    strategy_config JSONB DEFAULT '{"mode": "simplified"}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. 為用戶數據表擴充 user_id 欄位（關聯到 auth.users）
ALTER TABLE funding_offers ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE funding_loans ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE earnings ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE operation_logs ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 4. 啟用 Row Level Security (RLS) 確保用戶數據物理隔離
ALTER TABLE user_bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE funding_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE funding_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_logs ENABLE ROW LEVEL SECURITY;

-- 5. 建立安全策略 (Policies) - 僅允許登入用戶存取自己 user_id 的資料

-- 設定表策略
CREATE POLICY "Allow users to manage their own settings" 
    ON user_bot_settings 
    FOR ALL 
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 掛單表策略
CREATE POLICY "Allow users to manage their own offers" 
    ON funding_offers 
    FOR ALL 
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 貸款表策略
CREATE POLICY "Allow users to manage their own loans" 
    ON funding_loans 
    FOR ALL 
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 收益表策略
CREATE POLICY "Allow users to manage their own earnings" 
    ON earnings 
    FOR ALL 
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 日誌表策略
CREATE POLICY "Allow users to manage their own logs" 
    ON operation_logs 
    FOR ALL 
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 6. 設定自動更新 updated_at 欄位的 trigger
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_user_bot_settings_modtime
    BEFORE UPDATE ON user_bot_settings
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();
