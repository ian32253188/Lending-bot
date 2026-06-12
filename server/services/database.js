const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

let supabase = null;

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
        return false;
    }
    return true;
}

// ============== 放貸掛單 ==============


async function saveOffer(offer, userId = null) {
    requireUserId('saveOffer', userId);
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
    requireUserId('closeOffer', userId);
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
    requireUserId('saveLoan', userId);
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
    requireUserId('closeLoan', userId);
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
    requireUserId('saveEarning', userId);
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
    requireUserId('deleteEarnings', userId);
    const db = getSupabase();
    if (!db) return false;
    let query = db.from('earnings').delete();
    if (currency) query = query.eq('currency', currency);
    else query = query.neq('id', 0); // Hack to delete all if no currency
    if (userId) query = query.eq('user_id', userId);
    const { error } = await query;
    if (error) console.error('deleteEarnings error:', error);
    return !error;
}

// ============== 利率歷史 (全域共享) ==============

async function saveRateSnapshot(snapshot) {
    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('rate_history')
        .insert({
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
            recorded_at: new Date().toISOString(),
        })
        .select();
    if (error) console.error('saveRateSnapshot error:', error);
    return data;
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

// ============== IBRR 即時最佳利率快照 (全域共享) ==============

async function saveIBRRSnapshot(snapshot) {
    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('ibrr_history')
        .insert({
            currency: snapshot.currency,
            ibrr: snapshot.ibrr,
            equilibrium_rate: snapshot.equilibriumRate,
            frr: snapshot.frr,
            frr_trend: snapshot.frrTrend,
            risk_level: snapshot.riskLevel,
            demand_supply_ratio: snapshot.demandSupplyRatio,
            total_demand: snapshot.totalDemand,
            total_supply: snapshot.totalSupply,
            ml_direction: snapshot.mlDirection,
            ml_confidence: snapshot.mlConfidence,
            wall_detected: snapshot.wallDetected,
            wall_rate: snapshot.wallRate,
            best_bid_rate: snapshot.bestBidRate,
            best_ask_rate: snapshot.bestAskRate,
            last_price: snapshot.lastPrice,
            method: snapshot.method,
            recorded_at: new Date().toISOString(),
        })
        .select();
    if (error) console.error('saveIBRRSnapshot error:', error);
    return data;
}

// 取得 IBRR 訓練資料
async function getIBRRTrainingData(currency, hours = 168) {
    const db = getSupabase();
    if (!db) return [];
    const fromDate = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
        .from('ibrr_history')
        .select('*')
        .eq('currency', currency)
        .gte('recorded_at', fromDate)
        .order('recorded_at', { ascending: true });
    if (error) console.error('getIBRRTrainingData error:', error);
    return data || [];
}

async function getRateHistory(currency, hours = 24) {
    const db = getSupabase();
    if (!db) return [];
    const fromDate = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
        .from('rate_history')
        .select('*')
        .eq('currency', currency)
        .gte('recorded_at', fromDate)
        .order('recorded_at', { ascending: true });
    if (error) console.error('getRateHistory error:', error);
    return data || [];
}

// ============== 操作日誌 ==============

async function saveLog(level, category, message, metadata = null, userId = null) {
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
    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db
        .from('user_bot_settings')
        .upsert({
            user_id: userId,
            ...settings,
            updated_at: new Date().toISOString()
        })
        .select();
    if (error) console.error('saveUserSettings error:', error);
    return data;
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

// ============== FRR 歷史均值 (全域共享) ==============

async function getAverageFRR(currency, hours = 168) {
    const db = getSupabase();
    if (!db) return null;
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
    return sum / data.length;
}

module.exports = {
    getSupabase,
    saveOffer, closeOffer, getActiveOffers,
    saveLoan, closeLoan, getActiveLoans,
    saveEarning, getEarnings, deleteEarnings,
    saveRateSnapshot, getRateHistory,
    saveOrderBookSnapshot,
    saveIBRRSnapshot, getIBRRTrainingData,
    saveLog, getLogs,
    getSetting, saveSetting,
    getUserSettings, saveUserSettings, getActiveUsers,
    getAverageFRR,
};
