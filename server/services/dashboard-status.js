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

module.exports = { getInactiveDashboardStatus };
