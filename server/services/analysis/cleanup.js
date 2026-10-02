const db = require('../database');
const logger = require('../../utils/logger');

let cleanupTimer = null;

// 資料保留天數設定（支援環境變數自訂，預設 30 天）
const DEFAULT_CLOSED_ORDER_RETENTION_DAYS = parseInt(process.env.CLOSED_ORDER_RETENTION_DAYS, 10) || 30;
const DEFAULT_OPERATION_LOG_RETENTION_DAYS = parseInt(process.env.OPERATION_LOG_RETENTION_DAYS, 10) || 30;
const DEFAULT_RATE_HISTORY_RETENTION_DAYS = parseInt(process.env.RATE_HISTORY_RETENTION_DAYS, 10) || 30;
const DEFAULT_ORDERBOOK_SNAPSHOT_RETENTION_DAYS = parseInt(process.env.ORDERBOOK_SNAPSHOT_RETENTION_DAYS, 10) || 7;
const DEFAULT_FUNDING_TRADE_RETENTION_DAYS = parseInt(process.env.FUNDING_TRADE_RETENTION_DAYS, 10) || 2;

/**
 * 執行資料庫過期資料自動滾動清理程序
 * @param {Object} options 覆寫保留天數選項
 * @param {Object} [customDbClient] 可注入之資料庫客戶端（供測試或特定連線使用）
 * @returns {Promise<{success: boolean, stats: Object, error?: string}>}
 */
async function runCleanup(options = {}, customDbClient = null) {
    const orderDays = options.closedOrderDays ?? DEFAULT_CLOSED_ORDER_RETENTION_DAYS;
    const logDays = options.logDays ?? DEFAULT_OPERATION_LOG_RETENTION_DAYS;
    const rateDays = options.rateDays ?? DEFAULT_RATE_HISTORY_RETENTION_DAYS;
    const obDays = options.snapshotDays ?? DEFAULT_ORDERBOOK_SNAPSHOT_RETENTION_DAYS;
    const fundingTradeDays = options.fundingTradeDays ?? DEFAULT_FUNDING_TRADE_RETENTION_DAYS;

    const orderCutoffDate = new Date(Date.now() - orderDays * 24 * 60 * 60 * 1000).toISOString();
    const logCutoffDate = new Date(Date.now() - logDays * 24 * 60 * 60 * 1000).toISOString();
    const rateHistoryCutoffDate = new Date(Date.now() - rateDays * 24 * 60 * 60 * 1000).toISOString();
    const orderbookCutoffDate = new Date(Date.now() - obDays * 24 * 60 * 60 * 1000).toISOString();
    const fundingTradeCutoffDate = new Date(Date.now() - fundingTradeDays * 24 * 60 * 60 * 1000).toISOString();

    logger.info('cleanup', `正在執行資料庫過期資料滾動清理 (已結案訂單: ${orderDays}天, 日誌: ${logDays}天, 利率: ${rateDays}天, 快照: ${obDays}天, 撮合: ${fundingTradeDays}天)...`);

    const stats = {
        orderCutoffDate,
        logCutoffDate,
        tablesCleaned: [],
        errors: []
    };

    // 1. 若為原生 PostgreSQL 環境且未傳入 mock 客戶端，直接執行原生高效 DELETE
    if (!customDbClient && db.isPostgresConfigured()) {
        try {
            if (db.ensureFundingTradesTable) await db.ensureFundingTradesTable();
            await db.query(`DELETE FROM operation_logs WHERE created_at < $1;`, [logCutoffDate]);
            stats.tablesCleaned.push('operation_logs');

            await db.query(`DELETE FROM funding_offers WHERE status = 'closed' AND (closed_at < $1 OR (closed_at IS NULL AND created_at < $1));`, [orderCutoffDate]);
            stats.tablesCleaned.push('funding_offers');

            await db.query(`DELETE FROM funding_loans WHERE status = 'closed' AND (closed_at < $1 OR (closed_at IS NULL AND opened_at < $1));`, [orderCutoffDate]);
            stats.tablesCleaned.push('funding_loans');

            await db.query(`DELETE FROM rate_history WHERE recorded_at < $1;`, [rateHistoryCutoffDate]);
            stats.tablesCleaned.push('rate_history');

            await db.query(`DELETE FROM order_book_snapshots WHERE recorded_at < $1;`, [orderbookCutoffDate]);
            stats.tablesCleaned.push('order_book_snapshots');

            await db.query(`DELETE FROM funding_trades WHERE executed_at < $1;`, [fundingTradeCutoffDate]);
            stats.tablesCleaned.push('funding_trades');

            logger.info('cleanup', '🎉 資料庫過期資料自動滾動清理作業全數完成 (原生 PostgreSQL)');
            return { success: true, stats };
        } catch (error) {
            logger.error('cleanup', 'PostgreSQL 自動清理過期資料失敗', { error: error.message });
            return { success: false, stats, error: error.message };
        }
    }

    const dbClient = customDbClient || db.getSupabase();
    if (!dbClient) {
        logger.error('cleanup', '無法取得資料庫連線，略過清理');
        return { success: false, stats: {}, error: 'No database client' };
    }

    try {
        // 1. 清理超過天數之 operation_logs
        const { error: logError } = await dbClient
            .from('operation_logs')
            .delete()
            .lt('created_at', logCutoffDate);

        if (logError) {
            logger.error('cleanup', '自動清理過期日誌失敗', { error: logError.message });
            stats.errors.push({ table: 'operation_logs', error: logError.message });
        } else {
            logger.info('cleanup', `🧹 自動清理 ${logDays} 天前舊日誌完成`);
            stats.tablesCleaned.push('operation_logs');
        }

        // 2. 清理已結案 (closed) 且超過天數之 funding_offers（掛單）
        // 注意：進行中 (active) 的掛單絕對保留
        const { error: offerClosedError } = await dbClient
            .from('funding_offers')
            .delete()
            .eq('status', 'closed')
            .lt('closed_at', orderCutoffDate);

        if (offerClosedError) {
            logger.error('cleanup', '自動清理過期 closed funding_offers 失敗', { error: offerClosedError.message });
            stats.errors.push({ table: 'funding_offers(closed_at)', error: offerClosedError.message });
        } else {
            stats.tablesCleaned.push('funding_offers(closed_at)');
        }

        // 處理少數 closed_at 為 null 的歷史 closed 訂單 (以 created_at 為基準)
        const { error: offerNullClosedError } = await dbClient
            .from('funding_offers')
            .delete()
            .eq('status', 'closed')
            .is('closed_at', null)
            .lt('created_at', orderCutoffDate);

        if (offerNullClosedError) {
            logger.error('cleanup', '自動清理過期 closed funding_offers (null closed_at) 失敗', { error: offerNullClosedError.message });
            stats.errors.push({ table: 'funding_offers(null closed_at)', error: offerNullClosedError.message });
        } else {
            logger.info('cleanup', `🧹 自動清理 ${orderDays} 天前已結案掛單 (funding_offers) 完成`);
            stats.tablesCleaned.push('funding_offers');
        }

        // 3. 清理已結案 (closed) 且超過天數之 funding_loans（借貸）
        // 注意：進行中 (active) 的貸款絕對保留
        const { error: loanClosedError } = await dbClient
            .from('funding_loans')
            .delete()
            .eq('status', 'closed')
            .lt('closed_at', orderCutoffDate);

        if (loanClosedError) {
            logger.error('cleanup', '自動清理過期 closed funding_loans 失敗', { error: loanClosedError.message });
            stats.errors.push({ table: 'funding_loans(closed_at)', error: loanClosedError.message });
        } else {
            stats.tablesCleaned.push('funding_loans(closed_at)');
        }

        const { error: loanNullClosedError } = await dbClient
            .from('funding_loans')
            .delete()
            .eq('status', 'closed')
            .is('closed_at', null)
            .lt('opened_at', orderCutoffDate);

        if (loanNullClosedError) {
            logger.error('cleanup', '自動清理過期 closed funding_loans (null closed_at) 失敗', { error: loanNullClosedError.message });
            stats.errors.push({ table: 'funding_loans(null closed_at)', error: loanNullClosedError.message });
        } else {
            logger.info('cleanup', `🧹 自動清理 ${orderDays} 天前已結案借貸 (funding_loans) 完成`);
            stats.tablesCleaned.push('funding_loans');
        }

        // 4. 清理過期 rate_history
        const { error: rateHistoryError } = await dbClient
            .from('rate_history')
            .delete()
            .lt('recorded_at', rateHistoryCutoffDate);

        if (rateHistoryError) {
            logger.error('cleanup', '自動清理過期利率歷史失敗', { error: rateHistoryError.message });
            stats.errors.push({ table: 'rate_history', error: rateHistoryError.message });
        } else {
            logger.info('cleanup', `🧹 自動清理 ${rateDays} 天前利率歷史完成`);
            stats.tablesCleaned.push('rate_history');
        }

        // 5. 清理過期訂單簿快照 (order_book_snapshots，含肥大 JSONB)
        const { error: obError } = await dbClient
            .from('order_book_snapshots')
            .delete()
            .lt('recorded_at', orderbookCutoffDate);

        if (obError) {
            logger.error('cleanup', '自動清理過期訂單簿快照失敗', { error: obError.message });
            stats.errors.push({ table: 'order_book_snapshots', error: obError.message });
        } else {
            logger.info('cleanup', `🧹 自動清理 ${obDays} 天前訂單簿快照完成`);
            stats.tablesCleaned.push('order_book_snapshots');
        }

        const isOverallSuccess = stats.errors.length === 0;
        if (isOverallSuccess) {
            logger.info('cleanup', '🎉 資料庫過期資料自動滾動清理作業全數完成');
        } else {
            logger.warn('cleanup', `⚠️ 資料庫過期資料清理部分完成，共 ${stats.errors.length} 項失敗`);
        }

        return { success: isOverallSuccess, stats, error: isOverallSuccess ? undefined : 'Some tables failed to clean' };
    } catch (error) {
        logger.error('cleanup', '自動清理資料庫過期資料時發生未預期錯誤', { error: error.message });
        return { success: false, stats, error: error.message };
    }
}

/**
 * 啟動每日自動滾動清理排程（服務啟動 10 秒後執行一次，之後每天凌晨 03:00 自動執行）
 */
function startDailyCleanup() {
    logger.info('cleanup', `🧹 啟動資料庫過期資料自動滾動清理程序 (過期訂單 ${DEFAULT_CLOSED_ORDER_RETENTION_DAYS} 天、日誌 ${DEFAULT_OPERATION_LOG_RETENTION_DAYS} 天、撮合 ${DEFAULT_FUNDING_TRADE_RETENTION_DAYS} 天、快照 ${DEFAULT_ORDERBOOK_SNAPSHOT_RETENTION_DAYS} 天)...`);

    // 1. 服務啟動 10 秒後，在背景自動執行一次滾動清理，消除歷史累積
    setTimeout(async () => {
        try {
            await runCleanup();
        } catch (err) {
            logger.error('cleanup', '啟動時自動清理任務出錯', { error: err.message });
        }
    }, 10 * 1000);

    // 2. 定時排程器：每日凌晨 3:00 自動循環執行滾動清理
    function scheduleNextRun() {
        const now = new Date();
        const nextRun = new Date();
        nextRun.setHours(3, 0, 0, 0); // 設定為凌晨 3 點
        
        // 如果今天的 3 點已經過了，就排在明天的 3 點
        if (nextRun <= now) {
            nextRun.setDate(nextRun.getDate() + 1);
        }
        
        const delay = nextRun - now;
        logger.info('cleanup', `下一次例行清理排程將在 ${Math.round(delay / 1000 / 60)} 分鐘後 (即凌晨 3:00) 自動執行`);
        
        cleanupTimer = setTimeout(async () => {
            try {
                await runCleanup();
            } catch (err) {
                logger.error('cleanup', '清理任務執行出錯', { error: err.message });
            }
            scheduleNextRun(); // 循環排程
        }, delay);
    }

    scheduleNextRun();
}

/**
 * 停止每日自動清理排程
 */
function stopDailyCleanup() {
    if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
        logger.info('cleanup', '⏹️ 已停止每日資料庫日誌清理排程');
    }
}

module.exports = {
    startDailyCleanup,
    stopDailyCleanup,
    runCleanup,
    DEFAULT_CLOSED_ORDER_RETENTION_DAYS,
    DEFAULT_OPERATION_LOG_RETENTION_DAYS,
    DEFAULT_RATE_HISTORY_RETENTION_DAYS,
    DEFAULT_ORDERBOOK_SNAPSHOT_RETENTION_DAYS,
    DEFAULT_FUNDING_TRADE_RETENTION_DAYS
};
