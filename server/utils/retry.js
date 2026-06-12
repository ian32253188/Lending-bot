const logger = require('./logger');

/**
 * 帶指數退避的重試機制
 * @param {Function} fn - 要執行的非同步函數
 * @param {Object} options - 選項
 * @param {number} options.maxRetries - 最大重試次數
 * @param {number} options.baseDelay - 基礎延遲（ms）
 * @param {string} options.label - 操作名稱（日誌用）
 */
async function withRetry(fn, options = {}) {
    const { maxRetries = 3, baseDelay = 1000, label = 'operation' } = options;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
                logger.warn('retry', `${label} 失敗 (第 ${attempt}/${maxRetries} 次)，${Math.round(delay)}ms 後重試`, {
                    error: err.message,
                });
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    logger.error('retry', `${label} 在 ${maxRetries} 次嘗試後仍然失敗`, {
        error: lastError?.message,
    });
    throw lastError;
}

module.exports = { withRetry };
