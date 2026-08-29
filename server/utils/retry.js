const logger = require('./logger');

/**
 * 帶指數退避的重試機制
 * @param {Function} fn - 要執行的非同步函數
 * @param {Object} options - 選項
 * @param {number} options.maxRetries - 最大重試次數
 * @param {number} options.baseDelay - 基礎延遲（ms）
 * @param {string} options.label - 操作名稱（日誌用）
 */
function isNonRetryableError(err) {
    const msg = (err.message || '').toLowerCase();
    // 判斷是否為不可重試的錯誤：400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), API 密鑰無效, 餘額不足等
    return msg.includes('400') || msg.includes('401') || msg.includes('403') ||
           msg.includes('apikey') || msg.includes('api key') || msg.includes('signature') ||
           msg.includes('invalid') || msg.includes('not enough') || msg.includes('balance') ||
           msg.includes('validation');
}

/**
 * 帶指數退避的重試機制
 * @param {Function} fn - 要執行的非同步函數
 * @param {Object} options - 選項
 * @param {number} options.maxRetries - 最大重試次數
 * @param {number} options.baseDelay - 基礎延遲（ms）
 * @param {string} options.label - 操作名稱（日誌用）
 * @param {Function} options.shouldRetry - 自定義判斷是否需要重試的函數
 */
async function withRetry(fn, options = {}) {
    const { maxRetries = 3, baseDelay = 1000, label = 'operation', shouldRetry } = options;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            
            // 檢查是否應該重試
            const canRetry = shouldRetry ? shouldRetry(err) : !isNonRetryableError(err);
            if (!canRetry) {
                logger.warn('retry', `${label} 遇到不可重試錯誤，跳過重試`, {
                    error: err.message,
                    dedupeKey: `${label}:non-retryable`,
                });
                break;
            }

            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
                logger.warn('retry', `${label} 失敗 (第 ${attempt}/${maxRetries} 次)，${Math.round(delay)}ms 後重試`, {
                    error: err.message,
                    dedupeKey: `${label}:retry`,
                });
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    logger.error('retry', `${label} 在 ${maxRetries} 次嘗試或不可重試錯誤後失敗`, {
        error: lastError?.message,
    });
    throw lastError;
}

module.exports = { withRetry };
