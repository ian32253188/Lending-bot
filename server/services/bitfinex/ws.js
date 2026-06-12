const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('../../config');
const logger = require('../../utils/logger');
const EventEmitter = require('events');

// 單例快取
let publicInstance = null;
let legacyInstance = null;

class BitfinexWS extends EventEmitter {
    constructor(options = {}) {
        super();
        this.credentials = options.credentials || null; // { apiKey, apiSecret }
        this.publicOnly = options.publicOnly || false;

        this.ws = null;
        this.authenticated = false;
        this.channelMap = {}; // chanId -> { channel, symbol, ... }
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 2000;
        this.heartbeatTimeout = null;
        this.pingInterval = null;
        this._closing = false;
        this.reconnectTimer = null; // 重連計時器

        // 即時市場資料快取
        this.marketData = {
            USD: { frr: 0, bids: [], asks: [], lastUpdate: null },
            USDT: { frr: 0, bids: [], asks: [], lastUpdate: null },
        };
    }

    /**
     * 內部幣種代碼 → Bitfinex Funding symbol
     * 例如: 'USDT' → 'UST'
     */
    _toBfxSymbol(currency) {
        return config.lending.currencyMap?.[currency] || currency;
    }

    /**
     * Bitfinex Funding symbol → 內部幣種代碼
     * 例如: 'UST' → 'USDT'
     */
    _fromBfxSymbol(bfxSymbol) {
        return config.lending.symbolToCurrency?.[bfxSymbol] || bfxSymbol;
    }

    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this._cleanupSocket();
        this._closing = false;
        logger.info('bitfinex-ws', '正在連接 Bitfinex WebSocket...');

        this.ws = new WebSocket(config.bitfinex.wsUrl);

        this.ws.on('open', () => {
            logger.info('bitfinex-ws', `✅ WebSocket 已連接 (Public: ${this.publicOnly})`);
            this.reconnectAttempts = 0;
            this.channelMap = {}; // 重連後清除舊的頻道映射，避免資訊混亂
            if (!this.publicOnly) {
                this._authenticate();
            } else {
                this._subscribeFundingBooks();
            }
            this._startHeartbeat();
        });

        this.ws.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                this._handleMessage(data);
            } catch (err) {
                logger.error('bitfinex-ws', '解析訊息失敗', { error: err.message });
            }
        });

        this.ws.on('close', (code, reason) => {
            logger.warn('bitfinex-ws', `WebSocket 已斷開 (code: ${code})`, { reason: reason?.toString() });
            this.authenticated = false;
            this._stopHeartbeat();
            if (!this._closing) {
                this._reconnect();
            }
        });

        this.ws.on('error', (err) => {
            logger.error('bitfinex-ws', 'WebSocket 錯誤', { error: err.message });
        });
    }

    _cleanupSocket() {
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch (err) {
                // ignore
            }
            this.ws = null;
        }
    }

    disconnect() {
        this._closing = true;
        this._stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this._cleanupSocket();
        this.authenticated = false;

        // 手動斷開時重置單例
        if (this === publicInstance) {
            publicInstance = null;
        }
        if (this === legacyInstance) {
            legacyInstance = null;
        }

        logger.info('bitfinex-ws', 'WebSocket 已手動關閉');
    }

    _authenticate() {
        const apiKey = this.credentials?.apiKey || config.bitfinex.apiKey;
        const apiSecret = this.credentials?.apiSecret || config.bitfinex.apiSecret;
        if (!apiKey || !apiSecret) {
            logger.warn('bitfinex-ws', 'API Key 未設定，跳過認證');
            return;
        }

        const nonce = Date.now().toString();
        const payload = `AUTH${nonce}`;
        const sig = crypto
            .createHmac('sha384', apiSecret)
            .update(payload)
            .digest('hex');

        this._send({
            apiKey,
            authSig: sig,
            authNonce: nonce,
            authPayload: payload,
            event: 'auth',
            filter: ['funding', 'wallet'],
        });
    }

    _subscribeFundingBooks() {
        for (const currency of config.lending.currencies) {
            const bfxSym = this._toBfxSymbol(currency);
            // 訂閱 Funding Book（IBRR 需要更深的訂單簿）
            this._send({
                event: 'subscribe',
                channel: 'book',
                symbol: `f${bfxSym}`,
                prec: 'P0',
                len: '100',
            });

            // 訂閱 Funding Ticker (含 FRR)
            this._send({
                event: 'subscribe',
                channel: 'ticker',
                symbol: `f${bfxSym}`,
            });
        }
    }

    _handleMessage(data) {
        // 事件訊息
        if (data.event) {
            this._handleEvent(data);
            return;
        }

        // 頻道資料
        if (Array.isArray(data)) {
            const chanId = data[0];

            // 心跳
            if (data[1] === 'hb') {
                this._resetHeartbeat();
                return;
            }

            // 認證頻道 (chanId === 0)
            if (chanId === 0) {
                this._handleAuthData(data);
                return;
            }

            // 一般頻道
            const channelInfo = this.channelMap[chanId];
            if (channelInfo) {
                this._handleChannelData(channelInfo, data);
            }
        }
    }

    _handleEvent(data) {
        switch (data.event) {
            case 'auth':
                if (data.status === 'OK') {
                    this.authenticated = true;
                    logger.info('bitfinex-ws', '✅ 認證成功');
                    this.emit('authenticated');
                } else {
                    logger.error('bitfinex-ws', '❌ 認證失敗', { msg: data.msg });
                    this.emit('authError', data);
                }
                break;

            case 'subscribed':
                this.channelMap[data.chanId] = {
                    channel: data.channel,
                    symbol: data.symbol,
                };
                logger.info('bitfinex-ws', `已訂閱 ${data.channel}:${data.symbol} (chanId: ${data.chanId})`);
                break;

            case 'info':
                if (data.code === 20051) {
                    // 伺服器重啟
                    logger.warn('bitfinex-ws', '⚠️ 伺服器發送重啟訊號，重新連接中...');
                    this._reconnect();
                } else if (data.code === 20060) {
                    // 進入維護模式
                    logger.warn('bitfinex-ws', '⚠️ Bitfinex 進入維護模式，暫停交易');
                    this.emit('maintenance', true);
                } else if (data.code === 20061) {
                    // 維護結束
                    logger.info('bitfinex-ws', '✅ Bitfinex 維護結束，恢復正常');
                    this.emit('maintenance', false);
                }
                break;

            case 'error':
                logger.error('bitfinex-ws', `錯誤: ${data.msg}`, { code: data.code });
                break;
        }
    }

    _handleAuthData(data) {
        const type = data[1];
        const payload = data[2];

        switch (type) {
            case 'fos': // Funding Offer Snapshot
                this.emit('fundingOfferSnapshot', payload);
                break;
            case 'fon': // Funding Offer New
                this.emit('fundingOfferNew', payload);
                break;
            case 'fou': // Funding Offer Update
                this.emit('fundingOfferUpdate', payload);
                break;
            case 'foc': // Funding Offer Cancel
                this.emit('fundingOfferCancel', payload);
                break;
            case 'fcs': // Funding Credit Snapshot
                this.emit('fundingCreditSnapshot', payload);
                break;
            case 'fcn': // Funding Credit New
                this.emit('fundingCreditNew', payload);
                break;
            case 'fcu': // Funding Credit Update
                this.emit('fundingCreditUpdate', payload);
                break;
            case 'fcc': // Funding Credit Close
                this.emit('fundingCreditClose', payload);
                break;
            case 'fls': // Funding Loan Snapshot
                this.emit('fundingLoanSnapshot', payload);
                break;
            case 'fln': // Funding Loan New
                this.emit('fundingLoanNew', payload);
                break;
            case 'flu': // Funding Loan Update
                this.emit('fundingLoanUpdate', payload);
                break;
            case 'flc': // Funding Loan Close
                this.emit('fundingLoanClose', payload);
                break;
            case 'ws': // Wallet Snapshot
                this.emit('walletSnapshot', payload);
                break;
            case 'wu': // Wallet Update
                this.emit('walletUpdate', payload);
                break;
            case 'n': // Notification
                this.emit('notification', payload);
                break;
        }
    }

    _handleChannelData(channelInfo, data) {
        const { channel, symbol } = channelInfo;
        const bfxSymbol = symbol.replace('f', '');
        const currency = this._fromBfxSymbol(bfxSymbol);  // UST → USDT
        const payload = data[1];

        if (channel === 'ticker') {
            // Bitfinex Funding Ticker 官方欄位順序 (API v2):
            // [FRR, BID, BID_SIZE, BID_PERIOD, ASK, ASK_SIZE, ASK_PERIOD,
            //  DAILY_CHANGE, DAILY_CHANGE_RELATIVE, LAST_PRICE, VOLUME, HIGH, LOW,
            //  _PLACEHOLDER, _PLACEHOLDER, FRR_AMOUNT_AVAILABLE]
            if (Array.isArray(payload) && payload.length >= 16) {
                this.marketData[currency] = {
                    ...this.marketData[currency],
                    frr: payload[0],
                    bid: payload[1],
                    bidSize: payload[2],
                    bidPeriod: payload[3],
                    ask: payload[4],
                    askSize: payload[5],
                    askPeriod: payload[6],
                    dailyChange: payload[7],
                    dailyChangePerc: payload[8],
                    lastPrice: payload[9],
                    volume: payload[10],
                    high: payload[11],
                    low: payload[12],
                    frrAmountAvailable: payload[15],
                    lastUpdate: Date.now(),
                };
                this.emit('tickerUpdate', { currency, data: this.marketData[currency] });
            }
        }

        if (channel === 'book') {
            // Funding Book Update
            if (Array.isArray(payload)) {
                if (Array.isArray(payload[0])) {
                    // Snapshot: array of arrays
                    const bids = [];
                    const asks = [];
                    for (const entry of payload) {
                        const [rate, period, count, amount] = entry;
                        if (amount > 0) {
                            bids.push({ rate, period, count, amount });
                        } else {
                            asks.push({ rate, period, count, amount: Math.abs(amount) });
                        }
                    }
                    this.marketData[currency] = {
                        ...this.marketData[currency],
                        bids,
                        asks,
                        lastUpdate: Date.now(),
                    };
                    this.emit('bookSnapshot', { currency, bids, asks });
                } else {
                    // Single update
                    const [rate, period, count, amount] = payload;
                    this.emit('bookUpdate', { currency, rate, period, count, amount });
                    // 更新本地快取
                    this._updateBookCache(currency, { rate, period, count, amount });
                }
            }
        }
    }

    _updateBookCache(currency, update) {
        const { rate, count, amount } = update;
        const md = this.marketData[currency];
        if (!md) return;

        const side = amount > 0 ? 'bids' : 'asks';
        const absAmount = Math.abs(amount);

        if (count === 0) {
            // 移除
            md[side] = md[side].filter((e) => e.rate !== rate);
        } else {
            const existing = md[side].findIndex((e) => e.rate === rate);
            if (existing >= 0) {
                md[side][existing] = { ...md[side][existing], count, amount: absAmount };
            } else {
                md[side].push({ rate, period: update.period, count, amount: absAmount });
            }
        }

        // 排序
        md.bids.sort((a, b) => b.rate - a.rate);
        md.asks.sort((a, b) => a.rate - b.rate);
        md.lastUpdate = Date.now();
    }

    _reconnect() {
        if (this._closing) return;
        if (this.reconnectTimer) return; // 避免重複重連

        this.reconnectAttempts++;
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            logger.error('bitfinex-ws', `已達最大重連次數 (${this.maxReconnectAttempts})，停止重連`);
            this.emit('reconnectFailed');
            return;
        }

        const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        logger.info('bitfinex-ws', `${Math.round(delay / 1000)}s 後嘗試第 ${this.reconnectAttempts} 次重連...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this._closing) {
                this.connect();
            }
        }, delay);
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 15000);

        this._resetHeartbeat();
    }

    _resetHeartbeat() {
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = setTimeout(() => {
            logger.warn('bitfinex-ws', '心跳超時，重新連線');
            if (this.ws) this.ws.close();
        }, 45000);
    }

    _stopHeartbeat() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
        }
    }

    _send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    getMarketData(currency) {
        return this.marketData[currency] || null;
    }

    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    isAuthenticated() {
        return this.authenticated;
    }
}

// 單例模式 (共享公開行情 WebSocket)
function getBitfinexPublicWS() {
    if (!publicInstance) {
        publicInstance = new BitfinexWS({ publicOnly: true });
    }
    return publicInstance;
}

// 建立用戶私有 WebSocket
function createBitfinexPrivateWS(credentials) {
    return new BitfinexWS({ credentials, publicOnly: false });
}

// 為了向下相容單用戶模式，保留 getBitfinexWS
function getBitfinexWS() {
    if (!legacyInstance) {
        legacyInstance = new BitfinexWS();
    }
    return legacyInstance;
}

module.exports = { 
    BitfinexWS, 
    getBitfinexWS, 
    getBitfinexPublicWS, 
    createBitfinexPrivateWS 
};
