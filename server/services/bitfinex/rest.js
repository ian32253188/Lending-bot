const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../utils/logger');
const { withRetry } = require('../../utils/retry');

const BASE_URL = config.bitfinex.restUrl;

/**
 * 內部幣種代碼 → Bitfinex Funding symbol
 * 例如: 'USDT' → 'UST'
 */
function toBfxSymbol(currency) {
    return config.lending.currencyMap?.[currency] || currency;
}

/**
 * Bitfinex Funding symbol → 內部幣種代碼
 * 例如: 'UST' → 'USDT', 'fUST' → 'USDT'
 */
function fromBfxSymbol(bfxSymbol) {
    const sym = bfxSymbol?.startsWith('f') ? bfxSymbol.slice(1) : bfxSymbol;
    return config.lending.symbolToCurrency?.[sym] || sym;
}

/**
 * 建立已認證的 API 請求
 */
function createAuthHeaders(path, body = {}) {
    const nonce = (Date.now() * 1000).toString();
    const bodyStr = JSON.stringify(body);
    const signature = `/api/v2${path}${nonce}${bodyStr}`;
    const sig = crypto
        .createHmac('sha384', config.bitfinex.apiSecret)
        .update(signature)
        .digest('hex');

    return {
        'Content-Type': 'application/json',
        'bfx-nonce': nonce,
        'bfx-apikey': config.bitfinex.apiKey,
        'bfx-signature': sig,
    };
}

/**
 * 發送認證請求
 */
async function authRequest(path, body = {}) {
    const headers = createAuthHeaders(path, body);
    const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Bitfinex API 錯誤 (${response.status}): ${text}`);
    }

    return response.json();
}

/**
 * 發送公開請求
 */
async function publicRequest(path) {
    const response = await fetch(`${BASE_URL}${path}`);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Bitfinex API 公開端點錯誤 (${response.status}): ${text}`);
    }
    return response.json();
}

// ============== Funding 操作 ==============

/**
 * 提交 Funding Offer
 * @param {string} currency - 'USD' 或 'USDT'
 * @param {number} amount - 金額
 * @param {number} rate - 日利率（例如 0.001 = 0.1%/天）
 * @param {number} period - 天數 (2-120)
 */
async function submitFundingOffer(currency, amount, rate, period) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest('/auth/w/funding/offer/submit', {
            type: 'LIMIT',
            symbol: `f${bfxSym}`,
            amount: amount.toString(),
            rate: rate.toString(),
            period,
            flags: 0,
        }),
        { label: `提交 Funding Offer (${currency} ${amount} @ ${(rate * 100).toFixed(4)}%)` }
    );
}

/**
 * 取消 Funding Offer
 * @param {number} offerId - 掛單 ID
 */
async function cancelFundingOffer(offerId) {
    return withRetry(
        () => authRequest('/auth/w/funding/offer/cancel', { id: offerId }),
        { label: `取消 Funding Offer #${offerId}` }
    );
}

/**
 * 取消所有指定幣種的 Funding Offers
 * @param {string} currency - 'USD' 或 'USDT'
 */
async function cancelAllFundingOffers(currency) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest('/auth/w/funding/offer/cancel/all', {
            currency: `f${bfxSym}`,
        }),
        { label: `取消所有 ${currency} Funding Offers` }
    );
}

// ============== 查詢 ==============

/**
 * 取得活躍的 Funding Offers
 */
async function getActiveFundingOffers(currency) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest(`/auth/r/funding/offers/f${bfxSym}`),
        { label: `查詢活躍 Funding Offers (${currency})` }
    );
}

/**
 * 取得活躍的 Funding Credits（已成交放貸）
 */
async function getActiveFundingCredits(currency) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest(`/auth/r/funding/credits/f${bfxSym}`),
        { label: `查詢活躍 Funding Credits (${currency})` }
    );
}

/**
 * 取得 Funding Loans
 */
async function getActiveFundingLoans(currency) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest(`/auth/r/funding/loans/f${bfxSym}`),
        { label: `查詢活躍 Funding Loans (${currency})` }
    );
}

/**
 * 取得錢包資訊
 */
async function getWallets() {
    return withRetry(
        () => authRequest('/auth/r/wallets'),
        { label: '查詢錢包資訊' }
    );
}

/**
 * 取得 Funding Info
 */
async function getFundingInfo(currency) {
    const bfxSym = toBfxSymbol(currency);
    return withRetry(
        () => authRequest(`/auth/r/info/funding/f${bfxSym}`),
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
 */
async function transfer(from, to, currency, amount) {
    return withRetry(
        () => authRequest('/auth/w/transfer', {
            from,
            to,
            currency,
            currency_to: currency,
            amount: amount.toString(),
        }),
        { label: `轉帳 ${amount} ${currency} (${from} → ${to})` }
    );
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
    return {
        id: arr[0],
        symbol: arr[1],
        currency: fromBfxSymbol(arr[1]),  // fUST → USDT
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
    return {
        id: arr[0],
        symbol: arr[1],
        currency: fromBfxSymbol(arr[1]),  // fUST → USDT
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
    return {
        type: arr[0],       // 'exchange', 'margin', 'funding'
        currency: fromBfxSymbol(rawCurrency),  // UST → USDT
        rawCurrency,        // 保留原始 Bitfinex 代碼
        balance: arr[2],
        unsettledInterest: arr[3],
        available: arr[4],
    };
}

module.exports = {
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
    getFundingBook,
    parseFundingOffer,
    parseFundingCredit,
    parseWallet,
};
