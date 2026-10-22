-- Persist pause causes separately so maintenance recovery does not clear an
-- operator pause, and a restart can still release a maintenance-only pause.
ALTER TABLE user_bot_settings
    ADD COLUMN IF NOT EXISTS manual_pause_reason TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS maintenance_paused BOOLEAN NOT NULL DEFAULT false;
