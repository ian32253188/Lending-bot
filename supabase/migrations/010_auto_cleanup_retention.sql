-- 建立有界限的資料保留清理程序，並在支援 pg_cron 時排定每週清理。

CREATE INDEX IF NOT EXISTS idx_funding_offers_status_closed_at
    ON public.funding_offers (status, closed_at);

CREATE INDEX IF NOT EXISTS idx_funding_loans_status_closed_at
    ON public.funding_loans (status, closed_at);

CREATE INDEX IF NOT EXISTS idx_obs_recorded_at
    ON public.order_book_snapshots (recorded_at);

CREATE OR REPLACE FUNCTION public.cleanup_old_records(
    p_closed_order_days INTEGER DEFAULT 30,
    p_log_days INTEGER DEFAULT 30,
    p_rate_history_days INTEGER DEFAULT 30,
    p_snapshot_days INTEGER DEFAULT 7
)
RETURNS TABLE (
    deleted_logs BIGINT,
    deleted_offers BIGINT,
    deleted_loans BIGINT,
    deleted_rate_history BIGINT,
    deleted_snapshots BIGINT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_order_cutoff TIMESTAMPTZ;
    v_log_cutoff TIMESTAMPTZ;
    v_rate_cutoff TIMESTAMPTZ;
    v_snapshot_cutoff TIMESTAMPTZ;
    cnt_logs BIGINT := 0;
    cnt_offers BIGINT := 0;
    cnt_loans BIGINT := 0;
    cnt_rate BIGINT := 0;
    cnt_snapshots BIGINT := 0;
BEGIN
    IF p_closed_order_days IS NULL OR p_closed_order_days NOT BETWEEN 1 AND 3650
       OR p_log_days IS NULL OR p_log_days NOT BETWEEN 1 AND 3650
       OR p_rate_history_days IS NULL OR p_rate_history_days NOT BETWEEN 1 AND 3650
       OR p_snapshot_days IS NULL OR p_snapshot_days NOT BETWEEN 1 AND 3650 THEN
        RAISE EXCEPTION 'retention periods must be between 1 and 3650 days'
            USING ERRCODE = '22023';
    END IF;

    v_order_cutoff := pg_catalog.now() - pg_catalog.make_interval(days => p_closed_order_days);
    v_log_cutoff := pg_catalog.now() - pg_catalog.make_interval(days => p_log_days);
    v_rate_cutoff := pg_catalog.now() - pg_catalog.make_interval(days => p_rate_history_days);
    v_snapshot_cutoff := pg_catalog.now() - pg_catalog.make_interval(days => p_snapshot_days);

    WITH deleted AS (
        DELETE FROM public.operation_logs
        WHERE created_at < v_log_cutoff
        RETURNING id
    )
    SELECT COUNT(*) INTO cnt_logs FROM deleted;

    WITH deleted AS (
        DELETE FROM public.funding_offers
        WHERE status = 'closed'
          AND ((closed_at IS NOT NULL AND closed_at < v_order_cutoff)
            OR (closed_at IS NULL AND created_at < v_order_cutoff))
        RETURNING id
    )
    SELECT COUNT(*) INTO cnt_offers FROM deleted;

    WITH deleted AS (
        DELETE FROM public.funding_loans
        WHERE status = 'closed'
          AND ((closed_at IS NOT NULL AND closed_at < v_order_cutoff)
            OR (closed_at IS NULL AND opened_at < v_order_cutoff))
        RETURNING id
    )
    SELECT COUNT(*) INTO cnt_loans FROM deleted;

    WITH deleted AS (
        DELETE FROM public.rate_history
        WHERE recorded_at < v_rate_cutoff
        RETURNING id
    )
    SELECT COUNT(*) INTO cnt_rate FROM deleted;

    WITH deleted AS (
        DELETE FROM public.order_book_snapshots
        WHERE recorded_at < v_snapshot_cutoff
        RETURNING id
    )
    SELECT COUNT(*) INTO cnt_snapshots FROM deleted;

    RETURN QUERY SELECT cnt_logs, cnt_offers, cnt_loans, cnt_rate, cnt_snapshots;
END;
$$;

-- PostgreSQL grants EXECUTE to PUBLIC by default; only trusted backend and
-- database-scheduler roles should be able to call this destructive function.
REVOKE ALL ON FUNCTION public.cleanup_old_records(INTEGER, INTEGER, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_records(INTEGER, INTEGER, INTEGER, INTEGER)
    TO service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-retention-cleanup') THEN
            PERFORM cron.unschedule('weekly-retention-cleanup');
        END IF;

        PERFORM cron.schedule(
            'weekly-retention-cleanup',
            '0 3 * * 0',
            'SELECT public.cleanup_old_records(30, 30, 30, 7);'
        );
    END IF;
END;
$$;
