const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = process.env.LOG_LEVEL || 'info';
const db = require('../services/database');

function formatTime() {
    return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}

function log(level, category, message, metadata = null, userId = null) {
    if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;

    let finalUserId = userId;
    let finalMetadata = metadata;

    if (!finalUserId && metadata) {
        if (typeof metadata === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(metadata)) {
            finalUserId = metadata;
            finalMetadata = null;
        } else if (typeof metadata === 'object') {
            if (metadata.userId) {
                finalUserId = metadata.userId;
            } else if (metadata.user_id) {
                finalUserId = metadata.user_id;
            }
        }
    }

    // 12-Factor App: 判斷是否為生產環境，若是則輸出結構化 JSON
    if (process.env.NODE_ENV === 'production') {
        const jsonLog = {
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            category,
            message,
        };
        if (finalMetadata) {
            jsonLog.metadata = finalMetadata;
        }
        if (finalUserId) {
            jsonLog.userId = finalUserId;
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

        const userTag = finalUserId ? ` [User: ${finalUserId.substring(0, 8)}]` : '';
        const logLine = `[${formatTime()}] ${prefix} [${category}]${userTag} ${message}`;
        if (level === 'error') {
            console.error(logLine, finalMetadata || '');
        } else if (level === 'warn') {
            console.warn(logLine, finalMetadata || '');
        } else {
            console.log(logLine, finalMetadata || '');
        }
    }

    // 非同步寫入資料庫（不阻塞）
    db.saveLog(level, category, message, finalMetadata, finalUserId).catch(() => { });
}

module.exports = {
    debug: (cat, msg, meta, userId) => log('debug', cat, msg, meta, userId),
    info: (cat, msg, meta, userId) => log('info', cat, msg, meta, userId),
    warn: (cat, msg, meta, userId) => log('warn', cat, msg, meta, userId),
    error: (cat, msg, meta, userId) => log('error', cat, msg, meta, userId),
};
