const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = process.env.LOG_LEVEL || 'info';
const db = require('../services/database');

function formatTime() {
    return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}

function log(level, category, message, metadata = null) {
    if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;

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

    // 非同步寫入資料庫（不阻塞）
    db.saveLog(level, category, message, metadata).catch(() => { });
}

module.exports = {
    debug: (cat, msg, meta) => log('debug', cat, msg, meta),
    info: (cat, msg, meta) => log('info', cat, msg, meta),
    warn: (cat, msg, meta) => log('warn', cat, msg, meta),
    error: (cat, msg, meta) => log('error', cat, msg, meta),
};
