-- Persist the reason for an internally paused lending engine so deployments
-- can restore running and paused users without losing the previous state.
ALTER TABLE user_bot_settings
    ADD COLUMN IF NOT EXISTS pause_reason TEXT;
