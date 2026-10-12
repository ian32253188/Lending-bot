ALTER TABLE earnings
    ADD COLUMN IF NOT EXISTS ledger_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_user_ledger
    ON earnings (user_id, ledger_id);
