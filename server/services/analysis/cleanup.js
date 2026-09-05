const db = require('../database');
const logger = require('../../utils/logger');

let cleanupTimer = null;
const OPERATION_LOG_RETENTION_DAYS = 7;
const RATE_HISTORY_RETENTION_DAYS = 30;

/**
 * 啟動每日自動清理排程
 */
function startDailyCleanup() {
    logger.info('cleanup', '🧹 啟動每日資料庫過期資料清理程序 (日誌保留 7 天、利率歷史保留 30 天)...');

    function runCleanup() {
        const dbClient = db.getSupabase();
        if (!dbClient) return;

        const cutoffDate = new Date(Date.now() - OPERATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const rateHistoryCutoffDate = new Date(Date.now() - RATE_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
        
        logger.info('cleanup', `正在清理 ${cutoffDate} 之前的過期日誌...`);

        dbClient.from('operation_logs')
            .delete()
            .lt('created_at', cutoffDate)
            .then(async ({ error }) => {
                if (error) {
                    logger.error('cleanup', '自動清理過期日誌失敗', { error: error.message });
                } else {
                    logger.info('cleanup', '🧹 自動清理 7 天前之舊日誌成功完成');
                }

                const { error: rateHistoryError } = await dbClient
                    .from('rate_history')
                    .delete()
                    .lt('recorded_at', rateHistoryCutoffDate);

                if (rateHistoryError) {
                    logger.error('cleanup', '自動清理 30 天前之利率歷史失敗', { error: rateHistoryError.message });
                } else {
                    logger.info('cleanup', '🧹 自動清理 30 天前之利率歷史成功完成');
                }
            })
            .catch(error => {
                logger.error('cleanup', '自動清理資料庫過期資料時發生錯誤', { error: error.message });
            });
    }

    // 排程器：計算當前時間到下個凌晨 3:00 的差值，進行定時執行
    function scheduleNextRun() {
        const now = new Date();
        const nextRun = new Date();
        nextRun.setHours(3, 0, 0, 0); // 設定為凌晨 3 點
        
        // 如果今天的 3 點已經過了，就排在明天的 3 點
        if (nextRun <= now) {
            nextRun.setDate(nextRun.getDate() + 1);
        }
        
        const delay = nextRun - now;
        logger.info('cleanup', `下一次日誌清理排程將在 ${Math.round(delay / 1000 / 60)} 分鐘後 (即凌晨 3:00) 執行`);
        
        cleanupTimer = setTimeout(() => {
            try {
                runCleanup();
            } catch (err) {
                logger.error('cleanup', '清理日誌任務執行出錯', { error: err.message });
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

module.exports = { startDailyCleanup, stopDailyCleanup };
