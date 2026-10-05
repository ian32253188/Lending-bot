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
let fundingTradesSchemaPromise = null;
let fundingTradesSchemaErrorCode = null;
let userSettingsSchemaPromise = null;
let userSettingsSchemaErrorCode = null;
let applicationDataSchemaPromise = null;

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
            user_id UUID
        );
        CREATE INDEX IF NOT EXISTS idx_earnings_currency_time ON earnings (currency, earned_at DESC);
        CREATE INDEX IF NOT EXISTS idx_earnings_user ON earnings (user_id);

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
            const params = [loanId, interestEarned || 0];
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
        interest_earned: interestEarned || 0,
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

    if (isPostgresConfigured()) {
        try {
            const sql = `
                INSERT INTO earnings (currency, amount, rate, period, earned_at, user_id)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *;
            `;
            const params = [
                earning.currency,
                earning.amount,
                earning.rate,
                earning.period,
                earning.earnedAt || new Date().toISOString(),
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
            user_id: userId,
        })
        .select();
    if (error) console.error('saveEarning error:', error);
    return data;
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

async function getRateHistory(currency, hours = 24, select = '*') {
    const cacheKey = `${currency}:${select}`;
    const now = Date.now();
    const fromTimestamp = now - hours * 60 * 60 * 1000;
    const fetchHours = Math.max(hours, 168);
    const fromDate = new Date(now - fetchHours * 60 * 60 * 1000).toISOString();
    const cached = rateHistoryCache.get(cacheKey);

    if (process.env.NODE_ENV !== 'test' && cached && now < cached.expiresAt) {
        const filtered = cached.data.filter(r => !r?.recorded_at || new Date(r.recorded_at).getTime() >= fromTimestamp);
        return downsampleRateHistory(filtered, hours);
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
        return downsampleRateHistory(cached.data, hours);
    }

    const filtered = rows.filter(r => !r?.recorded_at || new Date(r.recorded_at).getTime() >= fromTimestamp);
    return downsampleRateHistory(filtered, hours);
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
    saveOffer, closeOffer, getActiveOffers,
    saveLoan, closeLoan, getActiveLoans,
    saveEarning, getEarnings, deleteEarnings,
    saveRateSnapshot, saveRateSnapshots, getRateHistory,
    ensureFundingTradesTable, upsertFundingTrades, getFundingTrades, getFundingTradeDiagnostics,
    getLatestFundingTradeTimestamp, getOldestFundingTradeTimestamp, deleteOldFundingTrades,
    saveOrderBookSnapshot,
    saveLog, getLogs,
    getSetting, saveSetting,
    getUserSettings, saveUserSettings, getUserSettingsByTelegramChatId,
    getActiveUsers, getUsersToResume,
    getAverageFRR,
};
