const config = require('../config');
const logger = require('../utils/logger');
const { decryptWithFallback } = require('../utils/crypto');
const db = require('./database');
const rest = require('./bitfinex/rest');

const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';
const SNAPSHOT_TTL_MS = 30 * 1000;
const ERROR_CACHE_TTL_MS = 5 * 1000;
const PRIVATE_READ_ERROR = 'Bitfinex 私有 API 讀取失敗；請確認 API 金鑰有效且具有讀取權限。';
const snapshotCache = new Map();
const inFlightSnapshots = new Map();

function unavailableSnapshot(error) {
    return {
        accountDataAvailable: false,
        accountDataSource: 'Bitfinex private REST API',
        accountDataUpdatedAt: null,
        accountDataError: error,
        wallets: {
            USD: { balance: null, available: null },
            USDT: { balance: null, available: null },
        },
        activeOffers: { USD: null, USDT: null },
        activeCredits: { USD: null, USDT: null },
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
            return unavailableSnapshot('尚未設定可讀取 Bitfinex 帳戶的 API 金鑰。');
        }

        const [rawWallets, currencyResults] = await Promise.all([
            rest.getWallets(credentials),
            Promise.all(['USD', 'USDT'].map(async currency => {
                const [rawOffers, rawCredits, rawLoans] = await Promise.all([
                    rest.getActiveFundingOffers(currency, credentials),
                    rest.getActiveFundingCredits(currency, credentials),
                    rest.getActiveFundingLoans(currency, credentials),
                ]);
                return { currency, rawOffers, rawCredits, rawLoans };
            })),
        ]);

        const wallets = {
            USD: { balance: 0, available: 0 },
            USDT: { balance: 0, available: 0 },
        };
        for (const row of toArray(rawWallets, 'wallet')) {
            const wallet = rest.parseWallet(row);
            if (wallet?.type !== 'funding' || !wallets[wallet.currency]) continue;
            wallets[wallet.currency] = {
                balance: Number(wallet.balance),
                available: Number(wallet.available),
            };
        }

        const activeOffers = { USD: [], USDT: [] };
        const activeCredits = { USD: [], USDT: [] };
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
            accountDataSource: 'Bitfinex private REST API',
            accountDataUpdatedAt: new Date().toISOString(),
            accountDataError: null,
            wallets,
            activeOffers,
            activeCredits,
        };
    } catch (error) {
        logger.warn('dashboard', '唯讀同步 Bitfinex 私有帳戶資料失敗', {
            userId,
            error: error?.message || String(error),
        });
        return unavailableSnapshot(PRIVATE_READ_ERROR);
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
            && freshSnapshot.accountDataError === PRIVATE_READ_ERROR
            && previousSnapshot?.accountDataAvailable
            ? {
                ...previousSnapshot,
                accountDataStale: true,
                accountDataError: freshSnapshot.accountDataError,
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

module.exports = { getReadOnlyAccountSnapshot, clearReadOnlyAccountSnapshotCache };
