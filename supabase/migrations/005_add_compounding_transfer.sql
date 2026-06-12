-- Add compounding and auto-transfer settings to user_bot_settings
ALTER TABLE user_bot_settings ADD COLUMN IF NOT EXISTS compounding_enabled BOOLEAN DEFAULT true;
ALTER TABLE user_bot_settings ADD COLUMN IF NOT EXISTS auto_transfer_enabled BOOLEAN DEFAULT false;
ALTER TABLE user_bot_settings ADD COLUMN IF NOT EXISTS auto_transfer_threshold INT DEFAULT 500;
