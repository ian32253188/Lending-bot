-- Migration 009: 由 PostgreSQL 計算歷史 FRR 平均值，避免把大量資料拉回 Node.js。

CREATE OR REPLACE FUNCTION public.get_average_frr(p_currency VARCHAR, p_hours INT)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF p_currency IS NULL OR p_hours IS NULL OR p_hours NOT BETWEEN 1 AND 8760 THEN
        RAISE EXCEPTION 'p_currency and p_hours must be valid (1-8760 hours)'
            USING ERRCODE = '22023';
    END IF;

    RETURN (
        SELECT AVG(frr)
        FROM public.rate_history
        WHERE currency = p_currency
          AND recorded_at >= pg_catalog.now() - pg_catalog.make_interval(hours => p_hours)
          AND frr IS NOT NULL
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_average_frr(VARCHAR, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_average_frr(VARCHAR, INT) TO service_role;
