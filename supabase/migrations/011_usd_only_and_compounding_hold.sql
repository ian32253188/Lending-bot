ALTER TABLE user_bot_settings
    ALTER COLUMN lending_currencies SET DEFAULT ARRAY['USD']::VARCHAR(10)[],
    ADD COLUMN IF NOT EXISTS compounding_hold_amount DECIMAL(20, 8) NOT NULL DEFAULT 0;

UPDATE user_bot_settings
SET lending_currencies = ARRAY['USD']::VARCHAR(10)[]
WHERE lending_currencies IS DISTINCT FROM ARRAY['USD']::VARCHAR(10)[];

UPDATE bot_settings
SET value = jsonb_set(value, '{currencies}', '["USD"]'::jsonb, true),
    updated_at = NOW()
WHERE key = 'general';
