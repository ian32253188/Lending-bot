const { getBitfinexPublicWS } = require('./bitfinex/ws');

const baseStatus = {
    running: false,
    paused: false,
    pauseReason: '',
    monitorOnly: false,
    compounding: false,
    autoTransfer: false,
    autoTransferThreshold: 500,
    strategyMode: 'balanced',
    connected: false,
    authenticated: false,
    accountDataAvailable: false,
    stats: { offersPlaced: 0, offersCancelled: 0, totalEarned: { USD: 0, USDT: 0 }, lastUpdate: null },
    wallets: { USD: { balance: null, available: null }, USDT: { balance: null, available: null } },
    activeOffers: { USD: null, USDT: null },
    activeCredits: { USD: null, USDT: null },
    strategy: { mode: 'balanced', config: {} },
};

function getInactiveDashboardStatus() {
    const publicWs = getBitfinexPublicWS();
    if (!publicWs.isConnected()) publicWs.connect();
    return {
        ...baseStatus,
        marketData: publicWs.marketData,
        publicMarketConnected: Boolean(publicWs.isConnected()),
    };
}

async function getInactiveDashboardStatusForUser(userId, { detailed = false } = {}) {
    const status = getInactiveDashboardStatus();
    const { getReadOnlyAccountSnapshot } = require('./private-account-status');
    const account = await getReadOnlyAccountSnapshot(userId);
    const result = { ...status, ...account };

    if (account.accountDataAvailable && !detailed) {
        result.activeOffers = Object.fromEntries(
            Object.entries(account.activeOffers).map(([currency, rows]) => [currency, rows.length]),
        );
        result.activeCredits = Object.fromEntries(
            Object.entries(account.activeCredits).map(([currency, rows]) => [currency, rows.length]),
        );
    }
    return result;
}

module.exports = { getInactiveDashboardStatus, getInactiveDashboardStatusForUser };
