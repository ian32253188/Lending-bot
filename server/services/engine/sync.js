const db = require('../database');
const rest = require('../bitfinex/rest');
const logger = require('../../utils/logger');
const config = require('../../config');
const { decryptWithFallback } = require('../../utils/crypto');

// 用於記錄每個用戶的最後同步時間，以進行 10 分鐘冷卻（防 Rate Limit）
const lastSyncTimes = new Map();

/**
 * 遠端同步特定用戶的放貸收益 (從 Bitfinex Ledger Category 28)
 * @param {string} userId - 用戶 ID
 * @param {boolean} force - 是否強制同步（繞過 10 分鐘冷卻）
 */
async function syncUserEarnings(userId, force = false) {
    try {
        const now = Date.now();
        if (!force && lastSyncTimes.has(userId)) {
            const lastSync = lastSyncTimes.get(userId);
            if (now - lastSync < 10 * 60 * 1000) {
                logger.debug('sync', `用戶 ${userId} 近期已同步過，跳過此週期（冷卻中）`);
                return;
            }
        }

        const supabase = db.getSupabase();
        if (!supabase) return;

        // 取得該用戶的 API 憑證與設定
        const { data: settingsList, error } = await supabase
            .from('user_bot_settings')
            .select('*')
            .eq('user_id', userId)
            .limit(1);

        if (error || !settingsList || settingsList.length === 0) {
            return;
        }

        const settings = settingsList[0];
        if (!settings.bitfinex_api_key || !settings.bitfinex_api_secret) {
            return;
        }

        const credentials = {
            apiKey: decryptWithFallback(settings.bitfinex_api_key),
            apiSecret: decryptWithFallback(settings.bitfinex_api_secret)
        };

        const currencies = settings.lending_currencies || ['USD', 'USDT'];
        let syncCount = 0;

        // 取得 Bitfinex 分類帳歷史中的所有明細 (Category 28 為放貸利息發放)
        const path = '/auth/r/ledgers/hist';
        const body = { limit: 250, category: 28 };
        let ledgerEntries = [];
        try {
            ledgerEntries = await rest.authRequest(path, body, credentials);
        } catch (err) {
            logger.error('sync', `用戶 ${userId} 取得分類帳歷史失敗: ${err.message}`);
            return;
        }

        if (!Array.isArray(ledgerEntries) || ledgerEntries.length === 0) {
            return;
        }

        // 整理每個有設定的放貸幣種
        for (const cur of currencies) {
            // 篩選該幣種的利息入帳明細
            const filteredEntries = ledgerEntries.filter(entry => {
                const entryCur = entry[1];
                if (!entryCur) return false;
                // 去除可能的前綴 'f' (如 fUSD -> USD, fUST -> UST)
                const rawCur = entryCur.startsWith('f') ? entryCur.substring(1) : entryCur;
                // 轉換為內部標示 (如 UST -> USDT)
                const curCode = config.lending.symbolToCurrency?.[rawCur] || rawCur;
                return curCode === cur;
            });
            
            if (filteredEntries.length === 0) continue;

            // 取得資料庫中該用戶該幣種最近的收益紀錄，用於比對
            const existingEarnings = await db.getEarnings(cur, null, null, userId);
            
            // 建立已存在記錄的 lookup key: "timestamp_amount"
            const existingKeys = new Set(
                existingEarnings.map(e => `${new Date(e.earned_at).getTime()}_${Number(e.amount).toFixed(8)}`)
            );

            // 遍歷分類帳寫入未記錄的收益
            for (const entry of filteredEntries) {
                let mts, amount;
                // Bitfinex Ledger API 返回陣列長度可能為 8 或 9+（取決於是否包含錢包名稱欄位）
                if (entry.length === 8) {
                    mts = entry[2];
                    amount = entry[4];
                } else if (entry.length >= 9) {
                    mts = entry[3];
                    amount = entry[5];
                } else {
                    continue; // 格式不符則跳過
                }
                
                // 只有正值（代表利息收入入帳）才記錄
                if (amount <= 0) continue;

                const earnedAt = new Date(mts);
                const key = `${earnedAt.getTime()}_${Number(amount).toFixed(8)}`;

                if (!existingKeys.has(key)) {
                    // 寫入收益紀錄
                    await db.saveEarning({
                        currency: cur,
                        amount: amount,
                        rate: 0, // Ledger 不含單筆利率，填 0 即可
                        period: 0,
                        earnedAt: earnedAt.toISOString()
                    }, userId);
                    syncCount++;
                }
            }
        }

        // 更新最後同步時間
        lastSyncTimes.set(userId, now);

        if (syncCount > 0) {
            logger.info('sync', `✅ 用戶 ${userId} 成功同步 ${syncCount} 筆放貸收益紀錄`);
        }
    } catch (err) {
        logger.error('sync', `同步用戶 ${userId} 收益失敗: ${err.message}`);
    }
}

module.exports = {
    syncUserEarnings
};
