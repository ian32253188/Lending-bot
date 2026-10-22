const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../utils/logger');
const { withRetry } = require('../../utils/retry');

const BASE_URL = config.bitfinex.restUrl;

/**
 * 內部幣種代碼 → Bitfinex Funding symbol
 * USD → USD
 */
function toBfxSymbol(currency) {
    if (currency !== 'USD') throw new Error('目前僅支援 USD Funding。');
    return 'USD';
}

/**
 * Bitfinex Funding symbol → 內部幣種代碼
 * 去除 funding symbol 的 f 前綴並轉為內部代碼
 */
function fromBfxSymbol(bfxSymbol) {
    const sym = bfxSymbol?.startsWith('f') ? bfxSymbol.slice(1) : bfxSymbol;
    return sym === 'USD' ? 'USD' : null;
}

let lastNonce = 0;
const privateRequestQueues = new Map();
function getNextNonce() {
    const now = Date.now() * 1000;
    lastNonce = Math.max(now, lastNonce + 1);
    return lastNonce.toString();
}

/**
 * 建立已認證的 API 請求
 */
function createAuthHeaders(path, body = {}, credentials = null) {
    const apiKey = credentials?.apiKey || config.bitfinex.apiKey;
    const apiSecret = credentials?.apiSecret || config.bitfinex.apiSecret;

    if (!apiKey || !apiSecret) {
        throw new Error('Bitfinex API key or secret is not configured.');
    }

    const nonce = getNextNonce();
    const bodyStr = JSON.stringify(body);
    const signature = `/api/v2${path}${nonce}${bodyStr}`;
    const sig = crypto
        .createHmac('sha384', apiSecret)
        .update(signature)
        .digest('hex');

    return {
        headers: {
            'Content-Type': 'application/json',
            'bfx-nonce': nonce,
            'bfx-apikey': apiKey,
            'bfx-signature': sig,
        },
        bodyStr,
    };
}

/**
 * 發送認證請求
 */
async function authRequest(path, body = {}, credentials = null) {
    const metrics = require('../metrics');
    const start = Date.now();
    const apiKey = credentials?.apiKey || config.bitfinex.apiKey;
    const apiSecret = credentials?.apiSecret || config.bitfinex.apiSecret;
    if (!apiKey || !apiSecret) {
        const error = new Error('Bitfinex API key or secret is not configured.');
        error.code = 'BITFINEX_CREDENTIALS_MISSING';
        throw error;
    }

    // Bitfinex requires nonces to arrive in strictly increasing order for each
    // API key. Serialize the full request/response, not just nonce generation,
    // because concurrent HTTP requests can reach Bitfinex out of order.
    const queueKey = crypto.createHash('sha256').update(apiKey).digest('hex');
    const previousRequest = privateRequestQueues.get(queueKey) || Promise.resolve();
    let releaseRequest;
    const queuedRequest = new Promise(resolve => { releaseRequest = resolve; });
    privateRequestQueues.set(queueKey, queuedRequest);
    await previousRequest;

    try {
        const { headers, bodyStr } = createAuthHeaders(path, body, { apiKey, apiSecret });
        const response = await fetch(`${BASE_URL}${path}`, {
            method: 'POST',
            headers,
            body: bodyStr,
        });

        const duration = (Date.now() - start) / 1000;
        metrics.recordApiRequest('POST', path, response.status.toString(), duration);

        if (!response.ok) {
            const text = await response.text();
            metrics.recordApiError('POST', path, `HTTP_${response.status}`);
            const error = new Error(`Bitfinex API 錯誤 (${response.status}): ${text}`);
            error.responseStatus = response.status;
            throw error;
        }

        return response.json();
    } catch (err) {
        if (!err.message.includes('Bitfinex API 錯誤')) {
            const duration = (Date.now() - start) / 1000;
            metrics.recordApiRequest('POST', path, 'error', duration);
            metrics.recordApiError('POST', path, err.name || 'NetworkError');
        }
        throw err;
    } finally {
        releaseRequest();
        if (privateRequestQueues.get(queueKey) === queuedRequest) {
            privateRequestQueues.delete(queueKey);
        }
    }
}

async function submitNonIdempotentWrite(operation, path, body, credentials) {
    try {
        return await authRequest(path, body, credentials);
    } catch (cause) {
        const status = Number(cause?.responseStatus);
        const explicitlyRejected = Number.isInteger(status) && status >= 400 && status < 500;
        if (cause?.code === 'BITFINEX_CREDENTIALS_MISSING' || explicitlyRejected) throw cause;

        const detail = cause?.message ? ` (${cause.message})` : '';
        const error = new Error(`${operation} 結果不明${detail}；請先查詢 Bitfinex 狀態，再決定是否重新提交。`);
        error.code = 'BITFINEX_WRITE_RESULT_UNKNOWN';
        error.cause = cause;
        throw error;
    }
}

/**
 * 發送公開請求
 */
async function publicRequest(path) {
    const metrics = require('../metrics');
    const start = Date.now();
    try {
        const response = await fetch(`${BASE_URL}${path}`);
        const duration = (Date.now() - start) / 1000;
        metrics.recordApiRequest('GET', path, response.status.toString(), duration);

        if (!response.ok) {
            const text = await response.text();
            metrics.recordApiError('GET', path, `HTTP_${response.status}`);
            throw new Error(`Bitfinex API 公開端點錯誤 (${response.status}): ${text}`);
        }
        return response.json();
    } catch (err) {
        if (!err.message.includes('Bitfinex API 公開端點錯誤')) {
            const duration = (Date.now() - start) / 1000;
            metrics.recordApiRequest('GET', path, 'error', duration);
            metrics.recordApiError('GET', path, err.name || 'NetworkError');
        }
        throw err;
    }
}

// ============== Funding 操作 ==============

/**
 * 提交 Funding Offer
 * @param {string} currency - USD
 * @param {number} amount - 金額
 * @param {number} rate - 日利率（例如 0.001 = 0.1%/天）
 * @param {number} period - 天數 (2-120)
 * @param {object} credentials - 可選用戶金鑰 { apiKey, apiSecret }
 */
async function submitFundingOffer(currency, amount, rate, period, credentials = null) {
    const bfxSym = toBfxSymbol(currency);
    // A transport/response error cannot prove Bitfinex did not accept this create operation.
    return submitNonIdempotentWrite('Funding Offer', '/auth/w/funding/offer/submit', {
        type: 'LIMIT',
        symbol: `f${bfxSym}`,
        amount: amount.toString(),
        rate: rate.toString(),
        period,
        flags: 0,
    }, credentials);
}

/**
 * 取消 Funding Offer
 * @param {number} offerId - 掛單 ID
 * @param {object} credentials - 可選用戶金鑰
 */
async function cancelFundingOffer(offerId, credentials = null) {
    return withRetry(
        () => authRequest('/auth/w/funding/offer/cancel', { id: offerId }, credentials),
        { label: `取消 Funding Offer #${offerId}` }
    );
}

/**
 * 取消所有指定幣種的 Funding Offers
 * @param {string} currency - USD
 * @param {object} credentials - 可選用戶金鑰
 */
async function cancelAllFundingOffers(currency, credentials = null) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest('/auth/w/funding/offer/cancel/all', {
            currency: `f${bfxSym}`,
        }, credentials),
        { label: `取消所有 ${currency} Funding Offers` }
    );
}

// ============== 查詢 ==============

/**
 * 取得活躍的 Funding Offers
 * @param {string} currency - USD
 * @param {object} credentials - 可選用戶金鑰
 */
async function getActiveFundingOffers(currency, credentials = null) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest(`/auth/r/funding/offers/f${bfxSym}`, {}, credentials),
        { label: `查詢活躍 Funding Offers (${currency})` }
    );
}

/**
 * 取得活躍的 Funding Credits（已成交放貸）
 * @param {string} currency - USD
 * @param {object} credentials - 可選用戶金鑰
 */
async function getActiveFundingCredits(currency, credentials = null) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest(`/auth/r/funding/credits/f${bfxSym}`, {}, credentials),
        { label: `查詢活躍 Funding Credits (${currency})` }
    );
}

/**
 * 取得 Funding Loans
 * @param {string} currency - USD
 * @param {object} credentials - 可選用戶金鑰
 */
async function getActiveFundingLoans(currency, credentials = null) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest(`/auth/r/funding/loans/f${bfxSym}`, {}, credentials),
        { label: `查詢活躍 Funding Loans (${currency})` }
    );
}

/**
 * 取得錢包資訊
 * @param {object} credentials - 可選用戶金鑰
 */
async function getWallets(credentials = null) {
    return withRetry(
        () => authRequest('/auth/r/wallets', {}, credentials),
        { label: '查詢錢包資訊' }
    );
}

/**
 * 取得 Funding Info
 * @param {string} currency - USD
 * @param {object} credentials - 可選用戶金鑰
 */
async function getFundingInfo(currency, credentials = null) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest(`/auth/r/info/funding/f${bfxSym}`, {}, credentials),
        { label: `查詢 Funding Info (${currency})` }
    );
}

// ============== 錢包轉帳 ==============

/**
 * 錢包間轉帳
 * @param {string} from - 來源錢包 ('exchange', 'margin', 'funding')
 * @param {string} to - 目標錢包
 * @param {string} currency - 幣種
 * @param {number} amount - 金額
 * @param {object} credentials - 可選用戶金鑰
 */
async function transfer(from, to, currency, amount, credentials = null) {
    // Wallet movement is not retried automatically when the remote result is ambiguous.
    return submitNonIdempotentWrite('錢包轉帳', '/auth/w/transfer', {
        from,
        to,
        currency,
        currency_to: currency,
        amount: amount.toString(),
    }, credentials);
}

// ============== 公開資料 ==============

/**
 * 取得 Funding Ticker（含 FRR）
 */
async function getFundingTicker(currency) {
    const bfxSym = toBfxSymbol(currency);
    return publicRequest(`/ticker/f${bfxSym}`);
}

/**
 * 取得 Funding 統計
 */
async function getFundingStats(currency) {
    const bfxSym = toBfxSymbol(currency);
    return publicRequest(`/funding/stats/f${bfxSym}/hist`);
}

/**
 * 取得公開 Funding 成交紀錄
 * @param {string} currency - USD
 * @param {object} options - Bitfinex 公開 trades endpoint 的查詢參數
 */
async function getFundingTrades(currency, options = {}) {
    const bfxSym = toBfxSymbol(currency);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const query = params.toString();
    return publicRequest(`/trades/f${bfxSym}/hist${query ? `?${query}` : ''}`);
}

/** Read the authenticated account's funding trades; retain only stable fields and OFFER_ID. */
async function getUserFundingTrades(currency, options = {}, credentials = null) {
    const bfxSym = toBfxSymbol(currency);
    const body = {};
    for (const key of ['start', 'end', 'limit']) {
        const value = options[key];
        if (value !== undefined && value !== null) body[key] = value;
    }
    const rows = await authRequest(`/auth/r/funding/trades/f${bfxSym}/hist`, body, credentials);
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => Array.isArray(row) && row.length >= 7).map(row => ({
        id: Number(row[0]),
        timestamp: Number(row[2]),
        offerId: Number(row[3]),
        amount: Math.abs(Number(row[4])),
        rate: Number(row[5]),
        period: Number(row[6]),
    })).filter(row => Number.isSafeInteger(row.id) && Number.isSafeInteger(row.offerId)
        && Number.isFinite(row.timestamp) && Number.isFinite(row.amount)
        && Number.isFinite(row.rate) && Number.isInteger(row.period));
}

/**
 * 取得公開 Funding 成交 K 線（每小時），供缺少本機日歷史時補足圖表。
 * Bitfinex candle 格式為 [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]。
 */
async function getFundingCandles(currency, options = {}) {
    const bfxSym = toBfxSymbol(currency);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const query = params.toString();
    return publicRequest(`/candles/trade:1h:f${bfxSym}:a30:p2:p30/hist${query ? `?${query}` : ''}`);
}

/**
 * 取得 Funding Book
 */
async function getFundingBook(currency, precision = 'P0') {
    const bfxSym = toBfxSymbol(currency);
    return publicRequest(`/book/f${bfxSym}/${precision}`);
}

/**
 * 解析 Funding Offer 陣列為物件
 * Bitfinex API 回傳的是陣列格式，需要轉換
 */
function parseFundingOffer(arr) {
    if (!Array.isArray(arr)) return null;
    const currency = fromBfxSymbol(arr[1]);
    if (currency !== 'USD') return null;
    return {
        id: arr[0],
        symbol: arr[1],
        currency,
        createdAt: new Date(arr[2]),
        updatedAt: new Date(arr[3]),
        amount: arr[4],
        amountOrig: arr[5],
        type: arr[6],
        flags: arr[9],
        status: arr[10],
        rate: arr[14],
        period: arr[15],
        notify: arr[16],
        hidden: arr[17],
        renew: arr[19],
    };
}

/**
 * 解析 Funding Credit 陣列為物件
 */
function parseFundingCredit(arr) {
    if (!Array.isArray(arr)) return null;
    const currency = fromBfxSymbol(arr[1]);
    if (currency !== 'USD') return null;
    return {
        id: arr[0],
        symbol: arr[1],
        currency,
        side: arr[2],
        createdAt: new Date(arr[3]),
        updatedAt: new Date(arr[4]),
        amount: arr[5],
        flags: arr[6],
        status: arr[7],
        rate: arr[11],
        period: arr[12],
        openedAt: new Date(arr[13]),
        lastPayout: arr[14] ? new Date(arr[14]) : null,
        notify: arr[15],
        hidden: arr[16],
        renew: arr[18],
        noClose: arr[20],
        positionPair: arr[21],
    };
}

/**
 * 解析 Wallet 陣列為物件
 */
function parseWallet(arr) {
    if (!Array.isArray(arr)) return null;
    const rawCurrency = arr[1];
    const currency = fromBfxSymbol(rawCurrency);
    if (currency !== 'USD') return null;
    return {
        type: arr[0],       // 'exchange', 'margin', 'funding'
        currency,
        rawCurrency,        // 保留原始 Bitfinex 代碼
        balance: arr[2],
        unsettledInterest: arr[3],
        available: arr[4],
    };
}

module.exports = {
    authRequest,
    submitFundingOffer,
    cancelFundingOffer,
    cancelAllFundingOffers,
    getActiveFundingOffers,
    getActiveFundingCredits,
    getActiveFundingLoans,
    getWallets,
    getFundingInfo,
    transfer,
    getFundingTicker,
    getFundingStats,
    getFundingTrades,
    getUserFundingTrades,
    getFundingCandles,
    getFundingBook,
    parseFundingOffer,
    parseFundingCredit,
    parseWallet,
};
