const config = require('../config');
const logger = require('../utils/logger');
const { decryptWithFallback } = require('../utils/crypto');
const db = require('./database');
const rest = require('./bitfinex/rest');

const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';
const SNAPSHOT_TTL_MS = 30 * 1000;
const ERROR_CACHE_TTL_MS = 5 * 1000;
const snapshotCache = new Map();
const inFlightSnapshots = new Map();

function unavailableSnapshot(error, errorCode = null) {
    return {
        accountDataAvailable: false,
        accountDataComplete: false,
        accountDataSource: 'Bitfinex private REST API',
        accountDataUpdatedAt: null,
        accountDataError: error,
        accountDataErrorCode: errorCode,
        wallets: {
            USD: { balance: null, available: null },
        },
        activeOffers: { USD: null },
        activeCredits: { USD: null },
    };
}

function classifyPrivateApiError(error) {
    const message = String(error?.message || error || '');
    if (error?.code === 'CREDENTIAL_DECRYPTION_FAILED') {
        return {
            code: 'BITFINEX_CREDENTIAL_DECRYPTION_FAILED',
            status: null,
            message: '無法解密已儲存的 Bitfinex API 憑證；請在網站設定重新輸入並儲存 API Key 與 Secret。',
        };
    }
    const responseMatch = message.match(/Bitfinex API 錯誤 \((\d{3})\):\s*([\s\S]*)/);
    const status = responseMatch ? Number(responseMatch[1]) : null;
    const responseBody = responseMatch?.[2] || '';
    let bitfinexCode = null;
    let bitfinexMessage = responseBody;
    try {
        const payload = JSON.parse(responseBody);
        if (Array.isArray(payload) && payload[0] === 'error') {
            bitfinexCode = Number(payload[1]);
            bitfinexMessage = String(payload[2] || '');
        }
    } catch {}

    if (bitfinexCode === 10100 || /digest invalid/i.test(bitfinexMessage)) {
        return {
            code: 'BITFINEX_SIGNATURE_INVALID',
            status,
            message: 'Bitfinex 拒絕 API 簽章；請核對 API Key 與 Secret 是否配對且仍有效。',
        };
    }
    if (bitfinexCode === 10114 || /nonce:\s*(small|too small)/i.test(bitfinexMessage)) {
        return {
            code: 'BITFINEX_NONCE_OUT_OF_ORDER',
            status,
            message: 'Bitfinex 私有 API 請求順序衝突；系統會序列化請求，請稍後重新整理。',
        };
    }
    if (/permission|access denied|not authorized|invalid scope/i.test(bitfinexMessage)) {
        return {
            code: 'BITFINEX_READ_PERMISSION_DENIED',
            status,
            message: 'Bitfinex API 權限不足；需要 Wallet Read 與 Funding Read 權限。',
        };
    }
    if (/ENOTFOUND|ECONN|ETIMEDOUT|timeout|fetch failed/i.test(message)) {
        return {
            code: 'BITFINEX_NETWORK_ERROR',
            status,
            message: '目前無法連線至 Bitfinex 私有 API，請稍後重試。',
        };
    }
    if (status !== null) {
        return {
            code: `BITFINEX_HTTP_${status}`,
            status,
            message: `Bitfinex 私有 API 回應 HTTP ${status}；請確認金鑰與讀取權限。`,
        };
    }
    return {
        code: 'BITFINEX_PRIVATE_API_ERROR',
        status: null,
        message: 'Bitfinex 私有 API 讀取失敗；請確認 API 金鑰與讀取權限。',
    };
}

function resolveCredentials(settings, userId) {
    if (settings?.bitfinex_api_key && settings?.bitfinex_api_secret) {
        return {
            apiKey: decryptWithFallback(settings.bitfinex_api_key),
            apiSecret: decryptWithFallback(settings.bitfinex_api_secret),
        };
    }

    // The local admin login is the only account allowed to use the legacy
    // server-level Bitfinex credentials when no per-user keys were saved.
    if (userId === ADMIN_USER_ID && config.bitfinex?.apiKey && config.bitfinex?.apiSecret) {
        return { apiKey: config.bitfinex.apiKey, apiSecret: config.bitfinex.apiSecret };
    }
    return null;
}

function toArray(value, label) {
    if (!Array.isArray(value)) throw new Error(`Invalid ${label} response`);
    return value;
}

async function fetchAccountSnapshot(userId) {
    try {
        const settings = await db.getUserSettings(userId);
        const credentials = resolveCredentials(settings, userId);
        if (!credentials) {
            return unavailableSnapshot('尚未設定可讀取 Bitfinex 帳戶的 API 金鑰。', 'BITFINEX_CREDENTIALS_MISSING');
        }

        const rawWallets = await rest.getWallets(credentials);
        const currencyResults = [];
        for (const currency of ['USD']) {
            const rawOffers = await rest.getActiveFundingOffers(currency, credentials);
            const rawCredits = await rest.getActiveFundingCredits(currency, credentials);
            const rawLoans = await rest.getActiveFundingLoans(currency, credentials);
            currencyResults.push({ currency, rawOffers, rawCredits, rawLoans });
        }

        const wallets = {
            USD: { balance: 0, available: 0 },
        };
        for (const row of toArray(rawWallets, 'wallet')) {
            const wallet = rest.parseWallet(row);
            if (wallet?.type !== 'funding' || !wallets[wallet.currency]) continue;
            wallets[wallet.currency] = {
                balance: Number(wallet.balance),
                available: Number(wallet.available),
            };
        }

        const activeOffers = { USD: [] };
        const activeCredits = { USD: [] };
        for (const result of currencyResults) {
            const { currency } = result;
            activeOffers[currency] = toArray(result.rawOffers, `${currency} offers`)
                .map(rest.parseFundingOffer)
                .filter(Boolean);

            // Bitfinex splits the lender's funding into credits used in active
            // positions and loans not currently used in positions. Keep both
            // read-only sources in the app's existing "lending" total.
            const records = [
                ...toArray(result.rawCredits, `${currency} credits`),
                ...toArray(result.rawLoans, `${currency} loans`),
            ].map(rest.parseFundingCredit).filter(record => record?.side === 1);
            const byId = new Map(records.map(record => [String(record.id), record]));
            activeCredits[currency] = [...byId.values()];
        }

        return {
            accountDataAvailable: true,
            accountDataComplete: true,
            accountDataSource: 'Bitfinex private REST API',
            accountDataUpdatedAt: new Date().toISOString(),
            accountDataError: null,
            accountDataErrorCode: null,
            accountDataStale: false,
            wallets,
            activeOffers,
            activeCredits,
        };
    } catch (error) {
        const diagnostic = classifyPrivateApiError(error);
        logger.warn('dashboard', '唯讀同步 Bitfinex 私有帳戶資料失敗', {
            userId,
            errorCode: diagnostic.code,
            httpStatus: diagnostic.status,
        });
        return unavailableSnapshot(diagnostic.message, diagnostic.code);
    }
}

async function getReadOnlyAccountSnapshot(userId, now = Date.now()) {
    if (!userId) return unavailableSnapshot('找不到帳戶 ID。');

    const cached = snapshotCache.get(userId);
    if (cached && now - cached.cachedAt < cached.ttl) return cached.snapshot;

    const inFlight = inFlightSnapshots.get(userId);
    if (inFlight) return inFlight;

    const previousSnapshot = cached?.snapshot;
    const request = fetchAccountSnapshot(userId).then(freshSnapshot => {
        const snapshot = !freshSnapshot.accountDataAvailable
            && freshSnapshot.accountDataErrorCode !== 'BITFINEX_CREDENTIALS_MISSING'
            && previousSnapshot?.accountDataAvailable
            ? {
                ...previousSnapshot,
                accountDataStale: true,
                accountDataError: freshSnapshot.accountDataError,
                accountDataErrorCode: freshSnapshot.accountDataErrorCode,
            }
            : freshSnapshot;
        snapshotCache.set(userId, {
            snapshot,
            cachedAt: Date.now(),
            ttl: snapshot.accountDataAvailable && !snapshot.accountDataStale
                ? SNAPSHOT_TTL_MS
                : ERROR_CACHE_TTL_MS,
        });
        return snapshot;
    }).finally(() => {
        inFlightSnapshots.delete(userId);
    });
    inFlightSnapshots.set(userId, request);
    return request;
}

function clearReadOnlyAccountSnapshotCache() {
    snapshotCache.clear();
    inFlightSnapshots.clear();
}

module.exports = { getReadOnlyAccountSnapshot, clearReadOnlyAccountSnapshotCache, classifyPrivateApiError };
