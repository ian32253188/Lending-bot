const config = require('../../config');
const logger = require('../../utils/logger');
const db = require('../database');
const rest = require('../bitfinex/rest');
const { getBitfinexPublicWS, createBitfinexPrivateWS, isPublicTickerFresh } = require('../bitfinex/ws');
const { getStrategyEngine } = require('./strategy');
const { getCachedFundingMarketSummary } = require('../market-summary');
const { classifyPrivateApiError } = require('../private-account-status');

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
        this.compoundingHoldAmount = Math.max(0, Number(settings.compoundingHoldAmount) || 0);
        this.autoTransferEnabled = settings.autoTransferEnabled || false;
        this.autoTransferThreshold = settings.autoTransferThreshold || 500;
        this.minOfferAmount = settings.minOfferAmount || 150;
        this.currencies = ['USD'];
        this.strategyConfig = settings.strategyConfig || { mode: 'simplified' };

        // 用戶運行狀態快取
        this.state = {
            accountDataAvailable: false,
            accountDataComplete: false,
            accountDataUpdatedAt: null,
            accountDataError: 'Bitfinex 個人帳戶資料正在同步。',
            accountDataErrorCode: 'BITFINEX_ACCOUNT_DATA_PENDING',
            wallets: {},       // { USD: { balance, available } }
            activeOffers: {},  // { USD: [...] }
            activeCredits: {}, // { USD: [...] }
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
        this._closedLoanIds = new Set();
        this._tradeBuffer = {};
        this._submitTimers = [];
        this._accountDataLoadState = { wallets: false, offers: {}, credits: {} };
        this._accountDataErrors = new Map();
        this._wsCreditSnapshot = null;
        this._wsLoanSnapshot = null;

        // 初始化幣種狀態
        for (const cur of this.currencies) {
            this.state.wallets[cur] = { balance: null, available: null };
            this.state.activeOffers[cur] = [];
            this.state.activeCredits[cur] = [];
            this.state.stats.totalEarned[cur] = 0;
            this._accountDataLoadState.offers[cur] = false;
            this._accountDataLoadState.credits[cur] = false;
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

        // 清除掛單 submit delay timers
        for (const t of this._submitTimers) {
            clearTimeout(t);
        }
        this._submitTimers = [];

        // 清除交易通知緩衝 timer
        for (const buffer of Object.values(this._tradeBuffer)) {
            if (buffer.timerId) {
                clearTimeout(buffer.timerId);
            }
        }
        this._tradeBuffer = {};

        // 斷開私有 WS
        if (this.bfxWs) {
            this.bfxWs.disconnect();
            this.bfxWs = null;
        }

        logger.info('engine', `✅ 用戶 ${this.userId} 的放貸機器人已停止`);
    }

    pause(reason = '手動暫停') {
        this.paused = true;
        this.pauseReason = reason;
        logger.info('engine', `⏸️ 放貸已暫停: ${reason}`, this.userId);
        db.saveUserSettings(this.userId, { status: 'paused', pause_reason: reason }).catch(err => {
            logger.error('engine', '儲存暫停狀態失敗', { error: err.message, userId: this.userId });
        });
    }

    resume() {
        this.paused = false;
        this.pauseReason = '';
        logger.info('engine', '▶️ 放貸已恢復', this.userId);
        db.saveUserSettings(this.userId, { status: 'running', pause_reason: '' }).catch(err => {
            logger.error('engine', '儲存恢復狀態失敗', { error: err.message, userId: this.userId });
        });
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

    async setCompounding(enabled) {
        const nextEnabled = Boolean(enabled);
        const nextHoldAmount = nextEnabled ? 0 : this.compoundingHoldAmount;
        await db.saveUserSettings(this.userId, {
            compounding_enabled: nextEnabled,
            compounding_hold_amount: nextHoldAmount,
        });
        this.compoundingEnabled = nextEnabled;
        this.compoundingHoldAmount = nextHoldAmount;
        logger.info('engine', `複利模式已${nextEnabled ? '開啟' : '關閉'}`, this.userId);
        if (nextEnabled && this.running && !this.paused) {
            for (const currency of this.currencies) this._debouncedDecision(currency, 1000);
        }
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
        const noteFailure = (dataset, currency, error) => {
            const diagnostic = classifyPrivateApiError(error);
            const key = dataset === 'wallets' ? 'wallets' : `${currency}:${dataset}`;
            const alreadySynced = dataset === 'wallets'
                ? this._accountDataLoadState.wallets
                : this._accountDataLoadState[dataset]?.[currency] === true;
            if (!alreadySynced) this._accountDataErrors.set(key, diagnostic);
            logger.warn('engine', 'Bitfinex 私有帳戶資料同步失敗', {
                userId: this.userId,
                dataset,
                currency,
                errorCode: diagnostic.code,
                httpStatus: diagnostic.status,
            });
        };

        try {
            const wallets = await rest.getWallets(this.credentials);
            if (!Array.isArray(wallets)) throw new Error('Invalid wallet response');
            for (const currency of this.currencies) {
                if (!this.state.wallets[currency]) this.state.wallets[currency] = { balance: 0, available: 0 };
            }
            for (const currency of this.currencies) {
                this.state.wallets[currency] = { balance: 0, available: 0 };
            }
            for (const row of wallets) {
                const wallet = rest.parseWallet(row);
                if (wallet?.type === 'funding' && this.state.wallets[wallet.currency] !== undefined) {
                    this.state.wallets[wallet.currency] = {
                        balance: Number(wallet.balance),
                        available: Number(wallet.available) || 0,
                    };
                }
            }
            this._accountDataLoadState.wallets = true;
            this._accountDataErrors.delete('wallets');
        } catch (error) {
            noteFailure('wallets', null, error);
        }

        // Bitfinex enforces increasing nonces. Read each dataset in a fixed
        // order and let the REST adapter serialize requests per API key.
        for (const currency of this.currencies) {
            try {
                const offers = await rest.getActiveFundingOffers(currency, this.credentials);
                if (!Array.isArray(offers)) throw new Error(`Invalid ${currency} offers response`);
                this.state.activeOffers[currency] = offers.map(rest.parseFundingOffer).filter(Boolean);
                this._accountDataLoadState.offers[currency] = true;
                this._accountDataErrors.delete(`${currency}:offers`);
            } catch (error) {
                noteFailure('offers', currency, error);
            }

            try {
                const credits = await rest.getActiveFundingCredits(currency, this.credentials);
                if (!Array.isArray(credits)) throw new Error(`Invalid ${currency} credits response`);
                const loans = await rest.getActiveFundingLoans(currency, this.credentials);
                if (!Array.isArray(loans)) throw new Error(`Invalid ${currency} loans response`);
                const parsedCredits = credits.map(rest.parseFundingCredit).filter(row => row?.side === 1);
                const parsedLoans = loans.map(rest.parseFundingCredit).filter(row => row?.side === 1);
                this.state.activeCredits[currency] = [...parsedCredits, ...parsedLoans];
                await this._persistActiveLoans(currency);
                this._accountDataLoadState.credits[currency] = true;
                this._accountDataErrors.delete(`${currency}:credits`);
            } catch (error) {
                noteFailure('credits', currency, error);
            }
        }

        this._refreshAccountDataSyncState();
    }

    _refreshAccountDataSyncState() {
        const checks = [
            this._accountDataLoadState.wallets,
            ...this.currencies.flatMap(currency => [
                this._accountDataLoadState.offers[currency],
                this._accountDataLoadState.credits[currency],
            ]),
        ];
        this.state.accountDataAvailable = checks.some(Boolean);
        this.state.accountDataComplete = checks.length > 0 && checks.every(Boolean);
        this.state.accountDataUpdatedAt = this.state.accountDataAvailable ? new Date().toISOString() : null;
        const firstError = this._accountDataErrors.values().next().value;
        this.state.accountDataError = firstError?.message
            || (this.state.accountDataComplete ? null : 'Bitfinex 個人帳戶資料尚未完整同步。');
        this.state.accountDataErrorCode = firstError?.code
            || (this.state.accountDataComplete ? null : 'BITFINEX_ACCOUNT_DATA_INCOMPLETE');
    }

    async _persistActiveLoans(currency) {
        if (typeof db.saveLoan !== 'function') return;
        const activeLoans = this.state.activeCredits[currency] || [];
        await Promise.all(activeLoans.map(async loan => {
            const amount = Number(loan?.amount);
            const rate = Number(loan?.rate);
            const period = Number(loan?.period);
            if (loan?.id === null || loan?.id === undefined
                || !Number.isFinite(amount) || !Number.isFinite(rate) || !Number.isFinite(period)) return;
            try {
                await db.saveLoan({
                    id: loan.id,
                    currency,
                    amount: Math.abs(amount),
                    rate,
                    period,
                    openedAt: loan.openedAt,
                    status: 'active',
                }, this.userId);
            } catch (error) {
                logger.warn('engine', `同步 ${currency} 活躍放貸紀錄至資料庫失敗`, {
                    userId: this.userId,
                    loanId: loan.id,
                    error: error.message,
                });
            }
        }));
    }

    _applyWebSocketCreditSnapshots() {
        if (!this._wsCreditSnapshot || !this._wsLoanSnapshot) return;

        for (const currency of this.currencies) {
            const credits = this._wsCreditSnapshot[currency] || [];
            const loans = this._wsLoanSnapshot[currency] || [];
            const uniqueById = new Map([...credits, ...loans].map(row => [row.id, row]));
            this.state.activeCredits[currency] = [...uniqueById.values()];
            void this._persistActiveLoans(currency);
            this._accountDataLoadState.credits[currency] = true;
            this._accountDataErrors.delete(`${currency}:credits`);
        }
        this._refreshAccountDataSyncState();
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
        let marketData = publicWs.getMarketData(currency);
        if (!isPublicTickerFresh(marketData)) return;

        // fUSD 的三種策略基準來自公開成交/歷史資料；使用 60 秒快取，避免每個決策週期重複打 API。
        if (currency === 'USD') {
            const summary = await getCachedFundingMarketSummary({ publicWs, db });
            const toDailyRate = value => Number.isFinite(Number(value)) ? Number(value) / (365 * 100) : null;
            marketData = {
                ...marketData,
                currentTradeAvg: summary.currentRate,
                high24h: summary.high24h,
                high30d: summary.high30d,
            };
            // 避免摘要 API 暫時無資料時覆寫 WebSocket 的即時行情。
            if (!marketData.currentTradeAvg) marketData.currentTradeAvg = toDailyRate(summary.currentApy);
            if (!marketData.high24h) marketData.high24h = toDailyRate(summary.high24hApy);
            if (!marketData.high30d) marketData.high30d = toDailyRate(summary.high30dApy);
        }

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
        if (!this.compoundingEnabled && this.state.accountDataComplete && available < this.compoundingHoldAmount) {
            this.compoundingHoldAmount = available;
            db.saveUserSettings(this.userId, { compounding_hold_amount: available }).catch(error => {
                logger.warn('engine', '更新保留利息金額失敗', { userId: this.userId, error: error.message });
            });
        }
        const heldInterest = this.compoundingEnabled ? 0 : Math.min(available, this.compoundingHoldAmount);
        const nominalAvailable = Math.max(0, available - heldInterest);

        // 核心：使用使用者個人的策略設定 (strategyConfig) 計算最佳掛單方案
        const optimalResult = strategy.calculateOptimalRate(marketData, currency, nominalAvailable, this.strategyConfig);

        // 保存行情診斷快照供 Dashboard 呈現
        this.state.lastDecision[currency] = {
            timestamp: Date.now(),
            frr: marketData.frr,
            optimalResult,
            available,
        };

        if (nominalAvailable < this.minOfferAmount) {
            return; // 餘額不足，在記錄完市場診斷後優雅退場
        }

        if (!optimalResult.shouldOffer) {
            logger.debug('engine', `${currency}: 不掛單 - ${optimalResult.reason}`, this.userId);
            return;
        }

        // 進行掛單執行（加入微幅隨機延遲平滑流量）
        for (const order of optimalResult.orders) {
            if (order.amount < this.minOfferAmount) continue;

            const submitDelay = Math.random() * 500;
            if (submitDelay > 0) {
                await new Promise(resolve => {
                    const t = setTimeout(resolve, submitDelay);
                    this._submitTimers.push(t);
                });
            }
            
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
        }
    }

    /**
     * 設定專屬 WebSocket 監聽器
     */
    _setupWSListeners(bfxWs) {
        // Wallet snapshot is authoritative for every configured funding wallet,
        // including currencies with a zero balance or no wallet row at all.
        bfxWs.on('walletSnapshot', (data) => {
            if (!Array.isArray(data)) return;
            for (const currency of this.currencies) {
                this.state.wallets[currency] = { balance: 0, available: 0 };
            }
            for (const row of data) {
                const wallet = rest.parseWallet(row);
                if (wallet?.type === 'funding' && this.state.wallets[wallet.currency] !== undefined) {
                    this.state.wallets[wallet.currency] = {
                        balance: Number(wallet.balance),
                        available: Number(wallet.available) || 0,
                    };
                }
            }
            this._accountDataLoadState.wallets = true;
            this._accountDataErrors.delete('wallets');
            this._refreshAccountDataSyncState();
        });

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
            if (!Array.isArray(data)) return;
            for (const currency of this.currencies) this.state.activeOffers[currency] = [];
            for (const rawOffer of data) {
                const offer = rest.parseFundingOffer(rawOffer);
                if (offer && this.state.activeOffers[offer.currency]) {
                    this.state.activeOffers[offer.currency].push(offer);
                }
            }
            for (const currency of this.currencies) {
                this._accountDataLoadState.offers[currency] = true;
                this._accountDataErrors.delete(`${currency}:offers`);
            }
            this._refreshAccountDataSyncState();
        });

        // 新增掛單
        bfxWs.on('fundingOfferNew', (data) => {
            const offer = rest.parseFundingOffer(data);
            if (offer) {
                const cur = offer.currency;
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
                const cur = offer.currency;
                if (this.state.activeOffers[cur]) {
                    this.state.activeOffers[cur] = this.state.activeOffers[cur].filter((o) => o.id !== offer.id);
                    db.closeOffer(offer.id, this.userId);
                }
            }
        });

        // 活躍貸款快照 (Credits)
        bfxWs.on('fundingCreditSnapshot', (data) => {
            if (!Array.isArray(data)) return;
            this._wsCreditSnapshot = Object.fromEntries(this.currencies.map(currency => [currency, []]));
            for (const row of data) {
                const credit = rest.parseFundingCredit(row);
                if (credit?.side === 1 && this._wsCreditSnapshot[credit.currency]) {
                    this._wsCreditSnapshot[credit.currency].push(credit);
                }
            }
            this._applyWebSocketCreditSnapshots();
        });

        // 貸款成交
        bfxWs.on('fundingCreditNew', (data) => {
            const credit = rest.parseFundingCredit(data);
            if (credit) {
                const cur = credit.currency;
                if (this.state.activeCredits[cur]) {
                    this.state.activeCredits[cur].push(credit);
                    db.saveLoan({
                        id: credit.id, currency: cur, amount: Math.abs(credit.amount),
                        rate: credit.rate, period: credit.period, openedAt: credit.openedAt, status: 'active',
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
        bfxWs.on('fundingCreditClose', data => this._handleFundingClose(data));

        // 未使用貸款快照 (Loans)
        bfxWs.on('fundingLoanSnapshot', (data) => {
            if (!Array.isArray(data)) return;
            this._wsLoanSnapshot = Object.fromEntries(this.currencies.map(currency => [currency, []]));
            for (const row of data) {
                const loan = rest.parseFundingCredit(row);
                if (loan?.side === 1 && this._wsLoanSnapshot[loan.currency]) {
                    this._wsLoanSnapshot[loan.currency].push(loan);
                }
            }
            this._applyWebSocketCreditSnapshots();
        });

        bfxWs.on('fundingLoanNew', (data) => {
            const loan = rest.parseFundingCredit(data);
            if (loan && loan.side === 1) {
                const cur = loan.currency;
                if (this.state.activeCredits[cur]) {
                    if (!this.state.activeCredits[cur].some(x => x.id === loan.id)) {
                        this.state.activeCredits[cur].push(loan);
                        db.saveLoan({
                            id: loan.id, currency: cur, amount: Math.abs(loan.amount),
                            rate: loan.rate, period: loan.period, openedAt: loan.openedAt, status: 'active',
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

        bfxWs.on('fundingLoanClose', data => this._handleFundingClose(data));

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

    _handleFundingClose(data) {
        const loan = rest.parseFundingCredit(data);
        if (!loan || loan.side !== 1 || loan.id === null || loan.id === undefined) return;
        const loanKey = String(loan.id);
        if (this._closedLoanIds.has(loanKey)) return;
        this._closedLoanIds.add(loanKey);
        if (this._closedLoanIds.size > 1000) this._closedLoanIds.delete(this._closedLoanIds.values().next().value);

        const currency = loan.currency;
        if (!this.state.activeCredits[currency]) return;
        this.state.activeCredits[currency] = this.state.activeCredits[currency].filter(row => String(row.id) !== loanKey);

        const principal = Math.abs(Number(loan.amount) || 0);
        const rawInterest = principal * (Number(loan.rate) || 0) * (Number(loan.period) || 0);
        const interestEarned = rawInterest * 0.85;
        void db.closeLoan(loan.id, interestEarned, this.userId);
        this.state.stats.totalEarned[currency] = (this.state.stats.totalEarned[currency] || 0) + interestEarned;
        logger.info('engine', `放貸到期 ${currency}，估算稅後利息 ${interestEarned.toFixed(4)}`, this.userId);

        if (this.compoundingEnabled) {
            if (this.running && !this.paused) this._debouncedDecision(currency, 2000);
            return;
        }

        // 關閉複利時，保留利息；到期本金仍可照常重新放貸。
        this.compoundingHoldAmount += interestEarned;
        db.saveUserSettings(this.userId, { compounding_hold_amount: this.compoundingHoldAmount }).catch(error => {
            logger.warn('engine', '儲存保留利息金額失敗', { userId: this.userId, error: error.message });
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
        const userStrategyConfig = { ...this.strategyConfig };
        strategyStatus.config = {
            ...strategyStatus.config,
            ...userStrategyConfig,
            frrDelta: frrDelta,
            periodDays: userStrategyConfig.periodDays || 2,
            useAllAvailable: true,
            reserveRatio: 0
        };
        strategyStatus.mode = 'balanced';

        return {
            running: this.running,
            paused: this.paused,
            pauseReason: this.pauseReason,
            accountDataAvailable: this.state.accountDataAvailable,
            accountDataComplete: this.state.accountDataComplete,
            accountDataUpdatedAt: this.state.accountDataUpdatedAt,
            accountDataError: this.state.accountDataError,
            accountDataErrorCode: this.state.accountDataErrorCode,
            monitorOnly: this.monitorOnly,
            compounding: this.compoundingEnabled,
            autoTransfer: this.autoTransferEnabled,
            autoTransferThreshold: this.autoTransferThreshold,
            strategyMode: 'balanced',
            connected: this.bfxWs ? this.bfxWs.isConnected() : false,
            authenticated: this.bfxWs ? this.bfxWs.isAuthenticated() : false,
            stats: this.state.stats,
            wallets: Object.fromEntries(this.currencies.map(currency => [
                currency,
                this._accountDataLoadState.wallets
                    ? (this.state.wallets[currency] || { balance: 0, available: 0 })
                    : { balance: null, available: null },
            ])),
            activeOffers: Object.fromEntries(this.currencies.map(currency => [
                currency,
                this._accountDataLoadState.offers[currency] ? this.state.activeOffers[currency]?.length || 0 : null,
            ])),
            activeCredits: Object.fromEntries(this.currencies.map(currency => [
                currency,
                this._accountDataLoadState.credits[currency] ? this.state.activeCredits[currency]?.length || 0 : null,
            ])),
            marketData: publicWs.marketData,
            strategy: strategyStatus,
            features: {
                compounding: this.compoundingEnabled,
                autoTransfer: this.autoTransferEnabled,
                autoTransferThreshold: this.autoTransferThreshold,
            },
            strategySettings: {
                rateStrategy: userStrategyConfig.rateStrategy || 'current_avg',
                periodDays: userStrategyConfig.periodDays || 2,
                useAllAvailable: true,
            },
        };
    }

    getDetailedStatus() {
        return {
            ...this.getStatus(),
            activeOffers: Object.fromEntries(this.currencies.map(currency => [
                currency,
                this._accountDataLoadState.offers[currency] ? this.state.activeOffers[currency] : null,
            ])),
            activeCredits: Object.fromEntries(this.currencies.map(currency => [
                currency,
                this._accountDataLoadState.credits[currency] ? this.state.activeCredits[currency] : null,
            ])),
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
