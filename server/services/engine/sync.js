const db = require('../database');
const logger = require('../../utils/logger');
const config = require('../../config');
const { decryptWithFallback } = require('../../utils/crypto');

// 用於記錄每個用戶的最後同步時間，以進行 10 分鐘冷卻（防 Rate Limit）
const lastSyncTimes = new Map();

function parseLedgerEntry(row) {
    if (!Array.isArray(row) || row.length < 6) return null;
    const walletNames = new Set(['exchange', 'margin', 'funding', 'contribution']);
    const hasWalletField = walletNames.has(String(row[2] || '').toLowerCase());
    const legacyShape = row.length === 8 && !hasWalletField;
    const timestamp = Number(hasWalletField ? row[3] : legacyShape ? row[2] : row[3]);
    const amount = Number(hasWalletField ? (row.length >= 9 ? row[5] : row[4] ?? row[5]) : legacyShape ? row[4] : row[5]);
    const id = Number(row[0]);
    const earnedAt = new Date(timestamp);
    if (!Number.isFinite(timestamp) || !Number.isFinite(amount) || !Number.isFinite(earnedAt.getTime())) return null;
    return {
        id: Number.isSafeInteger(id) ? id : null,
        currency: String(row[1] || ''),
        wallet: hasWalletField ? String(row[2]).toLowerCase() : null,
        amount,
        earnedAt: earnedAt.toISOString(),
        description: String(row[8] ?? row[7] ?? row[6] ?? ''),
    };
}

/**
 * 同步 Bitfinex Funding Wallet Ledger 實際利息入帳。
 * category 28 會包含多種利息帳目；只保留 Funding Wallet 的正向 USD 入帳。
 * Ledger 不提供單筆 Funding Loan ID，所以這裡記錄帳戶實際入帳，不猜測單筆合約歸屬。
 * @param {string} userId - 用戶 ID
 * @param {boolean} force - 是否強制同步（繞過 10 分鐘冷卻）
 * @param {boolean} notify - 對新入帳金額發送 Telegram 通知
 */
async function syncUserEarnings(userId, force = false, notify = true) {
    try {
        const now = Date.now();
        if (!force && lastSyncTimes.has(userId)) {
            const lastSync = lastSyncTimes.get(userId);
            if (now - lastSync < 10 * 60 * 1000) {
                logger.debug('sync', `用戶 ${userId} 近期已同步過，跳過此週期（冷卻中）`);
                return [];
            }
        }

        const settings = await db.getUserSettings(userId);
        if (!settings?.bitfinex_api_key || !settings?.bitfinex_api_secret) return [];

        const credentials = {
            apiKey: decryptWithFallback(settings.bitfinex_api_key),
            apiSecret: decryptWithFallback(settings.bitfinex_api_secret),
        };

        let ledgerEntries;
        try {
            ledgerEntries = await require('../bitfinex/rest').authRequest('/auth/r/ledgers/hist', {
                limit: 2500,
                category: 28,
                wallet: 'funding',
            }, credentials);
        } catch (error) {
            logger.error('sync', `用戶 ${userId} 取得放貸利息帳本失敗: ${error.message}`);
            return [];
        }
        lastSyncTimes.set(userId, now);

        if (!Array.isArray(ledgerEntries) || ledgerEntries.length === 0) return [];

        const parsedEntries = ledgerEntries.map(parseLedgerEntry).filter(Boolean);
        const usdEntries = parsedEntries.filter(entry => {
            const rawCurrency = entry.currency.startsWith('f') ? entry.currency.substring(1) : entry.currency;
            const currency = config.lending.symbolToCurrency?.[rawCurrency] || rawCurrency;
            const isFundingPayment = !entry.description || /funding payment/i.test(entry.description);
            return currency === 'USD' && entry.amount > 0 && (entry.wallet === null || entry.wallet === 'funding') && isFundingPayment;
        });
        if (usdEntries.length === 0) return [];

        const existingEarnings = (await db.getEarnings('USD', null, null, userId)) || [];
        const existingLedgerIds = new Set(existingEarnings.map(entry => Number(entry.ledger_id)).filter(Number.isSafeInteger));
        const latestExistingAt = existingEarnings.reduce((latest, entry) => {
            const timestamp = new Date(entry.earned_at).getTime();
            return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
        }, 0);
        const existingLegacyKeys = new Set(existingEarnings.filter(entry => entry.ledger_id === null || entry.ledger_id === undefined).map(entry =>
            `${new Date(entry.earned_at).getTime()}_${Number(entry.amount).toFixed(8)}`
        ));

        const candidateRows = [];
        for (const entry of usdEntries) {
            const key = `${new Date(entry.earnedAt).getTime()}_${Number(entry.amount).toFixed(8)}`;
            if ((entry.id !== null && existingLedgerIds.has(entry.id)) || existingLegacyKeys.has(key)) continue;
            candidateRows.push({
                currency: 'USD',
                amount: entry.amount,
                rate: 0,
                period: 0,
                earnedAt: entry.earnedAt,
                ledgerId: entry.id,
            });
        }

        if (candidateRows.length === 0) return [];
        const savedRows = typeof db.saveEarnings === 'function'
            ? await db.saveEarnings(candidateRows, userId)
            : (await Promise.all(candidateRows.map(row => db.saveEarning(row, userId)))).flat().filter(Boolean);
        const savedIds = new Set((savedRows || []).map(row => Number(row.ledger_id)).filter(Number.isSafeInteger));
        const savedKeys = new Set((savedRows || []).map(row =>
            `${new Date(row.earned_at || row.earnedAt).getTime()}_${Number(row.amount).toFixed(8)}`
        ));
        const newEntries = usdEntries.filter(entry => entry.id !== null
            ? savedIds.has(entry.id)
            : savedKeys.has(`${new Date(entry.earnedAt).getTime()}_${Number(entry.amount).toFixed(8)}`)
        );

        if (notify && existingEarnings.length > 0 && newEntries.length > 0) {
            const { sendActualFundingInterestNotification } = require('../telegram');
            const reportableEntries = newEntries.filter(entry => new Date(entry.earnedAt).getTime() >= latestExistingAt);
            for (const entry of reportableEntries) {
                await sendActualFundingInterestNotification(entry, userId);
            }
        }

        if (newEntries.length > 0) {
            logger.info('sync', `✅ 用戶 ${userId} 新增 ${newEntries.length} 筆 USD 放貸實際利息入帳`);
        }
        return newEntries.map(entry => ({ currency: 'USD', amount: entry.amount, earnedAt: entry.earnedAt, ledgerId: entry.id }));
    } catch (error) {
        logger.error('sync', `同步用戶 ${userId} 放貸實際利息失敗: ${error.message}`);
        return [];
    }
}

module.exports = {
    syncUserEarnings,
    parseLedgerEntry,
};
