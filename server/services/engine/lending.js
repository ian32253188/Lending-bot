const config = require('../../config');
const logger = require('../../utils/logger');
const db = require('../database');
const rest = require('../bitfinex/rest');
const { getBitfinexPublicWS, createBitfinexPrivateWS } = require('../bitfinex/ws');
const { getStrategyEngine } = require('./strategy');

class LendingBot {
    constructor(userId, credentials, settings = {}) {
        this.userId = userId;
        this.credentials = credentials; // { apiKey, apiSecret }
        
        this.running = false;
        this.paused = false;
        this.pauseReason = '';
        this.monitorOnly = false;

        // 用戶專屬策略設定
        this.compoundingEnabled = settings.compoundingEnabled !== false;
        this.autoTransferEnabled = settings.autoTransferEnabled || false;
        this.autoTransferThreshold = settings.autoTransferThreshold || 500;
        this.minOfferAmount = settings.minOfferAmount || 150;
        this.currencies = settings.currencies || config.lending.currencies || ['USD', 'USDT'];
        this.strategyConfig = settings.strategyConfig || { mode: 'simplified' };

        // 用戶運行狀態快取
        this.state = {
            wallets: {},       // { USD: { balance, available }, USDT: {...} }
            activeOffers: {},  // { USD: [...], USDT: [...] }
            activeCredits: {}, // { USD: [...], USDT: [...] }
            lastDecision: {},  // 行情診斷快照
            stats: {
                offersPlaced: 0,
                offersCancelled: 0,
                totalEarned: {},
                lastUpdate: null,
            },
        };

        // 事件防抖與緩衝狀態
        this._pendingDecisions = {};
        this._tradeBuffer = {};

        // 初始化幣種狀態
        for (const cur of this.currencies) {
            this.state.wallets[cur] = { balance: 0, available: 0 };
            this.state.activeOffers[cur] = [];
            this.state.activeCredits[cur] = [];
            this.state.stats.totalEarned[cur] = 0;
        }

        this.bfxWs = null;
        this.decisionTimer = null;
    }

    /**
     * 啟動放貸機器人
     */
    async start() {
        if (this.running) {
            logger.warn('engine', `用戶 ${this.userId} 的放貸引擎已在運行中`);
            return;
        }

        logger.info('engine', `🚀 啟動用戶 ${this.userId} 的放貸機器人...`);
        this.running = true;

        // 確保全域公開行情 WebSocket 已連線
        const publicWs = getBitfinexPublicWS();
        publicWs.connect();

        // 建立並連線用戶私有專屬 WebSocket
        this.bfxWs = createBitfinexPrivateWS(this.credentials);
        this._setupWSListeners(this.bfxWs);
        this.bfxWs.connect();

        // 初始載入用戶個人帳戶資訊
        await this._loadInitialState();

        // 隨機交錯延遲（Jitter & Staggering）防爆 OCI 單一 IP 的流量限制
        const initialDelay = Math.random() * 5000;
        setTimeout(() => {
            if (!this.running) return;
            // 啟動定時決策週期
            this.decisionTimer = setInterval(
                () => this._decisionCycle(),
                config.lending.decisionIntervalMs || 10000
            );
            // 立即執行一次決策
            this._decisionCycle();
        }, initialDelay);

        logger.info('engine', `✅ 用戶 ${this.userId} 的放貸機器人啟動完成 (交錯延遲: ${initialDelay.toFixed(0)}ms)`);
        db.saveLog('info', 'engine', '放貸機器人啟動成功', null, this.userId);
    }

    /**
     * 停止放貸機器人
     */
    async stop() {
        if (!this.running) return;
        logger.info('engine', `⏹️ 停止用戶 ${this.userId} 的放貸機器人...`);
        this.running = false;

        if (this.decisionTimer) {
            clearInterval(this.decisionTimer);
            this.decisionTimer = null;
        }

        // 清除事件防抖 timer
        for (const timerId of Object.values(this._pendingDecisions)) {
            clearTimeout(timerId);
        }
        this._pendingDecisions = {};

        // 斷開私有 WS
        if (this.bfxWs) {
            this.bfxWs.disconnect();
            this.bfxWs = null;
        }

        logger.info('engine', `✅ 用戶 ${this.userId} 的放貸機器人已停止`);
        db.saveLog('info', 'engine', '放貸機器人已停止', null, this.userId);
    }

    pause(reason = '手動暫停') {
        this.paused = true;
        this.pauseReason = reason;
        logger.info('engine', `⏸️ 放貸已暫停: ${reason}`, this.userId);
        db.saveLog('info', 'engine', `放貸已暫停: ${reason}`, null, this.userId);
    }

    resume() {
        this.paused = false;
        this.pauseReason = '';
        logger.info('engine', '▶️ 放貸已恢復', this.userId);
        db.saveLog('info', 'engine', '放貸已恢復', null, this.userId);
    }

    /**
     * 緊急停止：取消所有掛單並暫停
     */
    async emergencyStop() {
        this.pause('緊急停止');
        for (const cur of this.currencies) {
            try {
                await rest.cancelAllFundingOffers(cur, this.credentials);
                logger.info('engine', `🚨 緊急停止: 已取消 ${cur} 所有掛單`, this.userId);
            } catch (err) {
                logger.error('engine', `緊急停止取消 ${cur} 掛單失敗`, { error: err.message, userId: this.userId });
            }
        }
    }

    setCompounding(enabled) {
        this.compoundingEnabled = enabled;
        logger.info('engine', `複利模式已${enabled ? '開啟' : '關閉'}`, this.userId);
    }

    setAutoTransfer(enabled, threshold = 500) {
        this.autoTransferEnabled = enabled;
        this.autoTransferThreshold = threshold;
        logger.info('engine', `自動轉帳已${enabled ? '開啟' : '關閉'}，門檻: ${threshold}`, this.userId);
    }

    /**
     * 防抖事件驅動決策（避免短時間內因多個事件重疊導致高頻重複掛單）
     */
    _debouncedDecision(currency, delay = 2000) {
        if (this._pendingDecisions[currency]) {
            clearTimeout(this._pendingDecisions[currency]);
        }
        this._pendingDecisions[currency] = setTimeout(() => {
            if (this.running && !this.paused) {
                this._processForCurrency(currency).catch(err => {
                    logger.error('engine', `防抖決策執行錯誤 (${currency})`, { error: err.message, userId: this.userId });
                });
            }
            delete this._pendingDecisions[currency];
        }, delay);
    }

    /**
     * 初始載入個人帳戶狀態
     */
    async _loadInitialState() {
        try {
            // 載入錢包
            const wallets = await rest.getWallets(this.credentials);
            if (Array.isArray(wallets)) {
                for (const w of wallets) {
                    const wallet = rest.parseWallet(w);
                    if (wallet && wallet.type === 'funding') {
                        const cur = wallet.currency;
                        if (this.state.wallets[cur] !== undefined) {
                            this.state.wallets[cur] = {
                                balance: wallet.balance,
                                available: wallet.available || 0,
                            };
                        }
                    }
                }
            }

            // 載入當前活躍掛單與貸款
            for (const currency of this.currencies) {
                try {
                    const offers = await rest.getActiveFundingOffers(currency, this.credentials);
                    if (Array.isArray(offers)) {
                        this.state.activeOffers[currency] = offers.map(rest.parseFundingOffer).filter(Boolean);
                    }

                    const [credits, loans] = await Promise.all([
                        rest.getActiveFundingCredits(currency, this.credentials),
                        rest.getActiveFundingLoans(currency, this.credentials),
                    ]);

                    const parsedCredits = Array.isArray(credits)
                        ? credits.map(rest.parseFundingCredit).filter(c => c && c.side === 1)
                        : [];
                    
                    const parsedLoans = Array.isArray(loans)
                        ? loans.map(rest.parseFundingCredit).filter(l => l && l.side === 1)
                        : [];

                    this.state.activeCredits[currency] = [...parsedCredits, ...parsedLoans];
                } catch (err) {
                    logger.error('engine', `載入 ${currency} 初始帳戶資料失敗`, { error: err.message, userId: this.userId });
                }
            }
        } catch (err) {
            logger.error('engine', '載入初始帳戶狀態失敗', { error: err.message, userId: this.userId });
        }
    }

    /**
     * 決策週期（每 10 秒執行一次，依據共享行情進行個人決策）
     */
    async _decisionCycle() {
        if (!this.running || this.paused) return;

        if (!this.bfxWs || !this.bfxWs.isConnected() || !this.bfxWs.isAuthenticated()) return;

        for (const currency of this.currencies) {
            try {
                await this._processForCurrency(currency);
            } catch (err) {
                logger.error('engine', `${currency} 決策週期錯誤`, { error: err.message, userId: this.userId });
            }
        }
        this.state.stats.lastUpdate = Date.now();
    }

    /**
     * 處理單一幣種的策略與掛單決策
     */
    async _processForCurrency(currency) {
        const publicWs = getBitfinexPublicWS();
        const marketData = publicWs.getMarketData(currency);
        if (!marketData || !marketData.lastUpdate) return;

        const strategy = getStrategyEngine();

        // 檢查是否需暫停（例如市場極度震盪）
        const pauseCheck = strategy.shouldPause(marketData);
        if (pauseCheck.pause) {
            logger.debug('engine', `${currency}: 策略跳過 - ${pauseCheck.reason}`, this.userId);
            return;
        }

        // 利率飆升捕捉：取消非最佳低利率掛單
        const spikeOffers = strategy.detectRateSpike(marketData, this.state.activeOffers[currency]);
        for (const { offer, reason } of spikeOffers) {
            logger.info('engine', `📈 ${currency} 利率飆升偵測，取消低利率掛單: ${reason}`, this.userId);
            try {
                await rest.cancelFundingOffer(offer.id, this.credentials);
                this.state.stats.offersCancelled++;
            } catch (err) {
                logger.error('engine', `取消掛單 #${offer.id} 失敗`, { error: err.message, userId: this.userId });
            }
        }

        const available = this.state.wallets[currency]?.available || 0;
        const nominalAvailable = Math.max(available, this.minOfferAmount);

        // 核心：使用使用者個人的策略設定 (strategyConfig) 計算最佳掛單方案
        const optimalResult = strategy.calculateOptimalRate(marketData, currency, nominalAvailable, this.strategyConfig);

        // 保存行情診斷快照供 Dashboard 呈現
        this.state.lastDecision[currency] = {
            timestamp: Date.now(),
            frr: marketData.frr,
            optimalResult,
            available,
        };

        if (available < this.minOfferAmount) {
            return; // 餘額不足，在記錄完市場診斷後優雅退場
        }

        if (!optimalResult.shouldOffer) {
            logger.debug('engine', `${currency}: 不掛單 - ${optimalResult.reason}`, this.userId);
            return;
        }

        // 記錄掛單日誌
        if (optimalResult.diagnostics) {
            db.saveLog('debug', 'strategy-decision',
                `${currency}: ${optimalResult.reason}`,
                optimalResult.diagnostics,
                this.userId
            );
        }

        // 進行掛單執行（加入微幅隨機延遲平滑流量）
        for (const order of optimalResult.orders) {
            if (order.amount < this.minOfferAmount) continue;

            const submitDelay = Math.random() * 500;
            setTimeout(async () => {
                if (!this.running || this.paused) return;
                try {
                    await rest.submitFundingOffer(
                        currency,
                        order.amount,
                        order.rate,
                        order.period,
                        this.credentials
                    );
                    this.state.stats.offersPlaced++;
                    logger.info('engine', `📝 掛單 ${currency} $${order.amount.toFixed(0)} @ ${(order.rate * 100).toFixed(4)}%/天，期限 ${order.period} 天`, this.userId);
                } catch (err) {
                    const isBalanceError = err.message.includes('not enough') || err.message.includes('balance');
                    const errorMsg = `❌ 掛單失敗 ${currency}: $${order.amount.toFixed(0)}，錯誤: ${err.message}`;
                    logger.error('engine', errorMsg, { userId: this.userId });
                    
                    if (!isBalanceError) {
                        try {
                            const { sendAlert } = require('../telegram');
                            // 若用戶有自訂 Telegram 設定，才發送警報
                            if (this.bfxWs && this.bfxWs.credentials) {
                                sendAlert('🚨 掛單失敗', errorMsg, this.userId);
                            }
                        } catch (e) {
                            logger.error('engine', '發送掛單失敗警報出錯', { error: e.message });
                        }
                    }
                }
            }, submitDelay);
        }
    }

    /**
     * 設定專屬 WebSocket 監聽器
     */
    _setupWSListeners(bfxWs) {
        // 錢包餘額更新
        bfxWs.on('walletUpdate', (data) => {
            const wallet = rest.parseWallet(data);
            if (wallet && wallet.type === 'funding') {
                const cur = wallet.currency;
                if (this.state.wallets[cur] !== undefined) {
                    const prevAvailable = this.state.wallets[cur].available || 0;
                    this.state.wallets[cur] = {
                        balance: wallet.balance,
                        available: wallet.available || 0,
                    };

                    const newAvailable = wallet.available || 0;
                    if (newAvailable > prevAvailable && newAvailable >= this.minOfferAmount) {
                        logger.info('engine', `⚡ 錢包 ${cur} 新進可用資金 +${(newAvailable - prevAvailable).toFixed(2)}，觸發即刻掛單`, this.userId);
                        this._debouncedDecision(cur, 1500);
                    }
                }
            }
        });

        // 活躍掛單快照
        bfxWs.on('fundingOfferSnapshot', (data) => {
            if (Array.isArray(data)) {
                for (const o of data) {
                    const offer = rest.parseFundingOffer(o);
                    if (offer) {
                        const cur = offer.symbol.replace('f', '');
                        if (this.state.activeOffers[cur]) {
                            const existing = this.state.activeOffers[cur].findIndex((x) => x.id === offer.id);
                            if (existing >= 0) {
                                this.state.activeOffers[cur][existing] = offer;
                            } else {
                                this.state.activeOffers[cur].push(offer);
                            }
                        }
                    }
                }
            }
        });

        // 新增掛單
        bfxWs.on('fundingOfferNew', (data) => {
            const offer = rest.parseFundingOffer(data);
            if (offer) {
                const cur = offer.symbol.replace('f', '');
                if (this.state.activeOffers[cur]) {
                    this.state.activeOffers[cur].push(offer);
                    db.saveOffer({
                        id: offer.id, currency: cur, amount: Math.abs(offer.amount),
                        rate: offer.rate, period: offer.period, status: 'active',
                    }, this.userId);
                }
            }
        });

        // 取消掛單
        bfxWs.on('fundingOfferCancel', (data) => {
            const offer = rest.parseFundingOffer(data);
            if (offer) {
                const cur = offer.symbol.replace('f', '');
                if (this.state.activeOffers[cur]) {
                    this.state.activeOffers[cur] = this.state.activeOffers[cur].filter((o) => o.id !== offer.id);
                    db.closeOffer(offer.id, this.userId);
                }
            }
        });

        // 活躍貸款快照 (Credits)
        bfxWs.on('fundingCreditSnapshot', (data) => {
            if (Array.isArray(data)) {
                for (const c of data) {
                    const credit = rest.parseFundingCredit(c);
                    if (credit) {
                        const cur = credit.symbol.replace('f', '');
                        if (this.state.activeCredits[cur]) {
                            this.state.activeCredits[cur].push(credit);
                        }
                    }
                }
            }
        });

        // 貸款成交
        bfxWs.on('fundingCreditNew', (data) => {
            const credit = rest.parseFundingCredit(data);
            if (credit) {
                const cur = credit.symbol.replace('f', '');
                if (this.state.activeCredits[cur]) {
                    this.state.activeCredits[cur].push(credit);
                    db.saveLoan({
                        id: credit.id, currency: cur, amount: Math.abs(credit.amount),
                        rate: credit.rate, period: credit.period, status: 'active',
                    }, this.userId);

                    const amount = Math.abs(credit.amount);
                    logger.info('engine', `🎉 放貸成交 ${cur} ${amount} @ ${(credit.rate * 100).toFixed(4)}%/天`, this.userId);
                    
                    // 成交通知緩衝合併發送
                    if (!this._tradeBuffer[cur]) {
                        this._tradeBuffer[cur] = { amount: 0, rate: credit.rate, period: credit.period, timerId: null };
                    }
                    this._tradeBuffer[cur].amount += amount;
                    this._tradeBuffer[cur].rate = credit.rate;
                    this._tradeBuffer[cur].period = credit.period;

                    if (this._tradeBuffer[cur].timerId) {
                        clearTimeout(this._tradeBuffer[cur].timerId);
                    }

                    this._tradeBuffer[cur].timerId = setTimeout(() => {
                        const { sendTradeNotification } = require('../telegram');
                        const buffered = this._tradeBuffer[cur];
                        if (buffered && buffered.amount > 0) {
                            sendTradeNotification(cur, buffered.amount, buffered.rate, buffered.period, this.userId);
                            delete this._tradeBuffer[cur];
                        }
                    }, 5000);
                }
            }
        });

        // 貸款關閉 (到期收息)
        bfxWs.on('fundingCreditClose', (data) => {
            const credit = rest.parseFundingCredit(data);
            if (credit) {
                const cur = credit.symbol.replace('f', '');
                if (this.state.activeCredits[cur]) {
                    this.state.activeCredits[cur] = this.state.activeCredits[cur].filter((c) => c.id !== credit.id);
                    const rawInterest = Math.abs(credit.amount) * credit.rate * credit.period;
                    const interestEarned = rawInterest * 0.85; // 扣 15% 手續費
                    db.closeLoan(credit.id, interestEarned, this.userId);
                    db.saveEarning({
                        currency: cur, amount: interestEarned, rate: credit.rate, period: credit.period,
                    }, this.userId);

                    this.state.stats.totalEarned[cur] = (this.state.stats.totalEarned[cur] || 0) + interestEarned;
                    logger.info('engine', `💰 放貸到期 ${cur}，賺取利息(稅後): ${interestEarned.toFixed(4)}`, this.userId);

                    // 複利重掛
                    if (this.compoundingEnabled && this.running && !this.paused) {
                        logger.info('engine', `♻️ 複利重掛：到期資金即刻重掛`, this.userId);
                        this._debouncedDecision(cur, 2000);
                    }
                }
            }
        });

        // 未使用貸款快照 (Loans)
        bfxWs.on('fundingLoanSnapshot', (data) => {
            if (Array.isArray(data)) {
                for (const l of data) {
                    const loan = rest.parseFundingCredit(l);
                    if (loan && loan.side === 1) {
                        const cur = loan.symbol.replace('f', '');
                        if (this.state.activeCredits[cur]) {
                            if (!this.state.activeCredits[cur].some(x => x.id === loan.id)) {
                                this.state.activeCredits[cur].push(loan);
                            }
                        }
                    }
                }
            }
        });

        bfxWs.on('fundingLoanNew', (data) => {
            const loan = rest.parseFundingCredit(data);
            if (loan && loan.side === 1) {
                const cur = loan.symbol.replace('f', '');
                if (this.state.activeCredits[cur]) {
                    if (!this.state.activeCredits[cur].some(x => x.id === loan.id)) {
                        this.state.activeCredits[cur].push(loan);
                        db.saveLoan({
                            id: loan.id, currency: cur, amount: Math.abs(loan.amount),
                            rate: loan.rate, period: loan.period, status: 'active',
                        }, this.userId);

                        const amount = Math.abs(loan.amount);
                        logger.info('engine', `🎉 放貸成交 (對方未開倉) ${cur} ${amount} @ ${(loan.rate * 100).toFixed(4)}%/天`, this.userId);
                        
                        if (!this._tradeBuffer[cur]) {
                            this._tradeBuffer[cur] = { amount: 0, rate: loan.rate, period: loan.period, timerId: null };
                        }
                        this._tradeBuffer[cur].amount += amount;
                        this._tradeBuffer[cur].rate = loan.rate;
                        this._tradeBuffer[cur].period = loan.period;

                        if (this._tradeBuffer[cur].timerId) {
                            clearTimeout(this._tradeBuffer[cur].timerId);
                        }

                        this._tradeBuffer[cur].timerId = setTimeout(() => {
                            const { sendTradeNotification } = require('../telegram');
                            const buffered = this._tradeBuffer[cur];
                            if (buffered && buffered.amount > 0) {
                                sendTradeNotification(cur, buffered.amount, buffered.rate, buffered.period, this.userId);
                                delete this._tradeBuffer[cur];
                            }
                        }, 5000);
                    }
                }
            }
        });

        bfxWs.on('fundingLoanClose', (data) => {
            const loan = rest.parseFundingCredit(data);
            if (loan && loan.side === 1) {
                const cur = loan.symbol.replace('f', '');
                if (this.state.activeCredits[cur]) {
                    this.state.activeCredits[cur] = this.state.activeCredits[cur].filter((c) => c.id !== loan.id);
                    const rawInterest = Math.abs(loan.amount) * loan.rate * loan.period;
                    const interestEarned = rawInterest * 0.85;
                    db.closeLoan(loan.id, interestEarned, this.userId);
                    logger.info('engine', `🔄 放貸合約移轉或結束 #${loan.id}`, this.userId);
                }
            }
        });

        bfxWs.on('reconnectFailed', () => {
            logger.error('engine', '❌ WebSocket 重連失敗，暫停放貸', { userId: this.userId });
            this.pause('WebSocket 連線超時中斷');
        });

        bfxWs.on('maintenance', (active) => {
            if (active) {
                this.pause('Bitfinex 系統維護中');
            } else {
                this.resume();
            }
        });
    }

    getStatus() {
        const strategy = getStrategyEngine();
        const publicWs = getBitfinexPublicWS();
        const marketData = publicWs.getMarketData('USD') || {};
        const frr = marketData.frr || 0.0003;

        let frrDelta = 0;
        if (frr > 0) {
            const usdHistory = strategy.ibrrHistory['USD'];
            if (usdHistory && usdHistory.length > 0) {
                const latestIbrr = usdHistory[usdHistory.length - 1].ibrr;
                frrDelta = (latestIbrr - frr) / frr;
            }
        }

        const strategyStatus = strategy.getStatus();
        strategyStatus.config = {
            ...strategyStatus.config,
            frrDelta: frrDelta,
            orderUnit: this.autoTransferThreshold,
            defaultPeriod: '自適應 (2-30天)',
            reserveRatio: 0
        };
        strategyStatus.mode = 'balanced';

        return {
            running: this.running,
            paused: this.paused,
            pauseReason: this.pauseReason,
            monitorOnly: this.monitorOnly,
            compounding: this.compoundingEnabled,
            autoTransfer: this.autoTransferEnabled,
            autoTransferThreshold: this.autoTransferThreshold,
            strategyMode: 'balanced',
            connected: this.bfxWs ? this.bfxWs.isConnected() : false,
            authenticated: this.bfxWs ? this.bfxWs.isAuthenticated() : false,
            stats: this.state.stats,
            wallets: this.state.wallets,
            activeOffers: {
                USD: this.state.activeOffers.USD?.length || 0,
                USDT: this.state.activeOffers.USDT?.length || 0,
            },
            activeCredits: {
                USD: this.state.activeCredits.USD?.length || 0,
                USDT: this.state.activeCredits.USDT?.length || 0,
            },
            marketData: publicWs.marketData,
            strategy: strategyStatus,
            features: {
                compounding: this.compoundingEnabled,
                autoTransfer: this.autoTransferEnabled,
                autoTransferThreshold: this.autoTransferThreshold,
            }
        };
    }

    getDetailedStatus() {
        return {
            ...this.getStatus(),
            wallets: this.state.wallets,
            activeOffers: this.state.activeOffers,
            activeCredits: this.state.activeCredits,
            lastDecision: this.state.lastDecision,
        };
    }
}

// ============== 向下相容單用戶模式的 Singleton Wrapper ==============
let legacyInstance = null;

function getLendingEngine() {
    if (!legacyInstance) {
        // 使用系統預設環境變數建立 Singleton 實例
        const credentials = {
            apiKey: config.bitfinex.apiKey,
            apiSecret: config.bitfinex.apiSecret,
        };
        const settings = {
            compoundingEnabled: true,
            autoTransferEnabled: false,
            autoTransferThreshold: 500,
            minOfferAmount: config.lending.minOfferAmount,
            currencies: config.lending.currencies,
        };
        legacyInstance = new LendingBot('legacy_admin', credentials, settings);
    }
    return legacyInstance;
}

module.exports = {
    LendingBot,
    getLendingEngine,
};
