const db = require('../database');
const logger = require('../../utils/logger');

/**
 * 啟動每日自動清理排程
 */
function startDailyCleanup() {
    logger.info('cleanup', '🧹 啟動每日資料庫日誌自動清理程序 (保留 7 天)...');

    function runCleanup() {
        const dbClient = db.getSupabase();
        if (!dbClient) return;

        const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        
        logger.info('cleanup', `正在清理 ${cutoffDate} 之前的過期日誌...`);

        dbClient.from('operation_logs')
            .delete()
            .lt('created_at', cutoffDate)
            .then(({ error }) => {
                if (error) {
                    logger.error('cleanup', '自動清理過期日誌失敗', { error: error.message });
                } else {
                    logger.info('cleanup', '🧹 自動清理 7 天前之舊日誌成功完成');
                }
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
        
        setTimeout(() => {
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

module.exports = { startDailyCleanup };
