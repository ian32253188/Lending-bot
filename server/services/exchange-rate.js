const config = require('../config');
const logger = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PRIMARY_URL = 'https://open.er-api.com/v6/latest/USD';
const DEFAULT_FALLBACK_URL = 'https://api.frankfurter.dev/v2/rate/USD/TWD';
const DEFAULT_TIMEOUT_MS = 5000;

let cachedRate = null;
let cachedAt = 0;
let inFlight = null;
let lastFailureAt = 0;
let lastFailure = null;

function getExchangeRateConfig() {
    return config.exchangeRate || {};
}

function isPositiveFinite(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0;
}

function parseDate(value) {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function sourceName(url) {
    if (url.includes('exchangerate-api.com') || url.includes('open.er-api.com')) return 'ExchangeRate-API';
    if (url.includes('frankfurter.dev')) return 'Frankfurter';
    return '公開匯率 API';
}

function parseUsdToTwdQuote(payload, url) {
    if (!payload || (payload.result && payload.result !== 'success')) return null;

    // ExchangeRate-API Open Access: { base_code: 'USD', rates: { TWD: ... } }
    const openApiRate = payload.rates?.TWD;
    if (isPositiveFinite(openApiRate)) {
        return {
            rate: Number(openApiRate),
            source: sourceName(url),
            quoteDate: parseDate(payload.time_last_update_utc),
        };
    }

    // Frankfurter v2: { base: 'USD', quote: 'TWD', rate: ... }
    if (isPositiveFinite(payload.rate)) {
        return {
            rate: Number(payload.rate),
            source: sourceName(url),
            quoteDate: parseDate(payload.date),
        };
    }

    return null;
}

async function fetchJson(url, timeoutMs, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('執行環境沒有可用的 fetch');
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

    try {
        const options = {
            headers: { accept: 'application/json' },
        };
        if (controller) options.signal = controller.signal;

        const response = await fetchImpl(url, options);
        if (!response?.ok) {
            throw new Error(`匯率 API 回應 HTTP ${response?.status || '未知狀態'}`);
        }
        return await response.json();
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function fetchUsdToTwdRate(fetchImpl = globalThis.fetch) {
    const rateConfig = getExchangeRateConfig();
    const urls = [rateConfig.primaryUrl || DEFAULT_PRIMARY_URL, rateConfig.fallbackUrl || DEFAULT_FALLBACK_URL]
        .filter((url, index, all) => url && all.indexOf(url) === index);
    const timeoutMs = Number(rateConfig.timeoutMs) > 0 ? Number(rateConfig.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const errors = [];

    for (const url of urls) {
        try {
            const payload = await fetchJson(url, timeoutMs, fetchImpl);
            const quote = parseUsdToTwdQuote(payload, url);
            if (!quote) throw new Error('回應缺少有效的 USD/TWD 匯率');
            return {
                ...quote,
                fetchedAt: new Date().toISOString(),
                stale: false,
            };
        } catch (error) {
            errors.push(`${sourceName(url)}: ${error.message}`);
        }
    }

    throw new Error(`無法取得 USD/TWD 匯率（${errors.join('；')}）`);
}

/**
 * 取得最新公開 USD/TWD 匯率。
 * 主來源每日更新，因此成功結果快取 24 小時；若更新失敗則沿用最近一次成功值。
 */
async function getUsdToTwdRate({ force = false, fetchImpl = globalThis.fetch } = {}) {
    const cacheTtlMs = Number(getExchangeRateConfig().cacheTtlMs) > 0
        ? Number(getExchangeRateConfig().cacheTtlMs)
        : DAY_MS;
    const now = Date.now();

    if (!force && cachedRate && now - cachedAt < cacheTtlMs) return cachedRate;
    if (!force && lastFailure && now - lastFailureAt < 5 * 60 * 1000) throw lastFailure;
    if (inFlight) return inFlight;

    inFlight = fetchUsdToTwdRate(fetchImpl)
        .then(quote => {
            cachedRate = quote;
            cachedAt = Date.now();
            lastFailureAt = 0;
            lastFailure = null;
            return quote;
        })
        .catch(error => {
            if (cachedRate) {
                // Prevent every tenant in the same daily-summary run from
                // retrying a temporarily unavailable provider.
                cachedAt = Date.now();
                cachedRate = { ...cachedRate, stale: true };
                logger.warn('exchange-rate', 'USD/TWD 匯率更新失敗，沿用最近一次成功匯率', {
                    error: error.message,
                });
                return cachedRate;
            }
            lastFailureAt = Date.now();
            lastFailure = error;
            throw error;
        })
        .finally(() => {
            inFlight = null;
        });

    return inFlight;
}

function convertToTwd(amount, currency, quote) {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount)) return null;

    const normalizedCurrency = String(currency || 'USD').toUpperCase();
    if (normalizedCurrency === 'TWD') return numericAmount;
    if (normalizedCurrency !== 'USD' && normalizedCurrency !== 'USDT') return null;

    const rate = Number(typeof quote === 'object' ? quote?.rate : quote);
    return isPositiveFinite(rate) ? numericAmount * rate : null;
}

function resetExchangeRateCache() {
    cachedRate = null;
    cachedAt = 0;
    inFlight = null;
    lastFailureAt = 0;
    lastFailure = null;
}

module.exports = {
    convertToTwd,
    getUsdToTwdRate,
    resetExchangeRateCache,
};
