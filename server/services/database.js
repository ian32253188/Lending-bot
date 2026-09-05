const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

let supabase = null;
const averageFRRCache = new Map();
const AVERAGE_FRR_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function getSupabase() {
    if (!supabase) {
        if (!config.supabase.url || !config.supabase.key) {
            console.error('❌ Supabase 設定缺失，資料庫功能將無法使用');
            return null;
        }
        supabase = createClient(config.supabase.url, config.supabase.key);
    }
    return supabase;
}

// ============== userId 防護 ==============

function requireUserId(funcName, userId) {
    if (!userId) {
        console.warn(`⚠️ [${funcName}] 呼叫時未傳入 userId — 租戶隔離可能失效！`);
        if (process.env.NODE_ENV === 'test') {
            return true; // 測試環境允許為 null 寫入以避免外鍵約束衝突
        }
        return false;
    }
    return true;
}

// ============== 放貸掛單 ==============


async function saveOffer(offer, userId = null) {
    if (!requireUserId('saveOffer', userId)) return null;
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
    const db = getSupabase();
    if (!db) return null;
    let query = db.from('funding_offers').update({ 
        status: 'closed', 
        closed_at: new Date().toISOString(), 
        updated_at: new Date().toISOString() 
    }).eq('offer_id', offerId);
    
    if (userId) query = query.eq('user_id', userId);
    
    const { data, error } = await query.select();
    if (error) console.error('closeOffer error:', error);
    return data;
}

async function getActiveOffers(currency, userId = null) {
    const db = getSupabase();
    if (!db) return [];
    let query = db.from('funding_offers').select('*').eq('status', 'active');
    if (currency) query = query.eq('currency', currency);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) console.error('getActiveOffers error:', error);
    return data || [];
}

// ============== 放貸貸款 ==============

async function saveLoan(loan, userId = null) {
    if (!requireUserId('saveLoan', userId)) return null;
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
    const db = getSupabase();
    if (!db) return null;
    let query = db.from('funding_loans').update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        interest_earned: interestEarned || 0,
    }).eq('loan_id', loanId);
    
    if (userId) query = query.eq('user_id', userId);
    
    const { data, error } = await query.select();
    if (error) console.error('closeLoan error:', error);
    return data;
}

async function getActiveLoans(currency, userId = null) {
    const db = getSupabase();
    if (!db) return [];
    let query = db.from('funding_loans').select('*').eq('status', 'active');
    if (currency) query = query.eq('currency', currency);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.order('opened_at', { ascending: false });
    if (error) console.error('getActiveLoans error:', error);
    return data || [];
}

// ============== 收益紀錄 ==============

async function saveEarning(earning, userId = null) {
    if (!requireUserId('saveEarning', userId)) return null;
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
    const db = getSupabase();
    if (!db) return [];
    let query = db.from('earnings').select('*');
    if (currency) query = query.eq('currency', currency);
    if (fromDate) query = query.gte('earned_at', fromDate);
    if (toDate) query = query.lte('earned_at', toDate);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.order('earned_at', { ascending: false });
    if (error) console.error('getEarnings error:', error);
    return data || [];
}

async function deleteEarnings(currency, userId = null) {
    if (!requireUserId('deleteEarnings', userId)) return false;
    const db = getSupabase();
    if (!db) return false;
    let query = db.from('earnings').delete().eq('user_id', userId);
    if (currency) query = query.eq('currency', currency);
    else query = query.neq('id', 0); // Hack to delete all if no currency
    const { error } = await query;
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

/**
 * 批次寫入公開市場快照，讓同一個收集週期只產生一次資料庫交易。
 * 不使用 .select()，因為呼叫端不需要把剛寫入的資料再讀回來。
 */
async function saveRateSnapshots(snapshots) {
    const db = getSupabase();
    if (!db || !Array.isArray(snapshots) || snapshots.length === 0) return null;

    const recordedAt = new Date().toISOString();
    const { error } = await db
        .from('rate_history')
        .insert(snapshots.map(snapshot => toRateSnapshotRow(snapshot, recordedAt)));
    if (error) console.error('saveRateSnapshots error:', error);
    return !error;
}

// 相容既有單筆呼叫端；新的收集器應使用 saveRateSnapshots。
async function saveRateSnapshot(snapshot) {
    return saveRateSnapshots([snapshot]);
}

// ============== 訂單簿快照 (全域共享，AI 訓練用) ==============

async function saveOrderBookSnapshot(snapshot) {
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

async function getRateHistory(currency, hours = 24) {
    const db = getSupabase();
    if (!db) return [];
    const fromDate = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const pageSize = 1000;
    const rows = [];

    // Supabase Data API limits one response to max_rows (1000 in this project).
    // Walk through result pages so a 30-day window is not truncated to the
    // oldest few days of five-minute snapshots.
    for (let page = 0; ; page += 1) {
        const { data, error } = await db
            .from('rate_history')
            .select('*')
            .eq('currency', currency)
            .gte('recorded_at', fromDate)
            .order('recorded_at', { ascending: true })
            .range(page * pageSize, (page + 1) * pageSize - 1);

        if (error) {
            console.error('getRateHistory error:', error);
            return rows;
        }

        rows.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }

    return rows;
}

// ============== 操作日誌 ==============

async function saveLog(level, category, message, metadata = null, userId = null) {
    // debug 只存在於應用程式輸出，不應繞過 logger 寫入資料庫。
    if (level === 'debug') return null;
    requireUserId('saveLog', userId);
    const db = getSupabase();
    if (!db) return null;
    const { error } = await db
        .from('operation_logs')
        .insert({ level, category, message, metadata, user_id: userId });
    if (error) console.error('saveLog error:', error);
}

async function getLogs(limit = 100, category = null, userId = null) {
    const db = getSupabase();
    if (!db) return [];
    let query = db.from('operation_logs').select('*');
    if (category) query = query.eq('category', category);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) console.error('getLogs error:', error);
    return data || [];
}

// ============== 全域系統設定 ==============

async function getSetting(key) {
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
    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('bot_settings')
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
        .select();
    if (error) console.error('saveSetting error:', error);
    return data;
}

// ============== 用戶專屬設定 (SaaS 擴充) ==============

async function getUserSettings(userId) {
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
    const db = getSupabase();
    if (!db) return null;
    const normalizedSettings = { ...settings };
    if (Object.prototype.hasOwnProperty.call(normalizedSettings, 'telegram_chat_id')) {
        const { normalizeTelegramChatId } = require('./telegram-routing');
        normalizedSettings.telegram_chat_id = normalizeTelegramChatId(normalizedSettings.telegram_chat_id);
    }
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
    const db = getSupabase();
    if (!db) return null;
    const { normalizeTelegramChatId } = require('./telegram-routing');
    const normalizedChatId = normalizeTelegramChatId(chatId);
    if (!normalizedChatId) return null;

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
    const db = getSupabase();
    if (!db) return [];
    let { data, error } = await db
        .from('user_bot_settings')
        .select('user_id, status, pause_reason')
        .in('status', ['running', 'paused']);

    // Keep running users recoverable during a rolling deployment where the
    // application may be newer than the database migration. Paused reasons
    // become available once migration 007 is applied.
    if (error && /pause_reason|column .* does not exist/i.test(error.message || '')) {
        console.warn('getUsersToResume: pause_reason 欄位尚未存在，先以狀態恢復運行帳戶');
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

// ============== FRR 歷史均值 (全域共享) ==============

async function getAverageFRR(currency, hours = 168) {
    const db = getSupabase();
    if (!db) return null;
    const cacheKey = `${currency}:${hours}`;
    const cached = averageFRRCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const fromDate = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
        .from('rate_history')
        .select('frr')
        .eq('currency', currency)
        .gte('recorded_at', fromDate)
        .not('frr', 'is', null);
    if (error) {
        console.error('getAverageFRR error:', error);
        return null;
    }
    if (!data || data.length === 0) return null;
    const sum = data.reduce((s, r) => s + (r.frr || 0), 0);
    const value = sum / data.length;
    averageFRRCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + AVERAGE_FRR_CACHE_TTL_MS,
    });
    return value;
}

module.exports = {
    getSupabase,
    saveOffer, closeOffer, getActiveOffers,
    saveLoan, closeLoan, getActiveLoans,
    saveEarning, getEarnings, deleteEarnings,
    saveRateSnapshot, saveRateSnapshots, getRateHistory,
    saveOrderBookSnapshot,
    saveLog, getLogs,
    getSetting, saveSetting,
    getUserSettings, saveUserSettings, getUserSettingsByTelegramChatId,
    getActiveUsers, getUsersToResume,
    getAverageFRR,
};
