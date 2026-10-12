const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

let pool = null;
let supabase = null;
const averageFRRCache = new Map();
const AVERAGE_FRR_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// 1 小時記憶體快取：大幅消除頻繁查詢 rate_history 所造成的 Disk IO 消耗
const rateHistoryCache = new Map();
const RATE_HISTORY_CACHE_TTL_MS = 60 * 60 * 1000;
const taipeiDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

function taipeiDateKey(value) {
    const parts = Object.fromEntries(taipeiDateFormatter.formatToParts(value).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}
let fundingTradesSchemaPromise = null;
let fundingTradesSchemaErrorCode = null;
let userSettingsSchemaPromise = null;
let userSettingsSchemaErrorCode = null;
let applicationDataSchemaPromise = null;
let researchSchemaPromise = null;

/**
 * 判斷是否配置了原生 PostgreSQL
 */
function isPostgresConfigured() {
    if (process.env.NODE_ENV === 'test' && !process.env.RUN_DB_INTEGRATION_TESTS) {
        return false;
    }
    if (config.database?.url) return true;
    if (config.database?.host && config.database?.password) return true;
    return false;
}

/**
 * 取得 PostgreSQL 連線池 (Singleton)
 */
function getPool() {
    if (!pool && isPostgresConfigured()) {
        const poolConfig = config.database.url
            ? { connectionString: config.database.url }
            : {
                host: config.database.host,
                port: config.database.port,
                user: config.database.user,
                password: config.database.password,
                database: config.database.database,
            };

        pool = new Pool({
            ...poolConfig,
            max: 20, // 最大連線數
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        pool.on('error', (err) => {
            console.error('❌ PostgreSQL Pool 連線發生非預期錯誤:', err.message);
        });
    }
    return pool;
}

/**
 * 取得 Supabase Client (相容舊有配置或單元測試 Mock)
 */
function getSupabase() {
    if (!supabase) {
        if (!config.supabase.url || !config.supabase.key) {
            return null;
        }
        supabase = createClient(config.supabase.url, config.supabase.key);
    }
    return supabase;
}

/**
 * 通用資料庫查詢輔助函式
 */
async function query(text, params) {
    const p = getPool();
    if (!p) return null;
    return p.query(text, params);
}

/**
 * 確保 OCI 本機 PostgreSQL 具備公開撮合資料表。
 * 這個初始化是冪等的，讓既有 volume 升級時不需要清除資料重建。
 */
async function ensureFundingTradesTable() {
    if (!isPostgresConfigured()) return false;
    if (fundingTradesSchemaPromise) return fundingTradesSchemaPromise;

    fundingTradesSchemaPromise = query(`
        CREATE TABLE IF NOT EXISTS funding_trades (
            id BIGSERIAL PRIMARY KEY,
            currency VARCHAR(10) NOT NULL,
            trade_id BIGINT NOT NULL,
            executed_at TIMESTAMPTZ NOT NULL,
            amount NUMERIC(20, 8) NOT NULL,
            rate NUMERIC(20, 12) NOT NULL,
            period INTEGER NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (currency, trade_id)
        );
        CREATE INDEX IF NOT EXISTS idx_funding_trades_currency_time
            ON funding_trades (currency, executed_at DESC);
    `).then(() => {
        fundingTradesSchemaErrorCode = null;
        return true;
    }).catch(error => {
        fundingTradesSchemaPromise = null;
        fundingTradesSchemaErrorCode = error.code || 'UNKNOWN';
        console.error('ensureFundingTradesTable error:', error);
        return false;
    });

    return fundingTradesSchemaPromise;
}

/**
 * Ensure the per-user settings table exists on persistent PostgreSQL volumes.
 * Docker init scripts only run when a data volume is first created, so older
 * production volumes need an idempotent in-app schema upgrade.
 */
async function ensureUserBotSettingsTable() {
    if (!isPostgresConfigured()) return false;
    if (userSettingsSchemaPromise) return userSettingsSchemaPromise;

    userSettingsSchemaPromise = query(`
        CREATE TABLE IF NOT EXISTS bot_settings (
            id SERIAL PRIMARY KEY,
            key VARCHAR(100) UNIQUE NOT NULL,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE bot_settings
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
        INSERT INTO bot_settings (key, value) VALUES
            ('strategy', '{"mode": "balanced", "frrDelta": 0.0001}'),
            ('risk', '{"reserveRatio": 0.1, "maxSingleAmount": 10000, "pauseOnVolatility": true}'),
            ('general', '{"currencies": ["USD"], "minOfferAmount": 150, "enabled": true}')
        ON CONFLICT (key) DO NOTHING;
        CREATE TABLE IF NOT EXISTS user_bot_settings (
            user_id UUID PRIMARY KEY,
            bitfinex_api_key TEXT,
            bitfinex_api_secret TEXT,
            telegram_bot_token TEXT,
            telegram_chat_id TEXT,
            lending_currencies VARCHAR(10)[] DEFAULT ARRAY['USD'],
            compounding_hold_amount DECIMAL(20, 8) NOT NULL DEFAULT 0,
            min_offer_amount DECIMAL(20, 8) DEFAULT 150.0,
            status VARCHAR(20) DEFAULT 'stopped',
            strategy_config JSONB DEFAULT '{"mode": "simplified"}',
            compounding_enabled BOOLEAN DEFAULT true,
            auto_transfer_enabled BOOLEAN DEFAULT false,
            auto_transfer_threshold INT DEFAULT 500,
            pause_reason TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE user_bot_settings
            ALTER COLUMN lending_currencies SET DEFAULT ARRAY['USD']::VARCHAR(10)[],
            ADD COLUMN IF NOT EXISTS compounding_hold_amount DECIMAL(20, 8) NOT NULL DEFAULT 0;
        UPDATE user_bot_settings SET lending_currencies = ARRAY['USD']::VARCHAR(10)[] WHERE lending_currencies IS DISTINCT FROM ARRAY['USD']::VARCHAR(10)[];
        UPDATE bot_settings
        SET value = jsonb_set(value, '{currencies}', '["USD"]'::jsonb, true), updated_at = NOW()
        WHERE key = 'general';
        CREATE UNIQUE INDEX IF NOT EXISTS user_bot_settings_telegram_chat_id_unique
            ON user_bot_settings (btrim(telegram_chat_id))
            WHERE telegram_chat_id IS NOT NULL AND btrim(telegram_chat_id) <> '';
        CREATE INDEX IF NOT EXISTS user_bot_settings_telegram_chat_id_lookup
            ON user_bot_settings (telegram_chat_id);
    `).then(() => {
        userSettingsSchemaErrorCode = null;
        return true;
    }).catch(error => {
        userSettingsSchemaPromise = null;
        userSettingsSchemaErrorCode = error.code || 'UNKNOWN';
        console.error('ensureUserBotSettingsTable error:', error);
        return false;
    });

    return userSettingsSchemaPromise;
}

/**
 * Ensure tables used by dashboard history/logging exist on persistent PostgreSQL
 * volumes. Docker init scripts only run for a brand-new data volume, so this
 * idempotent upgrade also repairs existing production databases without deleting
 * any rows.
 */
async function ensureApplicationDataTables() {
    if (!isPostgresConfigured()) return false;
    if (applicationDataSchemaPromise) return applicationDataSchemaPromise;

    applicationDataSchemaPromise = query(`
        CREATE TABLE IF NOT EXISTS funding_offers (
            id SERIAL PRIMARY KEY,
            offer_id BIGINT UNIQUE,
            currency VARCHAR(10) NOT NULL,
            amount DECIMAL(20, 8) NOT NULL,
            rate DECIMAL(20, 10) NOT NULL,
            period INTEGER NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            user_id UUID,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            closed_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_funding_offers_status ON funding_offers (status);
        CREATE INDEX IF NOT EXISTS idx_funding_offers_user ON funding_offers (user_id);

        CREATE TABLE IF NOT EXISTS funding_loans (
            id SERIAL PRIMARY KEY,
            loan_id BIGINT UNIQUE,
            currency VARCHAR(10) NOT NULL,
            amount DECIMAL(20, 8) NOT NULL,
            rate DECIMAL(20, 10) NOT NULL,
            period INTEGER NOT NULL,
            opened_at TIMESTAMPTZ,
            closed_at TIMESTAMPTZ,
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            interest_earned DECIMAL(20, 8) DEFAULT 0,
            user_id UUID,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_funding_loans_status ON funding_loans (status);
        CREATE INDEX IF NOT EXISTS idx_funding_loans_user ON funding_loans (user_id);

        CREATE TABLE IF NOT EXISTS earnings (
            id SERIAL PRIMARY KEY,
            currency VARCHAR(10) NOT NULL,
            amount DECIMAL(20, 8) NOT NULL,
            rate DECIMAL(20, 10) NOT NULL,
            period INTEGER,
            earned_at TIMESTAMPTZ DEFAULT NOW(),
            ledger_id BIGINT,
            user_id UUID
        );
        ALTER TABLE earnings ADD COLUMN IF NOT EXISTS ledger_id BIGINT;
        CREATE INDEX IF NOT EXISTS idx_earnings_currency_time ON earnings (currency, earned_at DESC);
        CREATE INDEX IF NOT EXISTS idx_earnings_user ON earnings (user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_user_ledger ON earnings (user_id, ledger_id);

        CREATE TABLE IF NOT EXISTS operation_logs (
            id SERIAL PRIMARY KEY,
            level VARCHAR(10) NOT NULL DEFAULT 'info',
            category VARCHAR(50) NOT NULL,
            message TEXT NOT NULL,
            metadata JSONB,
            user_id UUID,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_logs_time ON operation_logs (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_logs_category ON operation_logs (category);
        CREATE INDEX IF NOT EXISTS idx_logs_user ON operation_logs (user_id);
    `).then(() => true).catch(error => {
        applicationDataSchemaPromise = null;
        console.error('ensureApplicationDataTables error:', error);
        return false;
    });

    return applicationDataSchemaPromise;
}

/** Idempotent PostgreSQL schema for the USD shadow-research pipeline. */
async function ensureResearchTables() {
    if (!isPostgresConfigured()) return false;
    if (researchSchemaPromise) return researchSchemaPromise;
    researchSchemaPromise = query(`
        CREATE TABLE IF NOT EXISTS research_market_bars (
            currency VARCHAR(10) NOT NULL DEFAULT 'USD',
            minute_at TIMESTAMPTZ NOT NULL,
            features JSONB NOT NULL,
            collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (currency, minute_at)
        );
        CREATE INDEX IF NOT EXISTS idx_research_market_bars_time
            ON research_market_bars (minute_at DESC);

        CREATE TABLE IF NOT EXISTS research_decisions (
            decision_at TIMESTAMPTZ NOT NULL,
            currency VARCHAR(10) NOT NULL DEFAULT 'USD',
            model_id VARCHAR(64) NOT NULL,
            model_version VARCHAR(100) NOT NULL,
            horizon_minutes INTEGER NOT NULL,
            features JSONB NOT NULL,
            predicted_rate NUMERIC(20, 12),
            p10_rate NUMERIC(20, 12),
            p90_rate NUMERIC(20, 12),
            floor_rate NUMERIC(20, 12),
            recommendation VARCHAR(24) NOT NULL,
            reason VARCHAR(64),
            meets_minimum_order BOOLEAN NOT NULL DEFAULT FALSE,
            simulated_offer_count INTEGER NOT NULL DEFAULT 14,
            simulated_offer_amount NUMERIC(20, 8) NOT NULL DEFAULT 500,
            simulated_offer_period_days INTEGER NOT NULL DEFAULT 2,
            actual_rate NUMERIC(20, 12),
            absolute_error NUMERIC(20, 12),
            p10_covered BOOLEAN,
            p90_covered BOOLEAN,
            label_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (decision_at, currency, model_id, model_version)
        );
        ALTER TABLE research_decisions ADD COLUMN IF NOT EXISTS simulated_offer_period_days INTEGER NOT NULL DEFAULT 2;
        CREATE INDEX IF NOT EXISTS idx_research_decisions_model_time
            ON research_decisions (model_id, decision_at DESC);

        CREATE TABLE IF NOT EXISTS research_order_events (
            event_key VARCHAR(160) PRIMARY KEY,
            offer_id BIGINT NOT NULL,
            currency VARCHAR(10) NOT NULL DEFAULT 'USD',
            event_type VARCHAR(24) NOT NULL,
            amount NUMERIC(20, 8),
            rate NUMERIC(20, 12),
            period INTEGER,
            event_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_research_order_events_offer
            ON research_order_events (offer_id, event_at);

        CREATE TABLE IF NOT EXISTS research_funding_fills (
            trade_id BIGINT PRIMARY KEY,
            offer_id BIGINT,
            currency VARCHAR(10) NOT NULL DEFAULT 'USD',
            executed_at TIMESTAMPTZ NOT NULL,
            amount NUMERIC(20, 8) NOT NULL,
            rate NUMERIC(20, 12) NOT NULL,
            period INTEGER NOT NULL,
            offer_matched BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_research_fills_time
            ON research_funding_fills (executed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_research_fills_offer
            ON research_funding_fills (offer_id, executed_at);

        CREATE TABLE IF NOT EXISTS research_experiments (
            id BIGSERIAL PRIMARY KEY,
            experiment_key VARCHAR(100) NOT NULL UNIQUE,
            model_id VARCHAR(64) NOT NULL,
            model_version VARCHAR(100) NOT NULL,
            stage VARCHAR(32) NOT NULL,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at TIMESTAMPTZ,
            train_start TIMESTAMPTZ,
            train_end TIMESTAMPTZ,
            validation_start TIMESTAMPTZ,
            validation_end TIMESTAMPTZ,
            test_start TIMESTAMPTZ,
            test_end TIMESTAMPTZ,
            metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
            status VARCHAR(24) NOT NULL DEFAULT 'collecting'
        );
        CREATE INDEX IF NOT EXISTS idx_research_experiments_model
            ON research_experiments (model_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS research_model_artifacts (
            version VARCHAR(100) PRIMARY KEY,
            artifact JSONB NOT NULL,
            active BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_research_model_artifacts_active
            ON research_model_artifacts (active, created_at DESC);

        CREATE TABLE IF NOT EXISTS research_config (
            config_key VARCHAR(100) PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS research_collection_runs (
            id BIGSERIAL PRIMARY KEY,
            attempted_at TIMESTAMPTZ NOT NULL,
            status VARCHAR(24) NOT NULL,
            error_code VARCHAR(80),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_research_collection_runs_time
            ON research_collection_runs (attempted_at DESC);
    `).then(() => true).catch(error => {
        researchSchemaPromise = null;
        console.error('ensureResearchTables error:', error);
        return false;
    });
    return researchSchemaPromise;
}

async function saveResearchMarketBar(bar) {
    if (!bar || bar.currency !== 'USD' || !bar.minuteAt || !bar.features) return false;
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return false;
    try {
        await query(`INSERT INTO research_market_bars (currency, minute_at, features)
            VALUES ('USD', $1, $2::jsonb)
            ON CONFLICT (currency, minute_at) DO UPDATE SET
                features = EXCLUDED.features, collected_at = NOW()`,
        [bar.minuteAt, JSON.stringify(bar.features)]);
        return true;
    } catch (error) {
        console.error('saveResearchMarketBar error:', error.message);
        return false;
    }
}

async function getResearchMarketBars(from = null, to = null, limit = 100000) {
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return [];
    const result = await query(`SELECT minute_at, features FROM research_market_bars
        WHERE currency = 'USD' AND ($1::timestamptz IS NULL OR minute_at >= $1)
          AND ($2::timestamptz IS NULL OR minute_at <= $2)
        ORDER BY minute_at ASC LIMIT $3`, [from, to, Math.max(1, Math.min(Number(limit) || 100000, 250000))]);
    return result?.rows || [];
}

async function saveResearchDecisions(decisions) {
    if (!Array.isArray(decisions) || !decisions.length) return 0;
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return 0;
    const payload = decisions.filter(row => row && row.modelId && row.decisionAt).map(row => ({
        decision_at: row.decisionAt, currency: 'USD', model_id: row.modelId,
        model_version: row.modelVersion || 'unversioned', horizon_minutes: row.horizonMinutes,
        features: row.modelId === 'live_strategy' ? (row.features || {}) : {}, predicted_rate: row.predictedRate ?? null,
        p10_rate: row.p10Rate ?? null, p90_rate: row.p90Rate ?? null, floor_rate: row.floorRate ?? null,
        recommendation: row.recommendation, reason: row.reason || null,
        meets_minimum_order: Boolean(row.meetsMinimumOrder),
        simulated_offer_count: Number.isInteger(row.simulatedOfferCount) ? row.simulatedOfferCount : 14,
        simulated_offer_amount: Number.isFinite(Number(row.simulatedOfferAmount)) ? Number(row.simulatedOfferAmount) : 500,
        simulated_offer_period_days: Number.isInteger(row.simulatedOfferPeriodDays) ? row.simulatedOfferPeriodDays : 2,
    }));
    if (!payload.length) return 0;
    const result = await query(`INSERT INTO research_decisions (
        decision_at, currency, model_id, model_version, horizon_minutes, features,
        predicted_rate, p10_rate, p90_rate, floor_rate, recommendation, reason,
        meets_minimum_order, simulated_offer_count, simulated_offer_amount, simulated_offer_period_days)
        SELECT x.decision_at, 'USD', x.model_id, x.model_version, x.horizon_minutes, x.features,
            x.predicted_rate, x.p10_rate, x.p90_rate, x.floor_rate, x.recommendation, x.reason,
            x.meets_minimum_order, x.simulated_offer_count, x.simulated_offer_amount, x.simulated_offer_period_days
        FROM jsonb_to_recordset($1::jsonb) AS x(
            decision_at timestamptz, model_id text, model_version text, horizon_minutes integer,
            features jsonb, predicted_rate numeric, p10_rate numeric, p90_rate numeric,
            floor_rate numeric, recommendation text, reason text, meets_minimum_order boolean,
            simulated_offer_count integer, simulated_offer_amount numeric, simulated_offer_period_days integer)
        ON CONFLICT (decision_at, currency, model_id, model_version) DO NOTHING`, [JSON.stringify(payload)]);
    return result?.rowCount || 0;
}

async function recordResearchOrderEvent(event) {
    if (!event?.offerId || !['offer_new', 'offer_cancel'].includes(event.eventType)) return false;
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return false;
    const eventAt = event.eventAt || new Date().toISOString();
    const eventKey = `${event.offerId}:${event.eventType}:${new Date(eventAt).getTime()}`;
    await query(`INSERT INTO research_order_events
        (event_key, offer_id, currency, event_type, amount, rate, period, event_at)
        VALUES ($1, $2, 'USD', $3, $4, $5, $6, $7)
        ON CONFLICT (event_key) DO NOTHING`,
    [eventKey, event.offerId, event.eventType, event.amount ?? null, event.rate ?? null, event.period ?? null, eventAt]);
    return true;
}

async function upsertResearchFundingFills(trades) {
    if (!Array.isArray(trades) || !trades.length) return 0;
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return 0;
    const rows = trades.filter(t => t && t.id != null && t.offerId != null && t.timestamp &&
        Number.isFinite(Number(t.amount)) && Number.isFinite(Number(t.rate)) && Number.isFinite(Number(t.period)))
        .map(t => ({ trade_id: t.id, offer_id: t.offerId, executed_at: new Date(Number(t.timestamp)).toISOString(),
            amount: Math.abs(Number(t.amount)), rate: Number(t.rate), period: Number(t.period) }));
    if (!rows.length) return 0;
    const result = await query(`INSERT INTO research_funding_fills
        (trade_id, offer_id, currency, executed_at, amount, rate, period, offer_matched)
        SELECT x.trade_id, x.offer_id, 'USD', x.executed_at, ABS(x.amount), x.rate, x.period,
            EXISTS (SELECT 1 FROM funding_offers o WHERE o.offer_id = x.offer_id)
            OR EXISTS (SELECT 1 FROM research_order_events e WHERE e.offer_id = x.offer_id AND e.event_type = 'offer_new')
        FROM jsonb_to_recordset($1::jsonb) AS x(
            trade_id bigint, offer_id bigint, executed_at timestamptz, amount numeric, rate numeric, period integer)
        ON CONFLICT (trade_id) DO UPDATE SET
            offer_id = EXCLUDED.offer_id, offer_matched =
                EXISTS (SELECT 1 FROM funding_offers o WHERE o.offer_id = EXCLUDED.offer_id)
                OR EXISTS (SELECT 1 FROM research_order_events e WHERE e.offer_id = EXCLUDED.offer_id AND e.event_type = 'offer_new')`,
    [JSON.stringify(rows)]);
    return result?.rowCount || 0;
}

async function getLatestResearchFillTimestamp() {
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return null;
    const result = await query(`SELECT EXTRACT(EPOCH FROM MAX(executed_at)) * 1000 AS timestamp
        FROM research_funding_fills WHERE currency = 'USD'`, []);
    const timestamp = Number(result?.rows?.[0]?.timestamp);
    return Number.isFinite(timestamp) ? timestamp : null;
}

async function reconcileResearchFundingFillLinks() {
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return 0;
    const result = await query(`UPDATE research_funding_fills f SET offer_matched = TRUE
        WHERE f.currency = 'USD' AND f.offer_matched = FALSE
          AND (EXISTS (SELECT 1 FROM funding_offers o WHERE o.offer_id = f.offer_id)
            OR EXISTS (SELECT 1 FROM research_order_events e WHERE e.offer_id = f.offer_id AND e.event_type = 'offer_new'))`, []);
    return result?.rowCount || 0;
}

async function finalizeResearchLabels(now = new Date()) {
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return 0;
    const result = await query(`WITH eligible AS (
        SELECT d.decision_at, d.currency, d.model_id, d.model_version, d.horizon_minutes,
            (SELECT SUM((b.features->>'fundingVwap')::numeric * (b.features->>'tradeVolume')::numeric)
                / NULLIF(SUM((b.features->>'tradeVolume')::numeric), 0)
             FROM research_market_bars b
             WHERE b.currency = d.currency AND b.minute_at > d.decision_at
               AND b.minute_at <= d.decision_at + make_interval(mins => d.horizon_minutes)
               AND NULLIF(b.features->>'fundingVwap', '') IS NOT NULL
               AND COALESCE((b.features->>'tradeVolume')::numeric, 0) > 0) AS vwap,
            (SELECT COUNT(*) FROM research_market_bars b
             WHERE b.currency = d.currency AND b.minute_at > d.decision_at
               AND b.minute_at <= d.decision_at + make_interval(mins => d.horizon_minutes)
               AND b.features->'dataQuality'->>'tickerFresh' = 'true'
               AND b.features->'dataQuality'->>'bookFresh' = 'true'
               AND b.features->'dataQuality'->>'tradeFresh' = 'true') AS complete_minutes,
            (SELECT MAX(b.minute_at) FROM research_market_bars b
             WHERE b.currency = d.currency AND b.minute_at > d.decision_at
               AND b.minute_at <= d.decision_at + make_interval(mins => d.horizon_minutes)) AS label_at
        FROM research_decisions d
        WHERE d.actual_rate IS NULL
          AND d.decision_at + make_interval(mins => d.horizon_minutes) <= $1
    )
    UPDATE research_decisions d SET
        actual_rate = e.vwap,
        absolute_error = CASE WHEN d.predicted_rate IS NULL THEN NULL ELSE ABS(d.predicted_rate - e.vwap) END,
        p10_covered = CASE WHEN d.p10_rate IS NULL THEN NULL ELSE e.vwap >= d.p10_rate END,
        p90_covered = CASE WHEN d.p90_rate IS NULL THEN NULL ELSE e.vwap <= d.p90_rate END,
        label_at = e.label_at
    FROM eligible e
    WHERE d.decision_at = e.decision_at AND d.currency = e.currency
      AND d.model_id = e.model_id AND d.model_version = e.model_version
      AND e.vwap IS NOT NULL AND e.complete_minutes >= CEIL(e.horizon_minutes * 0.9)`, [now]);
    return result?.rowCount || 0;
}

async function setUnlabeledResearchHorizon(minutes) {
    if (!Number.isInteger(minutes) || minutes <= 0) return 0;
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return 0;
    const result = await query(`UPDATE research_decisions SET horizon_minutes = $1
        WHERE currency = 'USD' AND actual_rate IS NULL`, [minutes]);
    return result?.rowCount || 0;
}

async function getResearchStatus() {
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return { databaseReady: false };
    const [bars, decisions, fills, experiments] = await Promise.all([
        query(`SELECT COUNT(*)::int AS count, MIN(minute_at) AS first_at, MAX(minute_at) AS latest_at,
            COUNT(*) FILTER (WHERE minute_at > NOW() - INTERVAL '60 days'
                AND features->'dataQuality'->>'tickerFresh' = 'true'
                AND features->'dataQuality'->>'bookFresh' = 'true'
                AND features->'dataQuality'->>'tradeFresh' = 'true')::int AS complete60_count,
            (SELECT COUNT(*)::int FROM (
                SELECT minute_at, LAG(minute_at) OVER (ORDER BY minute_at) AS previous_at
                FROM research_market_bars WHERE currency = 'USD' AND minute_at > NOW() - INTERVAL '24 hours'
            ) gaps WHERE previous_at IS NOT NULL AND minute_at - previous_at > INTERVAL '90 seconds') AS gaps24h,
            (SELECT COUNT(*)::int FROM research_collection_runs
                WHERE attempted_at > NOW() - INTERVAL '24 hours' AND status = 'error') AS errors24h
            FROM research_market_bars WHERE currency = 'USD'`),
        query(`SELECT model_id, model_version, MAX(decision_at) AS latest_at, COUNT(*)::int AS predictions,
            COUNT(actual_rate)::int AS labeled, AVG(absolute_error)::float8 AS mae,
            AVG(p10_covered::int)::float8 AS p10_coverage, AVG(p90_covered::int)::float8 AS p90_coverage,
            AVG((actual_rate >= p10_rate AND actual_rate <= p90_rate)::int)::float8 AS interval_coverage
            FROM research_decisions WHERE currency = 'USD' GROUP BY model_id, model_version
            ORDER BY model_id, latest_at DESC`),
        query(`SELECT COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE offer_matched)::int AS matched,
            MAX(executed_at) AS latest_at FROM research_funding_fills WHERE currency = 'USD'`),
        query(`SELECT experiment_key, model_id, model_version, stage, status, metrics,
            started_at, finished_at FROM research_experiments ORDER BY started_at DESC, id DESC LIMIT 20`),
    ]);
    const bar = bars?.rows?.[0] || {};
    const fill = fills?.rows?.[0] || {};
    const latest = bar.latest_at ? new Date(bar.latest_at) : null;
    const ageSeconds = latest ? Math.max(0, Math.round((Date.now() - latest.getTime()) / 1000)) : null;
    return {
        databaseReady: true,
        market: { count: Number(bar.count || 0), firstAt: bar.first_at, latestAt: bar.latest_at,
            ageSeconds, fresh: ageSeconds !== null && ageSeconds <= 180,
            expected60DayMinutes: 60 * 24 * 60,
            coverage60Days: Math.min(1, Number(bar.complete60_count || 0) / (60 * 24 * 60)),
            gaps24h: Number(bar.gaps24h || 0), collectionErrors24h: Number(bar.errors24h || 0) },
        fills: { count: Number(fill.count || 0), matched: Number(fill.matched || 0), latestAt: fill.latest_at },
        models: decisions?.rows || [],
        experiments: experiments?.rows || [],
    };
}

async function recordResearchCollectionRun(attempt) {
    if (!attempt || !['healthy', 'incomplete', 'error'].includes(attempt.status)) return false;
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return false;
    await query(`INSERT INTO research_collection_runs (attempted_at, status, error_code)
        VALUES ($1, $2, $3)`, [attempt.attemptedAt || new Date().toISOString(), attempt.status, attempt.errorCode || null]);
    return true;
}

async function getResearchOfferPeriodDays(userId) {
    if (!userId || !isPostgresConfigured()) return 2;
    try {
        const result = await query('SELECT strategy_config FROM user_bot_settings WHERE user_id = $1', [userId]);
        const period = Number(result?.rows?.[0]?.strategy_config?.periodDays);
        return [2, 10, 30, 60, 90, 120].includes(period) ? period : 2;
    } catch (error) {
        return 2;
    }
}

async function getResearchHorizonDurations(since = null, to = null) {
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return [];
    const result = await query(`SELECT EXTRACT(EPOCH FROM (f.executed_at - o.created_at)) / 60 AS minutes
        FROM research_funding_fills f
        JOIN funding_offers o ON o.offer_id = f.offer_id
        WHERE f.currency = 'USD' AND f.offer_matched = TRUE
          AND ($1::timestamptz IS NULL OR f.executed_at >= $1)
          AND ($2::timestamptz IS NULL OR f.executed_at < $2)
          AND ($1::timestamptz IS NULL OR o.created_at >= $1)
          AND ($2::timestamptz IS NULL OR o.created_at < $2)
          AND f.executed_at >= o.created_at
        ORDER BY f.executed_at ASC`, [since, to]);
    return (result?.rows || []).map(row => Number(row.minutes)).filter(value => Number.isFinite(value) && value > 0);
}

async function getResearchSetting(key) {
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return null;
    const result = await query('SELECT value FROM research_config WHERE config_key = $1', [key]);
    return result?.rows?.[0]?.value || null;
}

async function saveResearchSetting(key, value) {
    if (!key || value === undefined || !isPostgresConfigured() || !(await ensureResearchTables())) return false;
    await query(`INSERT INTO research_config (config_key, value, updated_at)
        VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (config_key) DO NOTHING`, [key, JSON.stringify(value)]);
    return true;
}

async function recordResearchExperiment(experiment) {
    if (!experiment?.experimentKey || !experiment.modelId) return false;
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return false;
    await query(`INSERT INTO research_experiments (
        experiment_key, model_id, model_version, stage, started_at, finished_at,
        train_start, train_end, validation_start, validation_end, test_start, test_end,
        metrics, status)
        VALUES ($1, $2, $3, $4, COALESCE($5, NOW()), $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
        ON CONFLICT (experiment_key) DO UPDATE SET
            model_version = EXCLUDED.model_version, stage = EXCLUDED.stage,
            finished_at = EXCLUDED.finished_at, train_start = EXCLUDED.train_start,
            train_end = EXCLUDED.train_end, validation_start = EXCLUDED.validation_start,
            validation_end = EXCLUDED.validation_end, test_start = EXCLUDED.test_start,
            test_end = EXCLUDED.test_end, metrics = EXCLUDED.metrics, status = EXCLUDED.status`,
    [experiment.experimentKey, experiment.modelId, experiment.modelVersion || 'unversioned', experiment.stage,
        experiment.startedAt || null, experiment.finishedAt || null, experiment.trainStart || null,
        experiment.trainEnd || null, experiment.validationStart || null, experiment.validationEnd || null,
        experiment.testStart || null, experiment.testEnd || null, JSON.stringify(experiment.metrics || {}),
        experiment.status || 'completed']);
    return true;
}

async function saveResearchModelArtifact(artifact) {
    if (!artifact?.version || artifact.schemaVersion !== 1 || !artifact.models) return false;
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return false;
    const p = getPool();
    const client = await p.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE research_model_artifacts SET active = FALSE WHERE active = TRUE');
        await client.query(`INSERT INTO research_model_artifacts (version, artifact, active)
            VALUES ($1, $2::jsonb, TRUE)
            ON CONFLICT (version) DO UPDATE SET artifact = EXCLUDED.artifact, active = TRUE`,
        [artifact.version, JSON.stringify(artifact)]);
        await client.query('COMMIT');
        return true;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function getActiveResearchModelArtifact() {
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return null;
    const result = await query(`SELECT artifact FROM research_model_artifacts
        WHERE active = TRUE ORDER BY created_at DESC LIMIT 1`, []);
    return result?.rows?.[0]?.artifact || null;
}

async function deleteOldResearchData(cutoffDate) {
    if (!isPostgresConfigured() || !(await ensureResearchTables())) return 0;
    const result = await query(`WITH deleted AS (
        DELETE FROM research_market_bars WHERE minute_at < $1 RETURNING 1
    ), decisions AS (
        DELETE FROM research_decisions WHERE decision_at < $1 RETURNING 1
    ), events AS (
        DELETE FROM research_order_events WHERE event_at < $1 RETURNING 1
    ), fills AS (
        DELETE FROM research_funding_fills WHERE executed_at < $1 RETURNING 1
    ), experiments AS (
        DELETE FROM research_experiments WHERE started_at < $1 RETURNING 1
    ), artifacts AS (
        DELETE FROM research_model_artifacts WHERE active = FALSE AND created_at < $1 RETURNING 1
    ), collection_runs AS (
        DELETE FROM research_collection_runs WHERE attempted_at < $1 RETURNING 1
    ) SELECT (SELECT COUNT(*) FROM deleted) + (SELECT COUNT(*) FROM decisions)
        + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM fills)
        + (SELECT COUNT(*) FROM experiments) + (SELECT COUNT(*) FROM artifacts)
        + (SELECT COUNT(*) FROM collection_runs) AS count`, [cutoffDate]);
    return Number(result?.rows?.[0]?.count || 0);
}

/**
 * 降採樣輔助函式：若查詢時長超過 24 小時，每小時只取 1 筆快照點，
 * 避免向前端發送數千筆微小數據，大幅減輕渲染與頻寬負擔。
 */
function downsampleRateHistory(rows, hours) {
    if (!Array.isArray(rows) || rows.length <= 1 || hours <= 24) {
        return rows;
    }
    if (!rows.some(r => r && r.recorded_at)) {
        return rows;
    }
    const sampled = [];
    let lastHourKey = null;
    for (const r of rows) {
        if (!r || !r.recorded_at) continue;
        const hourKey = String(r.recorded_at).slice(0, 13);
        if (hourKey !== lastHourKey) {
            sampled.push(r);
            lastHourKey = hourKey;
        }
    }
    if (rows.length > 0 && sampled[sampled.length - 1] !== rows[rows.length - 1]) {
        sampled.push(rows[rows.length - 1]);
    }
    return sampled;
}

// ============== userId 防護 ==============

function requireUserId(funcName, userId) {
    if (!userId) {
        console.warn(`⚠️ [${funcName}] 呼叫時未傳入 userId — 租戶隔離可能失效！`);
        if (process.env.NODE_ENV === 'test') {
            return true;
        }
        return false;
    }
    return true;
}

// ============== 放貸掛單 ==============

async function saveOffer(offer, userId = null) {
    if (!requireUserId('saveOffer', userId)) return null;

    if (isPostgresConfigured()) {
        try {
            const sql = `
                INSERT INTO funding_offers (offer_id, currency, amount, rate, period, status, user_id, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                ON CONFLICT (offer_id) DO UPDATE SET
                    currency = EXCLUDED.currency,
                    amount = EXCLUDED.amount,
                    rate = EXCLUDED.rate,
                    period = EXCLUDED.period,
                    status = EXCLUDED.status,
                    updated_at = NOW()
                RETURNING *;
            `;
            const params = [
                offer.id,
                offer.currency,
                offer.amount,
                offer.rate,
                offer.period,
                offer.status || 'active',
                userId,
                offer.createdAt || new Date().toISOString()
            ];
            const res = await query(sql, params);
            return res.rows;
        } catch (err) {
            console.error('saveOffer (pg) error:', err);
            return null;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('funding_offers')
        .upsert({
            offer_id: offer.id,
            currency: offer.currency,
            amount: offer.amount,
            rate: offer.rate,
            period: offer.period,
            status: offer.status || 'active',
            created_at: offer.createdAt || new Date().toISOString(),
            user_id: userId,
        }, { onConflict: 'offer_id' })
        .select();
    if (error) console.error('saveOffer error:', error);
    return data;
}

async function closeOffer(offerId, userId = null) {
    if (!requireUserId('closeOffer', userId)) return null;

    if (isPostgresConfigured()) {
        try {
            let sql = `
                UPDATE funding_offers
                SET status = 'closed', closed_at = NOW(), updated_at = NOW()
                WHERE offer_id = $1
            `;
            const params = [offerId];
            if (userId) {
                sql += ` AND user_id = $2`;
                params.push(userId);
            }
            sql += ` RETURNING *;`;
            const res = await query(sql, params);
            return res.rows;
        } catch (err) {
            console.error('closeOffer (pg) error:', err);
            return null;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    let q = db.from('funding_offers').update({
        status: 'closed', 
        closed_at: new Date().toISOString(), 
        updated_at: new Date().toISOString() 
    }).eq('offer_id', offerId);
    
    if (userId) q = q.eq('user_id', userId);
    
    const { data, error } = await q.select();
    if (error) console.error('closeOffer error:', error);
    return data;
}

async function getActiveOffers(currency, userId = null) {
    if (isPostgresConfigured()) {
        try {
            let sql = `SELECT * FROM funding_offers WHERE status = 'active'`;
            const params = [];
            if (currency) {
                params.push(currency);
                sql += ` AND currency = $${params.length}`;
            }
            if (userId) {
                params.push(userId);
                sql += ` AND user_id = $${params.length}`;
            }
            sql += ` ORDER BY created_at DESC;`;
            const res = await query(sql, params);
            return res.rows || [];
        } catch (err) {
            console.error('getActiveOffers (pg) error:', err);
            throw err;
        }
    }

    const db = getSupabase();
    if (!db) throw new Error('No database configured for offer history');
    let q = db.from('funding_offers').select('*').eq('status', 'active');
    if (currency) q = q.eq('currency', currency);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

// ============== 放貸貸款 ==============

async function saveLoan(loan, userId = null) {
    if (!requireUserId('saveLoan', userId)) return null;

    if (isPostgresConfigured()) {
        try {
            const sql = `
                INSERT INTO funding_loans (loan_id, currency, amount, rate, period, opened_at, status, user_id, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                ON CONFLICT (loan_id) DO UPDATE SET
                    currency = EXCLUDED.currency,
                    amount = EXCLUDED.amount,
                    rate = EXCLUDED.rate,
                    period = EXCLUDED.period,
                    status = EXCLUDED.status
                RETURNING *;
            `;
            const params = [
                loan.id,
                loan.currency,
                loan.amount,
                loan.rate,
                loan.period,
                loan.openedAt || new Date().toISOString(),
                loan.status || 'active',
                userId
            ];
            const res = await query(sql, params);
            return res.rows;
        } catch (err) {
            console.error('saveLoan (pg) error:', err);
            return null;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('funding_loans')
        .upsert({
            loan_id: loan.id,
            currency: loan.currency,
            amount: loan.amount,
            rate: loan.rate,
            period: loan.period,
            opened_at: loan.openedAt || new Date().toISOString(),
            status: loan.status || 'active',
            user_id: userId,
        }, { onConflict: 'loan_id' })
        .select();
    if (error) console.error('saveLoan error:', error);
    return data;
}

async function closeLoan(loanId, interestEarned, userId = null) {
    if (!requireUserId('closeLoan', userId)) return null;

    if (isPostgresConfigured()) {
        try {
            let sql = `
                UPDATE funding_loans
                SET status = 'closed', closed_at = NOW(), interest_earned = $2
                WHERE loan_id = $1
            `;
            const params = [loanId, interestEarned === null || interestEarned === undefined ? null : Number(interestEarned) || 0];
            if (userId) {
                sql += ` AND user_id = $3`;
                params.push(userId);
            }
            sql += ` RETURNING *;`;
            const res = await query(sql, params);
            return res.rows;
        } catch (err) {
            console.error('closeLoan (pg) error:', err);
            return null;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    let q = db.from('funding_loans').update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        interest_earned: interestEarned === null || interestEarned === undefined ? null : Number(interestEarned) || 0,
    }).eq('loan_id', loanId);
    
    if (userId) q = q.eq('user_id', userId);
    
    const { data, error } = await q.select();
    if (error) console.error('closeLoan error:', error);
    return data;
}

async function getActiveLoans(currency, userId = null) {
    if (isPostgresConfigured()) {
        try {
            let sql = `SELECT * FROM funding_loans WHERE status = 'active'`;
            const params = [];
            if (currency) {
                params.push(currency);
                sql += ` AND currency = $${params.length}`;
            }
            if (userId) {
                params.push(userId);
                sql += ` AND user_id = $${params.length}`;
            }
            sql += ` ORDER BY opened_at DESC;`;
            const res = await query(sql, params);
            return res.rows || [];
        } catch (err) {
            console.error('getActiveLoans (pg) error:', err);
            throw err;
        }
    }

    const db = getSupabase();
    if (!db) throw new Error('No database configured for loan history');
    let q = db.from('funding_loans').select('*').eq('status', 'active');
    if (currency) q = q.eq('currency', currency);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q.order('opened_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

// ============== 收益紀錄 ==============

async function saveEarning(earning, userId = null) {
    if (!requireUserId('saveEarning', userId)) return null;
    await ensureApplicationDataTables();

    if (isPostgresConfigured()) {
        try {
            const sql = `
                INSERT INTO earnings (currency, amount, rate, period, earned_at, ledger_id, user_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (user_id, ledger_id) DO NOTHING
                RETURNING *;
            `;
            const params = [
                earning.currency,
                earning.amount,
                earning.rate,
                earning.period,
                earning.earnedAt || new Date().toISOString(),
                earning.ledgerId || null,
                userId
            ];
            const res = await query(sql, params);
            return res.rows;
        } catch (err) {
            console.error('saveEarning (pg) error:', err);
            return null;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('earnings')
        .insert({
            currency: earning.currency,
            amount: earning.amount,
            rate: earning.rate,
            period: earning.period,
            earned_at: earning.earnedAt || new Date().toISOString(),
            ledger_id: earning.ledgerId || null,
            user_id: userId,
        }, { onConflict: 'user_id,ledger_id', ignoreDuplicates: true })
        .select();
    if (error) console.error('saveEarning error:', error);
    return data;
}

async function saveEarnings(earnings, userId = null) {
    if (!requireUserId('saveEarnings', userId)) return [];
    if (!Array.isArray(earnings) || earnings.length === 0) return [];
    await ensureApplicationDataTables();

    if (isPostgresConfigured()) {
        const saved = [];
        const chunkSize = 500;
        for (let offset = 0; offset < earnings.length; offset += chunkSize) {
            const chunk = earnings.slice(offset, offset + chunkSize);
            const values = [];
            const placeholders = chunk.map((earning, index) => {
                const base = index * 7;
                values.push(
                    earning.currency,
                    earning.amount,
                    earning.rate,
                    earning.period,
                    earning.earnedAt || new Date().toISOString(),
                    earning.ledgerId || null,
                    userId,
                );
                return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
            });
            try {
                const result = await query(`
                    INSERT INTO earnings (currency, amount, rate, period, earned_at, ledger_id, user_id)
                    VALUES ${placeholders.join(', ')}
                    ON CONFLICT (user_id, ledger_id) DO NOTHING
                    RETURNING *;
                `, values);
                saved.push(...(result.rows || []));
            } catch (error) {
                console.error('saveEarnings (pg) error:', error);
            }
        }
        return saved;
    }

    const db = getSupabase();
    if (!db) return [];
    const rows = earnings.map(earning => ({
        currency: earning.currency,
        amount: earning.amount,
        rate: earning.rate,
        period: earning.period,
        earned_at: earning.earnedAt || new Date().toISOString(),
        ledger_id: earning.ledgerId || null,
        user_id: userId,
    }));
    const { data, error } = await db
        .from('earnings')
        .upsert(rows, { onConflict: 'user_id,ledger_id', ignoreDuplicates: true })
        .select();
    if (error) {
        console.error('saveEarnings error:', error);
        return [];
    }
    return data || [];
}

async function getEarnings(currency, fromDate, toDate, userId = null) {
    if (isPostgresConfigured()) {
        try {
            let sql = `SELECT * FROM earnings WHERE 1=1`;
            const params = [];
            if (currency) {
                params.push(currency);
                sql += ` AND currency = $${params.length}`;
            }
            if (fromDate) {
                params.push(fromDate);
                sql += ` AND earned_at >= $${params.length}`;
            }
            if (toDate) {
                params.push(toDate);
                sql += ` AND earned_at <= $${params.length}`;
            }
            if (userId) {
                params.push(userId);
                sql += ` AND user_id = $${params.length}`;
            }
            sql += ` ORDER BY earned_at DESC;`;
            const res = await query(sql, params);
            return res.rows || [];
        } catch (err) {
            console.error('getEarnings (pg) error:', err);
            throw err;
        }
    }

    const db = getSupabase();
    if (!db) throw new Error('No database configured for earnings');
    let q = db.from('earnings').select('*');
    if (currency) q = q.eq('currency', currency);
    if (fromDate) q = q.gte('earned_at', fromDate);
    if (toDate) q = q.lte('earned_at', toDate);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q.order('earned_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

async function deleteEarnings(currency, userId = null) {
    if (!requireUserId('deleteEarnings', userId)) return false;

    if (isPostgresConfigured()) {
        try {
            let sql = `DELETE FROM earnings WHERE user_id = $1`;
            const params = [userId];
            if (currency) {
                sql += ` AND currency = $2`;
                params.push(currency);
            }
            await query(sql, params);
            return true;
        } catch (err) {
            console.error('deleteEarnings (pg) error:', err);
            return false;
        }
    }

    const db = getSupabase();
    if (!db) return false;
    let q = db.from('earnings').delete().eq('user_id', userId);
    if (currency) q = q.eq('currency', currency);
    else q = q.neq('id', 0);
    const { error } = await q;
    if (error) console.error('deleteEarnings error:', error);
    return !error;
}

// ============== 利率歷史 (全域共享) ==============

function toRateSnapshotRow(snapshot, recordedAt) {
    return {
        currency: snapshot.currency,
        frr: snapshot.frr,
        avg_rate: snapshot.avgRate,
        high_rate: snapshot.highRate,
        low_rate: snapshot.lowRate,
        volume: snapshot.volume,
        bid_depth: snapshot.bidDepth,
        ask_depth: snapshot.askDepth,
        demand_supply_ratio: snapshot.demandSupplyRatio,
        active_offers_count: snapshot.activeOffersCount,
        active_credits_count: snapshot.activeCreditsCount,
        wallet_balance: snapshot.walletBalance,
        recorded_at: snapshot.recordedAt || recordedAt,
    };
}

async function saveRateSnapshots(snapshots) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
    const recordedAt = new Date().toISOString();
    const rows = snapshots.map(snapshot => toRateSnapshotRow(snapshot, recordedAt));

    if (isPostgresConfigured()) {
        try {
            const p = getPool();
            const client = await p.connect();
            try {
                await client.query('BEGIN');
                const insertText = `
                    INSERT INTO rate_history (
                        currency, frr, avg_rate, high_rate, low_rate, volume,
                        bid_depth, ask_depth, demand_supply_ratio,
                        active_offers_count, active_credits_count, wallet_balance, recorded_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                `;
                for (const row of rows) {
                    await client.query(insertText, [
                        row.currency, row.frr, row.avg_rate, row.high_rate, row.low_rate, row.volume,
                        row.bid_depth, row.ask_depth, row.demand_supply_ratio,
                        row.active_offers_count, row.active_credits_count, row.wallet_balance, row.recorded_at
                    ]);
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }

            // 更新記憶體快取
            for (const row of rows) {
                for (const [key, entry] of rateHistoryCache.entries()) {
                    if (key.startsWith(`${row.currency}:`)) {
                        entry.data.push(row);
                    }
                }
            }
            return true;
        } catch (err) {
            console.error('saveRateSnapshots (pg) error:', err);
            return false;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { error } = await db.from('rate_history').insert(rows);
    if (error) {
        console.error('saveRateSnapshots error:', error);
    } else {
        for (const row of rows) {
            for (const [key, entry] of rateHistoryCache.entries()) {
                if (key.startsWith(`${row.currency}:`)) {
                    entry.data.push(row);
                }
            }
        }
    }
    return !error;
}

async function saveRateSnapshot(snapshot) {
    return saveRateSnapshots([snapshot]);
}

// ============== 公開 Funding 撮合紀錄 (OCI PostgreSQL) ==============

function normalizeFundingTrade(trade, currency = 'USD') {
    if (!trade) return null;
    const id = Number(trade.id ?? trade.trade_id);
    const timestamp = Number(trade.timestamp ?? trade.executed_at);
    const amount = Math.abs(Number(trade.amount));
    const rate = Number(trade.rate);
    const period = Number(trade.period);
    if (!Number.isSafeInteger(id) || !Number.isFinite(timestamp) || !Number.isFinite(amount)
        || !Number.isFinite(rate) || !Number.isInteger(period)) return null;
    return { currency, id, timestamp, amount, rate, period };
}

async function upsertFundingTrades(trades, currency = 'USD') {
    if (!Array.isArray(trades) || trades.length === 0) return 0;
    if (!isPostgresConfigured() || !(await ensureFundingTradesTable())) return 0;

    const rows = trades.map(trade => normalizeFundingTrade(trade, currency)).filter(Boolean);
    if (rows.length === 0) return 0;

    try {
        const sql = `
            INSERT INTO funding_trades (currency, trade_id, executed_at, amount, rate, period)
            SELECT $1,
                   item.trade_id,
                   to_timestamp(item.timestamp_ms / 1000.0),
                   item.amount,
                   item.rate,
                   item.period
            FROM jsonb_to_recordset($2::jsonb) AS item(
                trade_id BIGINT,
                timestamp_ms BIGINT,
                amount NUMERIC,
                rate NUMERIC,
                period INTEGER
            )
            ON CONFLICT (currency, trade_id) DO UPDATE SET
                executed_at = EXCLUDED.executed_at,
                amount = EXCLUDED.amount,
                rate = EXCLUDED.rate,
                period = EXCLUDED.period;
        `;
        await query(sql, [currency, JSON.stringify(rows.map(row => ({
            trade_id: row.id,
            timestamp_ms: row.timestamp,
            amount: row.amount,
            rate: row.rate,
            period: row.period,
        })))]);
        return rows.length;
    } catch (err) {
        console.error('upsertFundingTrades (pg) error:', err);
        return 0;
    }
}

async function getFundingTrades(currency = 'USD', from = null, to = null) {
    if (!isPostgresConfigured() || !(await ensureFundingTradesTable())) return [];
    const params = [currency];
    let sql = `
        SELECT trade_id, EXTRACT(EPOCH FROM executed_at) * 1000 AS timestamp,
               amount, rate, period
        FROM funding_trades
        WHERE currency = $1
    `;
    if (from) {
        params.push(from instanceof Date ? from.toISOString() : from);
        sql += ` AND executed_at >= $${params.length}`;
    }
    if (to) {
        params.push(to instanceof Date ? to.toISOString() : to);
        sql += ` AND executed_at <= $${params.length}`;
    }
    sql += ' ORDER BY executed_at DESC, trade_id DESC;';

    try {
        const result = await query(sql, params);
        return (result?.rows || []).map(row => ({
            id: Number(row.trade_id),
            timestamp: Number(row.timestamp),
            amount: Number(row.amount),
            rate: Number(row.rate),
            period: Number(row.period),
        }));
    } catch (err) {
        console.error('getFundingTrades (pg) error:', err);
        throw err;
    }
}

async function getLatestFundingTradeTimestamp(currency = 'USD') {
    if (!isPostgresConfigured() || !(await ensureFundingTradesTable())) return null;
    try {
        const result = await query(`
            SELECT EXTRACT(EPOCH FROM MAX(executed_at)) * 1000 AS timestamp
            FROM funding_trades
            WHERE currency = $1;
        `, [currency]);
        const timestamp = Number(result?.rows?.[0]?.timestamp);
        return Number.isFinite(timestamp) ? timestamp : null;
    } catch (err) {
        console.error('getLatestFundingTradeTimestamp (pg) error:', err);
        return null;
    }
}

async function getOldestFundingTradeTimestamp(currency = 'USD') {
    if (!isPostgresConfigured() || !(await ensureFundingTradesTable())) return null;
    try {
        const result = await query(`
            SELECT EXTRACT(EPOCH FROM MIN(executed_at)) * 1000 AS timestamp
            FROM funding_trades
            WHERE currency = $1;
        `, [currency]);
        const timestamp = Number(result?.rows?.[0]?.timestamp);
        return Number.isFinite(timestamp) ? timestamp : null;
    } catch (err) {
        console.error('getOldestFundingTradeTimestamp (pg) error:', err);
        return null;
    }
}

async function deleteOldFundingTrades(cutoffDate) {
    if (!isPostgresConfigured() || !(await ensureFundingTradesTable())) return 0;
    try {
        const result = await query('DELETE FROM funding_trades WHERE executed_at < $1;', [cutoffDate]);
        return result?.rowCount || 0;
    } catch (err) {
        console.error('deleteOldFundingTrades (pg) error:', err);
        return 0;
    }
}

async function getFundingTradeDiagnostics(currency = 'USD') {
    const configured = isPostgresConfigured();
    if (!configured) {
        return { configured: false, tableReady: false, count: 0, oldestTimestamp: null, latestTimestamp: null };
    }

    const tableReady = await ensureFundingTradesTable();
    if (!tableReady) {
        return {
            configured: true,
            tableReady: false,
            count: 0,
            oldestTimestamp: null,
            latestTimestamp: null,
            errorCode: fundingTradesSchemaErrorCode,
        };
    }

    try {
        const result = await query(`
            SELECT COUNT(*)::bigint AS count,
                   EXTRACT(EPOCH FROM MIN(executed_at)) * 1000 AS oldest_timestamp,
                   EXTRACT(EPOCH FROM MAX(executed_at)) * 1000 AS latest_timestamp
            FROM funding_trades
            WHERE currency = $1;
        `, [currency]);
        const row = result?.rows?.[0] || {};
        return {
            configured: true,
            tableReady: true,
            count: Number(row.count || 0),
            oldestTimestamp: Number.isFinite(Number(row.oldest_timestamp)) ? Number(row.oldest_timestamp) : null,
            latestTimestamp: Number.isFinite(Number(row.latest_timestamp)) ? Number(row.latest_timestamp) : null,
        };
    } catch (error) {
        return {
            configured: true,
            tableReady: true,
            count: null,
            oldestTimestamp: null,
            latestTimestamp: null,
            error: error.message,
        };
    }
}

// ============== 訂單簿快照 ==============

async function saveOrderBookSnapshot(snapshot) {
    if (isPostgresConfigured()) {
        try {
            const sql = `
                INSERT INTO order_book_snapshots (
                    currency, frr, bids, asks, bid_total, ask_total,
                    spread, best_bid_rate, best_ask_rate, demand_supply_ratio, recorded_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                RETURNING *;
            `;
            const params = [
                snapshot.currency,
                snapshot.frr,
                JSON.stringify(snapshot.bids || []),
                JSON.stringify(snapshot.asks || []),
                snapshot.bidTotal,
                snapshot.askTotal,
                snapshot.spread,
                snapshot.bestBidRate,
                snapshot.bestAskRate,
                snapshot.demandSupplyRatio
            ];
            const res = await query(sql, params);
            return res.rows;
        } catch (err) {
            console.error('saveOrderBookSnapshot (pg) error:', err);
            return null;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('order_book_snapshots')
        .insert({
            currency: snapshot.currency,
            frr: snapshot.frr,
            bids: snapshot.bids,
            asks: snapshot.asks,
            bid_total: snapshot.bidTotal,
            ask_total: snapshot.askTotal,
            spread: snapshot.spread,
            best_bid_rate: snapshot.bestBidRate,
            best_ask_rate: snapshot.bestAskRate,
            demand_supply_ratio: snapshot.demandSupplyRatio,
            recorded_at: new Date().toISOString(),
        })
        .select();
    if (error) console.error('saveOrderBookSnapshot error:', error);
    return data;
}

async function fetchSupabaseRateHistory(currency, fromDate, select) {
    const db = getSupabase();
    if (!db) return [];

    const pageSize = 1000;
    const rows = [];

    try {
        for (let page = 0; ; page += 1) {
            const { data, error } = await db
                .from('rate_history')
                .select(select)
                .eq('currency', currency)
                .gte('recorded_at', fromDate)
                .order('recorded_at', { ascending: true })
                .range(page * pageSize, (page + 1) * pageSize - 1);

            if (error) {
                console.error('getRateHistory (Supabase fallback) error:', error);
                break;
            }

            rows.push(...(data || []));
            if (!data || data.length < pageSize) break;
        }
    } catch (err) {
        console.error('getRateHistory (Supabase fallback) exception:', err);
    }

    return rows;
}

async function getRateHistory(currency, hours = 24, select = '*', options = {}) {
    const presentRows = rows => options.downsample === false ? rows : downsampleRateHistory(rows, hours);
    const now = Date.now();
    const fromTimestamp = now - hours * 60 * 60 * 1000;
    const fetchHours = Math.max(hours, 168);
    const cacheKey = `${currency}:${select}:${fetchHours}`;
    const fromDate = new Date(now - fetchHours * 60 * 60 * 1000).toISOString();
    const cached = rateHistoryCache.get(cacheKey);

    if (process.env.NODE_ENV !== 'test' && cached && now < cached.expiresAt) {
        const filtered = cached.data.filter(r => !r?.recorded_at || new Date(r.recorded_at).getTime() >= fromTimestamp);
        return presentRows(filtered);
    }

    let rows = [];
    if (isPostgresConfigured()) {
        try {
            const sql = `
                SELECT ${select === '*' ? '*' : select} FROM rate_history
                WHERE currency = $1 AND recorded_at >= $2
                ORDER BY recorded_at ASC;
            `;
            const res = await query(sql, [currency, fromDate]);
            rows = res?.rows || [];
        } catch (err) {
            console.error('getRateHistory (pg) error:', err);
        }
    }

    // Public rate history predates the Oracle trade collector. Until Oracle has
    // coverage for the requested window, read the missing history from Supabase;
    // funding_trades remain Oracle-only and are never fetched from Supabase.
    const earliestLocalTimestamp = rows.reduce((earliest, row) => {
        const timestamp = new Date(row?.recorded_at).getTime();
        return Number.isFinite(timestamp) ? Math.min(earliest, timestamp) : earliest;
    }, Infinity);
    if (!isPostgresConfigured() || !Number.isFinite(earliestLocalTimestamp) || earliestLocalTimestamp > fromTimestamp) {
        const legacyRows = await fetchSupabaseRateHistory(currency, fromDate, select);
        if (legacyRows.length) {
            const merged = new Map();
            for (const row of legacyRows) {
                const timestamp = new Date(row?.recorded_at).getTime();
                merged.set(Number.isFinite(timestamp) ? String(timestamp) : JSON.stringify(row), row);
            }
            for (const row of rows) {
                const timestamp = new Date(row?.recorded_at).getTime();
                merged.set(Number.isFinite(timestamp) ? String(timestamp) : JSON.stringify(row), row);
            }
            rows = [...merged.values()].sort((a, b) => new Date(a?.recorded_at) - new Date(b?.recorded_at));
        }
    }

    if (rows.length > 0 && process.env.NODE_ENV !== 'test') {
        rateHistoryCache.set(cacheKey, {
            data: rows,
            expiresAt: now + RATE_HISTORY_CACHE_TTL_MS,
        });
    } else if (cached && process.env.NODE_ENV !== 'test') {
        return presentRows(cached.data.filter(r => !r?.recorded_at || new Date(r.recorded_at).getTime() >= fromTimestamp));
    }

    const filtered = rows.filter(r => !r?.recorded_at || new Date(r.recorded_at).getTime() >= fromTimestamp);
    return presentRows(filtered);
}

async function getDailyFRRHistory(currency = 'USD', hours = 30 * 24) {
    const rows = await getRateHistory(currency, hours, 'recorded_at,frr', { downsample: false });
    const byDate = new Map();

    for (const row of rows) {
        const timestamp = new Date(row?.recorded_at);
        const rate = Number(row?.frr);
        if (row?.frr === null || row?.frr === undefined || !Number.isFinite(timestamp.getTime()) || !Number.isFinite(rate)) continue;

        const localDate = taipeiDateKey(timestamp);
        let day = byDate.get(localDate);
        if (!day) {
            day = { local_date: localDate, total: 0, high_rate: -Infinity, low_rate: Infinity, sample_count: 0 };
            byDate.set(localDate, day);
        }
        day.total += rate;
        day.high_rate = Math.max(day.high_rate, rate);
        day.low_rate = Math.min(day.low_rate, rate);
        day.sample_count += 1;
    }

    return [...byDate.values()]
        .sort((a, b) => a.local_date.localeCompare(b.local_date))
        .slice(-30)
        .map(day => {
            const avgRate = day.total / day.sample_count;
            return {
                local_date: day.local_date,
                recorded_at: `${day.local_date}T00:00:00+08:00`,
                frr: avgRate,
                avg_rate: avgRate,
                high_rate: day.high_rate,
                low_rate: day.low_rate,
                sample_count: day.sample_count,
            };
        });
}

// ============== 操作日誌 ==============

async function saveLog(level, category, message, metadata = null, userId = null) {
    if (level === 'debug') return null;
    requireUserId('saveLog', userId);

    if (isPostgresConfigured()) {
        try {
            const sql = `
                INSERT INTO operation_logs (level, category, message, metadata, user_id, created_at)
                VALUES ($1, $2, $3, $4, $5, NOW());
            `;
            await query(sql, [level, category, message, metadata ? JSON.stringify(metadata) : null, userId]);
            return;
        } catch (err) {
            console.error('saveLog (pg) error:', err);
            return;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { error } = await db
        .from('operation_logs')
        .insert({ level, category, message, metadata, user_id: userId });
    if (error) console.error('saveLog error:', error);
}

async function getLogs(limit = 100, category = null, userId = null) {
    if (isPostgresConfigured()) {
        try {
            let sql = `SELECT * FROM operation_logs WHERE 1=1`;
            const params = [];
            if (category) {
                params.push(category);
                sql += ` AND category = $${params.length}`;
            }
            if (userId) {
                params.push(userId);
                sql += ` AND user_id = $${params.length}`;
            }
            params.push(limit);
            sql += ` ORDER BY created_at DESC LIMIT $${params.length};`;
            const res = await query(sql, params);
            return res.rows || [];
        } catch (err) {
            console.error('getLogs (pg) error:', err);
            throw err;
        }
    }

    const db = getSupabase();
    if (!db) throw new Error('No database configured for operation logs');
    let q = db.from('operation_logs').select('*');
    if (category) q = q.eq('category', category);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

// ============== 全域系統設定 ==============

async function getSetting(key) {
    if (isPostgresConfigured()) {
        try {
            const res = await query(`SELECT value FROM bot_settings WHERE key = $1;`, [key]);
            return res.rows[0]?.value || null;
        } catch (err) {
            console.error('getSetting (pg) error:', err);
            return null;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('bot_settings')
        .select('value')
        .eq('key', key)
        .single();
    if (error) return null;
    return data?.value;
}

async function saveSetting(key, value) {
    if (isPostgresConfigured()) {
        try {
            const sql = `
                INSERT INTO bot_settings (key, value, updated_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
                RETURNING *;
            `;
            const res = await query(sql, [key, JSON.stringify(value)]);
            return res.rows;
        } catch (err) {
            console.error('saveSetting (pg) error:', err);
            return null;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('bot_settings')
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
        .select();
    if (error) console.error('saveSetting error:', error);
    return data;
}

// ============== 用戶專屬設定 ==============

async function getUserSettings(userId) {
    if (isPostgresConfigured()) {
        try {
            if (!(await ensureUserBotSettingsTable())) throw new Error('Could not ensure user_bot_settings table');
            const res = await query(`SELECT * FROM user_bot_settings WHERE user_id = $1;`, [userId]);
            return res.rows[0] || null;
        } catch (err) {
            console.error('getUserSettings (pg) error:', err);
            throw err;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('user_bot_settings')
        .select('*')
        .eq('user_id', userId)
        .single();
    if (error) return null;
    return data;
}

async function saveUserSettings(userId, settings) {
    if (!requireUserId('saveUserSettings', userId)) return null;

    const normalizedSettings = { ...settings };
    if (Object.prototype.hasOwnProperty.call(normalizedSettings, 'telegram_chat_id')) {
        const { normalizeTelegramChatId } = require('./telegram-routing');
        normalizedSettings.telegram_chat_id = normalizeTelegramChatId(normalizedSettings.telegram_chat_id);
    }

    if (isPostgresConfigured()) {
        try {
            if (!(await ensureUserBotSettingsTable())) throw new Error('Could not ensure user_bot_settings table');
            const keys = Object.keys(normalizedSettings);
            const cols = ['user_id', ...keys, 'updated_at'];
            const valPlaceholders = cols.map((_, i) => `$${i + 1}`).join(', ');
            const updateClauses = keys.map(k => `${k} = EXCLUDED.${k}`).concat('updated_at = NOW()').join(', ');

            const sql = `
                INSERT INTO user_bot_settings (${cols.join(', ')})
                VALUES (${valPlaceholders})
                ON CONFLICT (user_id) DO UPDATE SET
                    ${updateClauses}
                RETURNING *;
            `;
            const params = [userId, ...Object.values(normalizedSettings), new Date().toISOString()];
            const res = await query(sql, params);
            return res.rows[0];
        } catch (err) {
            console.error('saveUserSettings (pg) error:', err);
            throw err;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('user_bot_settings')
        .upsert({
            user_id: userId,
            ...normalizedSettings,
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' })
        .select();
    if (error) {
        console.error('saveUserSettings error:', error);
        throw error;
    }
    return data;
}

async function getUserSettingsByTelegramChatId(chatId) {
    const { normalizeTelegramChatId } = require('./telegram-routing');
    const normalizedChatId = normalizeTelegramChatId(chatId);
    if (!normalizedChatId) return null;

    if (isPostgresConfigured()) {
        try {
            if (!(await ensureUserBotSettingsTable())) throw new Error('Could not ensure user_bot_settings table');
            const res = await query(`SELECT * FROM user_bot_settings WHERE telegram_chat_id = $1 LIMIT 1;`, [normalizedChatId]);
            return res.rows[0] || null;
        } catch (err) {
            console.error('getUserSettingsByTelegramChatId (pg) error:', err);
            throw err;
        }
    }

    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('user_bot_settings')
        .select('*')
        .eq('telegram_chat_id', normalizedChatId)
        .maybeSingle();
    if (error) {
        console.error('getUserSettingsByTelegramChatId error:', error);
        return null;
    }
    return data || null;
}

async function getActiveUsers() {
    if (isPostgresConfigured()) {
        try {
            if (!(await ensureUserBotSettingsTable())) throw new Error('Could not ensure user_bot_settings table');
            const res = await query(`SELECT user_id FROM user_bot_settings WHERE status = 'running';`);
            return res.rows.map(x => x.user_id);
        } catch (err) {
            console.error('getActiveUsers (pg) error:', err);
            return [];
        }
    }

    const db = getSupabase();
    if (!db) return [];
    const { data, error } = await db
        .from('user_bot_settings')
        .select('user_id')
        .eq('status', 'running');
    if (error) {
        console.error('getActiveUsers error:', error);
        return [];
    }
    return data.map(x => x.user_id);
}

async function getUsersToResume() {
    if (isPostgresConfigured()) {
        try {
            if (!(await ensureUserBotSettingsTable())) throw new Error('Could not ensure user_bot_settings table');
            const res = await query(`SELECT user_id, status, pause_reason FROM user_bot_settings WHERE status IN ('running', 'paused');`);
            return res.rows || [];
        } catch (err) {
            console.error('getUsersToResume (pg) error:', err);
            return [];
        }
    }

    const db = getSupabase();
    if (!db) return [];
    let { data, error } = await db
        .from('user_bot_settings')
        .select('user_id, status, pause_reason')
        .in('status', ['running', 'paused']);

    if (error && /pause_reason|column .* does not exist/i.test(error.message || '')) {
        ({ data, error } = await db
            .from('user_bot_settings')
            .select('user_id, status')
            .in('status', ['running', 'paused']));
    }

    if (error) {
        console.error('getUsersToResume error:', error);
        return [];
    }
    return data || [];
}

// ============== FRR 歷史均值 ==============

async function getAverageFRR(currency, hours = 168) {
    const cacheKey = `${currency}:${hours}`;
    const cached = averageFRRCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    if (isPostgresConfigured()) {
        try {
            const res = await query(`SELECT get_average_frr($1, $2) AS avg_frr;`, [currency, hours]);
            const val = res.rows[0]?.avg_frr;
            if (val !== null && val !== undefined) {
                const num = parseFloat(val);
                if (!isNaN(num)) {
                    averageFRRCache.set(cacheKey, {
                        value: num,
                        expiresAt: Date.now() + AVERAGE_FRR_CACHE_TTL_MS,
                    });
                    return num;
                }
            }
        } catch (err) {
            // fallback to in-memory calculation
        }
    } else {
        const db = getSupabase();
        if (db) {
            try {
                const { data, error } = await db.rpc('get_average_frr', {
                    p_currency: currency,
                    p_hours: hours,
                });
                if (!error && data !== null && data !== undefined) {
                    const num = parseFloat(data);
                    if (!isNaN(num)) {
                        averageFRRCache.set(cacheKey, {
                            value: num,
                            expiresAt: Date.now() + AVERAGE_FRR_CACHE_TTL_MS,
                        });
                        return num;
                    }
                }
            } catch (rpcErr) {}
        }
    }

    try {
        const history = await getRateHistory(currency, hours, 'frr,recorded_at');
        const frrs = history.map(r => r.frr).filter(v => v !== null && v !== undefined);
        if (frrs.length > 0) {
            const value = frrs.reduce((s, r) => s + r, 0) / frrs.length;
            averageFRRCache.set(cacheKey, {
                value,
                expiresAt: Date.now() + AVERAGE_FRR_CACHE_TTL_MS,
            });
            return value;
        }
    } catch (fallbackErr) {
        console.error('getAverageFRR fallback error:', fallbackErr);
    }

    return null;
}

module.exports = {
    getPool,
    getSupabase,
    query,
    isPostgresConfigured,
    ensureUserBotSettingsTable,
    getUserSettingsSchemaErrorCode: () => userSettingsSchemaErrorCode,
    ensureApplicationDataTables,
    ensureResearchTables, saveResearchMarketBar, getResearchMarketBars, saveResearchDecisions,
    recordResearchOrderEvent, upsertResearchFundingFills, finalizeResearchLabels, getResearchStatus,
    setUnlabeledResearchHorizon, getResearchHorizonDurations, getResearchSetting, saveResearchSetting, recordResearchCollectionRun,
    getResearchOfferPeriodDays,
    getLatestResearchFillTimestamp, reconcileResearchFundingFillLinks,
    recordResearchExperiment, saveResearchModelArtifact, getActiveResearchModelArtifact, deleteOldResearchData,
    saveOffer, closeOffer, getActiveOffers,
    saveLoan, closeLoan, getActiveLoans,
    saveEarning, saveEarnings, getEarnings, deleteEarnings,
    saveRateSnapshot, saveRateSnapshots, getRateHistory, getDailyFRRHistory,
    ensureFundingTradesTable, upsertFundingTrades, getFundingTrades, getFundingTradeDiagnostics,
    getLatestFundingTradeTimestamp, getOldestFundingTradeTimestamp, deleteOldFundingTrades,
    saveOrderBookSnapshot,
    saveLog, getLogs,
    getSetting, saveSetting,
    getUserSettings, saveUserSettings, getUserSettingsByTelegramChatId,
    getActiveUsers, getUsersToResume,
    getAverageFRR,
};
