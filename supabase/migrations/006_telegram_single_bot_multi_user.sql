-- One shared Telegram Bot can safely route commands by a unique Chat ID.
-- Empty values are excluded so users can explicitly disable Telegram.
CREATE UNIQUE INDEX IF NOT EXISTS user_bot_settings_telegram_chat_id_unique
    ON user_bot_settings (btrim(telegram_chat_id))
    WHERE telegram_chat_id IS NOT NULL AND btrim(telegram_chat_id) <> '';

CREATE INDEX IF NOT EXISTS user_bot_settings_telegram_chat_id_lookup
    ON user_bot_settings (telegram_chat_id);
