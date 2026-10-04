const logger = require('../../utils/logger');
const db = require('../database');
const rest = require('../bitfinex/rest');
const { getBitfinexPublicWS, isPublicTickerFresh } = require('../bitfinex/ws');
const { getStrategyEngine } = require('./strategy');
const { LendingBot } = require('./lending');
const { decryptWithFallback } = require('../../utils/crypto');
const metrics = require('../metrics');
const { isSingleAccount, SINGLE_ACCOUNT_USER_ID } = require('../../config/single-account');

// The map remains keyed by user ID for compatibility with persisted records,
// but the guard below limits this deployment to its one canonical account.
const activeRunners = new Map();
const activeStarting = new Set(); // 并发启动保护
let globalRateCollectorTimer = null;
let globalHistoricalFRRTimer = null;
let globalRateCollectionInFlight = false;
const HISTORICAL_FRR_REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * 啟動特定使用者的放貸機器人
 */
async function startBot(userId) {
    if (!isSingleAccount(userId)) {
        const error = new Error('此系統僅支援單一放貸帳戶；請使用管理員帳戶設定');
        error.code = 'SINGLE_ACCOUNT_ONLY';
        throw error;
    }
    if (activeStarting.has(userId)) {
        logger.info('manager', `使用者 ${userId} 的放貸機器人啟動中，跳過重複請求`);
        return;
    }
    if (activeRunners.has(userId)) {
        const existingBot = activeRunners.get(userId);
        if (existingBot.paused) {
            existingBot.resume();
            await db.saveUserSettings(userId, { status: 'running', pause_reason: '' });
            logger.info('manager', `使用者 ${userId} 的放貸機器人已由內部暫停恢復`);
        } else {
            logger.warn('manager', `使用者 ${userId} 的放貸機器人已在運行中，跳過啟動`);
        }
        return existingBot;
    }

    activeStarting.add(userId);
    try {
        // 1. 從資料庫讀取該用戶的 API 金鑰與設定
        const userSettings = await db.getUserSettings(userId);
        if (!userSettings) {
            throw new Error('找不到該用戶的放貸設定，請先配置 API 金鑰');
        }

        const {
            bitfinex_api_key,
            bitfinex_api_secret,
            status: persistedStatus,
            pause_reason: persistedPauseReason,
            ...settings
        } = userSettings;
        if (!bitfinex_api_key || !bitfinex_api_secret) {
            throw new Error('API 金鑰未完整設定，無法啟動機器人');
        }

        const decryptedKey = decryptWithFallback(bitfinex_api_key);
        const decryptedSecret = decryptWithFallback(bitfinex_api_secret);

        const credentials = {
            apiKey: decryptedKey,
            apiSecret: decryptedSecret,
        };

        // 整合用戶設定
        const botSettings = {
            compoundingEnabled: settings.compounding_enabled !== false,
            autoTransferEnabled: settings.auto_transfer_enabled || false,
            autoTransferThreshold: settings.auto_transfer_threshold || 500,
            minOfferAmount: settings.min_offer_amount || 150,
            currencies: settings.lending_currencies || ['USD', 'USDT'],
            strategyConfig: settings.strategy_config || { mode: 'simplified' },
        };

        // 2. 實例化並啟動機器人
        const bot = new LendingBot(userId, credentials, botSettings);
        await bot.start();

        // 3. 快取至記憶體，並更新資料庫狀態為 running
        activeRunners.set(userId, bot);
        metrics.setActiveEngines(activeRunners.size);
        await db.saveUserSettings(userId, { status: 'running' });

        // 部署重啟時，保留使用者上次的暫停狀態；手動啟動暫停中的策略也必須由使用者明確恢復。
        if (persistedStatus === 'paused') {
            const pauseReason = persistedPauseReason || '重啟前已暫停';
            bot.pause(pauseReason);
            await db.saveUserSettings(userId, { status: 'paused', pause_reason: pauseReason });
        }

        // 4. 初始化用戶的 Telegram Bot (若有設定)
        if (settings.telegram_bot_token && settings.telegram_chat_id) {
            const { initUserTelegram } = require('../telegram');
            initUserTelegram(userId, settings.telegram_bot_token, settings.telegram_chat_id);
        }

        logger.info('manager', `✅ 已為使用者 ${userId} 建立並啟動獨立的放貸實例`);
        return bot;
    } finally {
        activeStarting.delete(userId);
    }
}

/**
 * 停止特定使用者的放貸機器人
 */
async function stopBot(userId, { persistStatus = true } = {}) {
    if (!isSingleAccount(userId)) {
        const error = new Error('此系統僅支援單一放貸帳戶');
        error.code = 'SINGLE_ACCOUNT_ONLY';
        throw error;
    }
    const bot = activeRunners.get(userId);
    if (!bot) {
        logger.warn('manager', `使用者 ${userId} 的放貸機器人未在運行中`);
        // 手動停止時同步為 stopped；程序關閉時保留原本的 persisted status。
        if (persistStatus) {
            await db.saveUserSettings(userId, { status: 'stopped' });
        }
        return;
    }

    // 1. 停止運行
    await bot.stop();

    // 2. 移出快取；手動停止才更新資料庫狀態為 stopped
    activeRunners.delete(userId);
    metrics.setActiveEngines(activeRunners.size);
    if (persistStatus) {
        await db.saveUserSettings(userId, { status: 'stopped' });
    }

    // 3. 保留使用者 Telegram Bot 常駐，停止後仍可由 Telegram 按「啟動策略」恢復。
    logger.info('manager', `⏹️ 已成功關閉使用者 ${userId} 的放貸實例（Telegram 控制仍保持啟用）`);
}

/**
 * Restart an active engine after a settings change without changing its
 * persisted desired state. This is important for paused engines: a normal
 * stop/start cycle would overwrite paused with stopped and then start it.
 */
async function restartBotPreservingState(userId) {
    const bot = activeRunners.get(userId);
    if (!bot) return null;

    const persistedState = bot.paused ? 'paused' : bot.running ? 'running' : 'stopped';
    await stopBot(userId, { persistStatus: false });
    if (persistedState === 'stopped') return null;
    return startBot(userId);
}

/**
 * 取得特定使用者的運行實例
 */
function getBot(userId) {
    if (!isSingleAccount(userId)) return null;
    return activeRunners.get(userId) || null;
}

function getActiveEngineCount() {
    return activeRunners.size;
}

function getEngineStateCounts() {
    let running = 0;
    let paused = 0;
    for (const bot of activeRunners.values()) {
        if (!bot.running) continue;
        if (bot.paused) paused++;
        else running++;
    }
    return { instances: activeRunners.size, running, paused };
}

/**
 * 伺服器開機自動重啟所有原本處於 running 狀態的用戶
 */
async function autoResumeAll() {
    logger.info('manager', '🔄 啟動自動恢復程序，查詢活躍放貸帳戶...');
    try {
        // 確保公開行情 WebSocket 已開啟
        const publicWs = getBitfinexPublicWS();
        publicWs.connect();

        // 啟動全域行情定時收集器
        startGlobalRateCollector();

        const resumableUsers = await db.getUsersToResume();
        const account = resumableUsers.find(user => isSingleAccount(user.user_id));
        const ignoredLegacyCount = resumableUsers.length - (account ? 1 : 0);
        logger.info('manager', `單一帳戶模式：${account ? '找到可恢復的管理員帳戶' : '沒有可恢復的管理員帳戶'}；忽略 ${ignoredLegacyCount} 筆舊帳戶設定`);

        for (const user of (account ? [account] : [])) {
            const userId = user.user_id;
            try {
                await startBot(userId);
            } catch (err) {
                logger.error('manager', `自動重啟使用者 ${userId} 失敗`, { error: err.message });
                // 保留使用者原本的 desired state，下一次程序啟動時再嘗試恢復。
                // 實際是否活躍仍由 activeRunners / health metrics 判斷。
            }
        }
        logger.info('manager', `✅ 單一帳戶自動恢復程序完成 (${SINGLE_ACCOUNT_USER_ID})`);
    } catch (err) {
        logger.error('manager', '自動恢復程序出錯', { error: err.message });
    }
}

/**
 * 關閉所有記憶體中的實例（優雅關閉用）
 */
async function shutdownAll() {
    logger.info('manager', `⏹️ 正在優雅關閉所有活躍的放貸機器人 (總計 ${activeRunners.size} 個)...`);
    
    stopGlobalRateCollector();

    const userIds = [...activeRunners.keys()];
    for (const userId of userIds) {
        try {
            // 程序／容器重啟不是使用者要求停止，不能覆寫資料庫中的 running 或 paused。
            await stopBot(userId, { persistStatus: false });
        } catch (err) {
            logger.error('manager', `關閉用戶 ${userId} 失敗`, { error: err.message });
        }
    }
    
    const publicWs = getBitfinexPublicWS();
    publicWs.disconnect();
    
    logger.info('manager', '✅ 所有放貸實例關閉完成');
}

// ============== 全域公開行情收集器 (SaaS 優化) ==============
// 只有一份全域定時器，向資料庫寫入公開市場歷史利率，避免多用戶集體收集造成的寫入浪費

function startGlobalRateCollector() {
    if (globalRateCollectorTimer) return;

    logger.info('manager', '📊 啟動全域市場行情收集器 (5分鐘週期)...');
    
    // 每 5 分鐘執行一次
    globalRateCollectorTimer = setInterval(() => {
        collectGlobalRateData();
    }, 5 * 60 * 1000);

    // 啟動 10 秒後先收集一次
    setTimeout(() => collectGlobalRateData(), 10000);

    // 啟動歷史 FRR 均值更新器（歷史值只供摘要顯示，6 小時更新一次）
    globalHistoricalFRRTimer = setInterval(() => {
        updateGlobalHistoricalFRR();
    }, HISTORICAL_FRR_REFRESH_MS);
    setTimeout(() => updateGlobalHistoricalFRR(), 15000);
}

function stopGlobalRateCollector() {
    if (globalRateCollectorTimer) {
        clearInterval(globalRateCollectorTimer);
        globalRateCollectorTimer = null;
    }
    if (globalHistoricalFRRTimer) {
        clearInterval(globalHistoricalFRRTimer);
        globalHistoricalFRRTimer = null;
    }
}

async function collectGlobalRateData() {
    if (globalRateCollectionInFlight) return;
    globalRateCollectionInFlight = true;

    try {
        const publicWs = getBitfinexPublicWS();
        if (!publicWs.isConnected()) return;

        const strategy = getStrategyEngine();
        const snapshots = [];

        for (const currency of ['USD', 'USDT']) {
            try {
                const marketData = publicWs.getMarketData(currency);
                if (!isPublicTickerFresh(marketData)) continue;

                // Note: We use a fixed nominal balance of $10,000 for global market metrics collection since this doesn't execute actual trades.
                const available = 10000;
                const optimalResult = strategy.calculateOptimalRate(marketData, currency, available);

                snapshots.push({
                    currency,
                    frr: marketData.frr,
                    avgRate: marketData.lastPrice ?? marketData.frr,
                    highRate: marketData.high ?? marketData.frr,
                    lowRate: marketData.low ?? marketData.frr,
                    volume: marketData.volume ?? 0,
                    bidDepth: marketData.bids?.length || 0,
                    askDepth: marketData.asks?.length || 0,
                    demandSupplyRatio: optimalResult.diagnostics?.demandSupplyRatio || 1,
                    activeOffersCount: 0,
                    activeCreditsCount: 0,
                    walletBalance: 0,
                });
            } catch (err) {
                logger.error('manager', `全域行情收集 ${currency} 失敗`, { error: err.message });
            }
        }

        if (snapshots.length === 0) return;

        // 同一個收集週期一次提交兩個幣種，減少交易提交與 WAL fsync 次數。
        try {
            if (typeof db.saveRateSnapshots === 'function') {
                await db.saveRateSnapshots(snapshots);
            } else {
                // 與舊版 repository 相容，避免滾動部署期間收集器中斷。
                await Promise.all(snapshots.map(snapshot => db.saveRateSnapshot(snapshot)));
            }
        } catch (err) {
            logger.error('manager', '批次儲存全域行情快照失敗', { error: err.message });
        }
    } finally {
        globalRateCollectionInFlight = false;
    }
}

async function updateGlobalHistoricalFRR() {
    const strategy = getStrategyEngine();
    for (const currency of ['USD', 'USDT']) {
        try {
            // 動態計算 24h/168h(7d) 的 FRR 平均值並寫入策略快取
            const [avg24h, avg7d] = await Promise.all([
                db.getAverageFRR(currency, 24),
                db.getAverageFRR(currency, 168),
            ]);

            if (avg24h) strategy.updateHistoricalAvg(currency, '24h', avg24h);
            if (avg7d) strategy.updateHistoricalAvg(currency, '7d', avg7d);
        } catch (err) {
            logger.error('manager', `更新全域歷史 FRR 均值 (${currency}) 失敗`, { error: err.message });
        }
    }
}

module.exports = {
    startBot,
    stopBot,
    restartBotPreservingState,
    getBot,
    getActiveEngineCount,
    getEngineStateCounts,
    autoResumeAll,
    shutdownAll,
};
