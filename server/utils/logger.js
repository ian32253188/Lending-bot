const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = process.env.LOG_LEVEL || 'info';
const db = require('../services/database');

function formatTime() {
    return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}

function log(level, category, message, metadata = null) {
    if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;

    // 12-Factor App: 判斷是否為生產環境，若是則輸出結構化 JSON
    if (process.env.NODE_ENV === 'production') {
        const jsonLog = {
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            category,
            message,
        };
        if (metadata) {
            jsonLog.metadata = metadata;
        }
        
        const logStr = JSON.stringify(jsonLog);
        if (level === 'error') {
            console.error(logStr);
        } else if (level === 'warn') {
            console.warn(logStr);
        } else {
            console.log(logStr);
        }
    } else {
        // 開發環境：友善視覺化輸出
        const prefix = {
            debug: '🔍',
            info: '✅',
            warn: '⚠️',
            error: '❌',
        }[level] || 'ℹ️';

        const logLine = `[${formatTime()}] ${prefix} [${category}] ${message}`;
        if (level === 'error') {
            console.error(logLine, metadata || '');
        } else if (level === 'warn') {
            console.warn(logLine, metadata || '');
        } else {
            console.log(logLine, metadata || '');
        }
    }

    // 非同步寫入資料庫（不阻塞）
    db.saveLog(level, category, message, metadata).catch(() => { });
}

module.exports = {
    debug: (cat, msg, meta) => log('debug', cat, msg, meta),
    info: (cat, msg, meta) => log('info', cat, msg, meta),
    warn: (cat, msg, meta) => log('warn', cat, msg, meta),
    error: (cat, msg, meta) => log('error', cat, msg, meta),
};
