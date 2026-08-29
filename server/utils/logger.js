const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = process.env.LOG_LEVEL || 'info';
const db = require('../services/database');
const WARNING_SUPPRESSION_WINDOW_MS = 5 * 60 * 1000;
const warningState = new Map();

function formatTime() {
    return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}

function getWarningPersistence(category, message, userId, metadata) {
    const now = Date.now();
    const dedupeKey = metadata && typeof metadata === 'object' && metadata.dedupeKey
        ? metadata.dedupeKey
        : message;
    const key = JSON.stringify([category, dedupeKey, userId || '']);
    const previous = warningState.get(key);

    if (previous && now - previous.lastPersistedAt < WARNING_SUPPRESSION_WINDOW_MS) {
        previous.suppressedCount += 1;
        previous.lastSeenAt = now;
        return null;
    }

    const suppressedCount = previous?.suppressedCount || 0;
    warningState.set(key, { lastPersistedAt: now, lastSeenAt: now, suppressedCount: 0 });

    if (!suppressedCount) return metadata;
    const baseMetadata = metadata && typeof metadata === 'object' ? metadata : {};
    return {
        ...baseMetadata,
        suppressedCount,
        suppressionWindowMs: WARNING_SUPPRESSION_WINDOW_MS,
    };
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

    // debug 只保留在應用程式輸出，不寫入資料庫。
    // 策略每次決策都可能產生 debug 訊息，寫入 operation_logs 會造成不必要的高頻 IO。
    if (level === 'debug') return;

    const metadataForPersistence = level === 'warn'
        ? getWarningPersistence(category, message, finalUserId, finalMetadata)
        : finalMetadata;

    // 相同警告在短時間內只入庫一次；下次入庫時附帶被抑制的次數。
    if (level === 'warn' && metadataForPersistence === null) return;

    // 非同步寫入資料庫（不阻塞）
    db.saveLog(level, category, message, metadataForPersistence, finalUserId).catch(() => { });
}

module.exports = {
    debug: (cat, msg, meta, userId) => log('debug', cat, msg, meta, userId),
    info: (cat, msg, meta, userId) => log('info', cat, msg, meta, userId),
    warn: (cat, msg, meta, userId) => log('warn', cat, msg, meta, userId),
    error: (cat, msg, meta, userId) => log('error', cat, msg, meta, userId),
};
