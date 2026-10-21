/**
 * 一鍵將 Supabase 資料完整搬遷至 Oracle 本機 PostgreSQL 腳本
 * 使用方法:
 *   node scripts/migrate_from_supabase_to_pg.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const { ensureEncryptedCredential } = require('../server/utils/credential-import');
const { postgresHostTls, requireVerifiedTls } = require('../server/utils/postgres-connection');
const { requireSecureSupabaseUrl } = require('../server/utils/supabase-url');
const { CREDENTIAL_COLUMNS, compareAndSetEncryptedCredentials } = require('../server/utils/supabase-credential-migration');

async function fetchAllUserSettings(supabase) {
    const pageSize = 500;
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase
            .from('user_bot_settings')
            .select('*')
            .order('user_id', { ascending: true })
            .range(offset, offset + pageSize - 1);
        if (error) throw new Error('無法安全檢查 Supabase 帳戶憑證，已停止搬遷。');
        const page = data || [];
        rows.push(...page);
        if (page.length < pageSize) return rows;
    }
}

async function encryptLegacySupabaseCredentials(supabase) {
    const rows = await fetchAllUserSettings(supabase);

    let updatedCount = 0;
    for (const original of rows || []) {
        let current = original;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const updates = {};
            for (const column of CREDENTIAL_COLUMNS) {
                const value = current?.[column];
                if (value) {
                    const encrypted = ensureEncryptedCredential(value);
                    if (encrypted !== value) updates[column] = encrypted;
                }
            }
            const columns = Object.keys(updates);
            if (columns.length === 0) break;
            if (!current.user_id) throw new Error('Supabase 帳戶憑證列缺少 user_id，已停止搬遷。');

            const { updated, error: updateError } = await compareAndSetEncryptedCredentials(
                supabase,
                current.user_id,
                current,
                updates,
            );
            if (updateError) throw new Error('無法安全回存加密後的 Supabase 憑證，已停止搬遷。');
            if (updated) {
                updatedCount += 1;
                break;
            }

            const { data: latest, error: readError } = await supabase
                .from('user_bot_settings')
                .select('*')
                .eq('user_id', current.user_id)
                .maybeSingle();
            if (readError || !latest) throw new Error('無法確認 Supabase 憑證遷移狀態，已停止搬遷。');
            current = latest;
            if (attempt === 2) throw new Error('Supabase 帳戶憑證在搬遷期間持續變更，已停止搬遷。');
        }
    }

    return updatedCount;
}

async function migrate() {
    console.log('====================================================');
    console.log('🚀 開始從 Supabase 遷移資料至本地 PostgreSQL...');
    console.log('====================================================');

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        throw new Error('.env 中缺少 SUPABASE_URL 或 SUPABASE_KEY，無法讀取來源資料。');
    }
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32
        || /your_|change_me|default|example/i.test(process.env.JWT_SECRET)) {
        throw new Error('搬遷前必須在 .env 設定至少 32 個隨機字元的 JWT_SECRET。');
    }

    const supabase = createClient(requireSecureSupabaseUrl(supabaseUrl), supabaseKey);

    console.log('🔌 正在連接目的 PostgreSQL 資料庫...');

    const postgresHost = process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost';
    const pool = process.env.DATABASE_URL
        ? new Pool({ connectionString: requireVerifiedTls(process.env.DATABASE_URL) })
        : new Pool({
            host: postgresHost,
            port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
            user: process.env.PGUSER || process.env.POSTGRES_USER || 'postgres',
            password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || '',
            database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'lending_bot',
            ssl: postgresHostTls(postgresHost),
        });
    let client;

    try {
        client = await pool.connect();
        console.log('✅ 本地 PostgreSQL 連線成功！\n');

        // Fail closed if any legacy source credential cannot be encrypted and
        // safely persisted. The same JWT_SECRET/ENCRYPTION_SALT must be used
        // by the destination application to decrypt imported credentials.
        const encryptedSourceRows = await encryptLegacySupabaseCredentials(supabase);
        console.log(`🔐 已安全檢查 Supabase 帳戶憑證並加密回存 ${encryptedSourceRows} 筆資料列。`);

        // 1. 遷移 bot_settings
        console.log('📦 [1/6] 正在遷移 bot_settings...');
        const { data: botSettings, error: bsErr } = await supabase.from('bot_settings').select('*');
        if (bsErr) {
            console.warn('⚠️ 讀取 bot_settings 失敗:', bsErr.message);
        } else if (botSettings && botSettings.length > 0) {
            for (const row of botSettings) {
                await client.query(`
                    INSERT INTO bot_settings (key, value, updated_at)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
                `, [row.key, JSON.stringify(row.value), row.updated_at || new Date().toISOString()]);
            }
            console.log(`  └─ 成功遷移 ${botSettings.length} 筆全域設定`);
        }

        // 2. 遷移 user_bot_settings
        console.log('📦 [2/6] 正在遷移 user_bot_settings...');
        const userSettings = await fetchAllUserSettings(supabase);
        if (userSettings.length > 0) {
            for (const row of userSettings) {
                // 先確認 users 表有此 user_id (若無則自動建立佔位)
                if (row.user_id) {
                    await client.query(`
                        INSERT INTO users (id, email, role)
                        VALUES ($1, $2, 'admin')
                        ON CONFLICT (id) DO NOTHING;
                    `, [row.user_id, `user_${row.user_id.slice(0, 8)}@lending-bot.local`]);
                }

                await client.query(`
                    INSERT INTO user_bot_settings (
                        user_id, bitfinex_api_key, bitfinex_api_secret,
                        telegram_bot_token, telegram_chat_id, lending_currencies,
                        min_offer_amount, status, strategy_config, compounding_enabled,
                        auto_transfer_enabled, auto_transfer_threshold, pause_reason, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    ON CONFLICT (user_id) DO UPDATE SET
                        bitfinex_api_key = EXCLUDED.bitfinex_api_key,
                        bitfinex_api_secret = EXCLUDED.bitfinex_api_secret,
                        telegram_bot_token = EXCLUDED.telegram_bot_token,
                        telegram_chat_id = EXCLUDED.telegram_chat_id,
                        lending_currencies = EXCLUDED.lending_currencies,
                        min_offer_amount = EXCLUDED.min_offer_amount,
                        status = EXCLUDED.status,
                        strategy_config = EXCLUDED.strategy_config,
                        compounding_enabled = EXCLUDED.compounding_enabled,
                        auto_transfer_enabled = EXCLUDED.auto_transfer_enabled,
                        auto_transfer_threshold = EXCLUDED.auto_transfer_threshold,
                        pause_reason = EXCLUDED.pause_reason,
                        updated_at = EXCLUDED.updated_at;
                `, [
                    row.user_id,
                    ensureEncryptedCredential(row.bitfinex_api_key),
                    ensureEncryptedCredential(row.bitfinex_api_secret),
                    ensureEncryptedCredential(row.telegram_bot_token), row.telegram_chat_id, row.lending_currencies,
                    row.min_offer_amount, row.status, JSON.stringify(row.strategy_config || {}),
                    row.compounding_enabled !== false, row.auto_transfer_enabled || false,
                    row.auto_transfer_threshold || 500, row.pause_reason || null,
                    row.created_at || new Date().toISOString(), row.updated_at || new Date().toISOString()
                ]);
            }
            console.log(`  └─ 成功遷移 ${userSettings.length} 筆使用者放貸設定`);
        }

        // 3. 遷移 funding_offers (活躍與近期掛單)
        console.log('📦 [3/6] 正在遷移 funding_offers...');
        const { data: offers, error: offErr } = await supabase.from('funding_offers').select('*').limit(5000);
        if (offErr) {
            console.warn('⚠️ 讀取 funding_offers 失敗:', offErr.message);
        } else if (offers && offers.length > 0) {
            let count = 0;
            for (const o of offers) {
                await client.query(`
                    INSERT INTO funding_offers (offer_id, currency, amount, rate, period, status, user_id, created_at, updated_at, closed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (offer_id) DO NOTHING;
                `, [o.offer_id, o.currency, o.amount, o.rate, o.period, o.status, o.user_id, o.created_at, o.updated_at, o.closed_at]);
                count++;
            }
            console.log(`  └─ 成功遷移 ${count} 筆掛單紀錄`);
        }

        // 4. 遷移 funding_loans (活躍借貸)
        console.log('📦 [4/6] 正在遷移 funding_loans...');
        const { data: loans, error: lnErr } = await supabase.from('funding_loans').select('*').limit(5000);
        if (lnErr) {
            console.warn('⚠️ 讀取 funding_loans 失敗:', lnErr.message);
        } else if (loans && loans.length > 0) {
            let count = 0;
            for (const l of loans) {
                await client.query(`
                    INSERT INTO funding_loans (loan_id, currency, amount, rate, period, opened_at, closed_at, status, interest_earned, user_id, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    ON CONFLICT (loan_id) DO NOTHING;
                `, [l.loan_id, l.currency, l.amount, l.rate, l.period, l.opened_at, l.closed_at, l.status, l.interest_earned, l.user_id, l.created_at]);
                count++;
            }
            console.log(`  └─ 成功遷移 ${count} 筆借貸紀錄`);
        }

        // 5. 遷移 earnings (收益歷史)
        console.log('📦 [5/6] 正在遷移 earnings...');
        const { data: earnings, error: earnErr } = await supabase.from('earnings').select('*').limit(10000);
        if (earnErr) {
            console.warn('⚠️ 讀取 earnings 失敗:', earnErr.message);
        } else if (earnings && earnings.length > 0) {
            let count = 0;
            for (const e of earnings) {
                await client.query(`
                    INSERT INTO earnings (currency, amount, rate, period, earned_at, user_id)
                    VALUES ($1, $2, $3, $4, $5, $6);
                `, [e.currency, e.amount, e.rate, e.period, e.earned_at, e.user_id]);
                count++;
            }
            console.log(`  └─ 成功遷移 ${count} 筆收益紀錄`);
        }

        // 6. 遷移 rate_history (近期利率歷史)
        console.log('📦 [6/6] 正在遷移 rate_history (近期 3 天)...');
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        const { data: rates, error: rateErr } = await supabase
            .from('rate_history')
            .select('*')
            .gte('recorded_at', threeDaysAgo)
            .order('recorded_at', { ascending: true })
            .limit(10000);

        if (rateErr) {
            console.warn('⚠️ 讀取 rate_history 失敗:', rateErr.message);
        } else if (rates && rates.length > 0) {
            for (const r of rates) {
                await client.query(`
                    INSERT INTO rate_history (
                        currency, frr, avg_rate, high_rate, low_rate, volume,
                        bid_depth, ask_depth, demand_supply_ratio,
                        active_offers_count, active_credits_count, wallet_balance, recorded_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);
                `, [
                    r.currency, r.frr, r.avg_rate, r.high_rate, r.low_rate, r.volume,
                    r.bid_depth, r.ask_depth, r.demand_supply_ratio,
                    r.active_offers_count, r.active_credits_count, r.wallet_balance, r.recorded_at
                ]);
            }
            console.log(`  └─ 成功遷移 ${rates.length} 筆利率歷史數據`);
        }

        console.log('\n====================================================');
        console.log('🎉 恭喜！所有 Supabase 資料已成功搬遷至本地 PostgreSQL！');
        console.log('====================================================\n');
    } catch (err) {
        console.error('❌ 遷移過程中發生錯誤:', err.message);
        throw err;
    } finally {
        client?.release();
        await pool.end();
    }
}

if (require.main === module) {
    migrate().catch(() => { process.exitCode = 1; });
}

module.exports = { encryptLegacySupabaseCredentials };
