const config = require('../../config');
const logger = require('../../utils/logger');
const db = require('../database');
const rest = require('../bitfinex/rest');
const { getBitfinexWS } = require('../bitfinex/ws');
const { getStrategyEngine } = require('./strategy');

class LendingEngine {
    constructor() {
        this.running = false;
        this.paused = false;
        this.pauseReason = '';
        this.monitorOnly = false;

        // 策略設定
        this.compoundingEnabled = true;
        this.autoTransferEnabled = false;
        this.autoTransferThreshold = 500;

        // 即時狀態
        this.state = {
            wallets: {},       // { USD: { balance, available }, USDT: {...} }
            exchangeWallets: {}, // Exchange 錢包餘額
            activeOffers: {},  // { USD: [...], USDT: [...] }
            activeCredits: {}, // { USD: [...], USDT: [...] }
            lastDecision: {},  // { USD: { timestamp, frr, optimalResult, available } }
            stats: {
                offersPlaced: 0,
                offersCancelled: 0,
                totalEarned: {}, // { USD: 0, USDT: 0 }
                lastUpdate: null,
            },
        };

        // 方案 B：事件驅動掛單防抖狀態
        this._pendingDecisions = {};     // { USD: timeoutId, USDT: timeoutId }
        this._lastDecisionTime = {};     // { USD: timestamp, USDT: timestamp }
        this._lastFRR = {};              // { USD: 0.00035, USDT: 0.00028 } 用於偵測變動
        this._historicalFRRTimer = null;  // 方案 D：歷史均值更新定時器
        this._idleFundsTimer = null;      // 閒置資金監控定時器
        this._idleStartTime = {};         // { USD: timestamp, USDT: timestamp }
        this._tradeBuffer = {};           // { USD: { amount, rate, period, timerId } }
        this._offerReoffered = new Set(); // 記錄已執行過降息重掛的 offer ID (避免在同一週期重複執行)
        
        // 初始化幣種狀態
        for (const cur of config.lending.currencies) {
            this.state.wallets[cur] = { balance: 0, available: 0 };
            this.state.activeOffers[cur] = [];
            this.state.activeCredits[cur] = [];
            this.state.stats.totalEarned[cur] = 0;
        }
    }

    /**
     * 啟動放貸引擎
     */
    async start() {
        if (this.running) {
            logger.warn('engine', '放貸引擎已在運行中');
            return;
        }

        // 載入持久化設定
        await this._loadSettings();

        logger.info('engine', `🚀 放貸模式啟動中...`);
        this.running = true;
        db.saveSetting('engine_running', 'true');

        // 連接 WebSocket
        const bfxWs = getBitfinexWS();
        this._setupWSListeners(bfxWs);
        bfxWs.connect();

        // 初始載入帳戶資訊
        await this._loadInitialState();

        // 啟動決策週期（10 秒）
        this.decisionTimer = setInterval(
            () => this._decisionCycle(),
            config.lending.decisionIntervalMs
        );

        // 啟動利率收集器（每 5 分鐘收集一次）
        this.rateCollectionTimer = setInterval(
            () => this._collectRateData(),
            5 * 60 * 1000
        );

        // 立即收集一次數據
        setTimeout(() => this._collectRateData(), 5000);

        // 方案 D：啟動歷史 FRR 均值更新器（每 30 分鐘更新一次）
        this._historicalFRRTimer = setInterval(
            () => this._updateHistoricalFRR(),
            30 * 60 * 1000
        );
        // 啟動後 10 秒先載入一次
        setTimeout(() => this._updateHistoricalFRR(), 10000);

        // 啟動自動維護監控（每 1 分鐘檢查一次）
        this._idleFundsTimer = setInterval(
            () => {
                this._checkAndReofferTimeoutOffers();
            },
            60 * 1000
        );

        logger.info('engine', `✅ 放貸模式已啟動`);
        db.saveLog('info', 'engine', `放貸模式已啟動`);
    }

    async startMonitorOnly() {
        await this.start();
    }

    /**
     * 停止放貸引擎
     */
    async stop() {
        logger.info('engine', '⏹️ 停止放貸引擎...');
        this.running = false;
        db.saveSetting('engine_running', 'false');

        if (this.decisionTimer) {
            clearInterval(this.decisionTimer);
            this.decisionTimer = null;
        }
        if (this.rateCollectionTimer) {
            clearInterval(this.rateCollectionTimer);
            this.rateCollectionTimer = null;
        }
        if (this.autoTransferTimer) {
            clearInterval(this.autoTransferTimer);
            this.autoTransferTimer = null;
        }
        if (this._historicalFRRTimer) {
            clearInterval(this._historicalFRRTimer);
            this._historicalFRRTimer = null;
        }
        if (this._idleFundsTimer) {
            clearInterval(this._idleFundsTimer);
            this._idleFundsTimer = null;
        }
        // 清除事件驅動防抖 timer
        for (const timerId of Object.values(this._pendingDecisions)) {
            clearTimeout(timerId);
        }
        this._pendingDecisions = {};

        const bfxWs = getBitfinexWS();
        bfxWs.disconnect();

        logger.info('engine', '✅ 放貸引擎已停止');
        db.saveLog('info', 'engine', '放貸引擎已停止');
    }

    /**
     * 暫停放貸
     */
    pause(reason = '手動暫停') {
        this.paused = true;
        this.pauseReason = reason;
        db.saveSetting('engine_paused', 'true');
        db.saveSetting('pause_reason', reason);
        logger.info('engine', `⏸️ 放貸已暫停: ${reason}`);
        db.saveLog('info', 'engine', `放貸已暫停: ${reason}`);
    }

    /**
     * 恢復放貸
     */
    resume() {
        this.paused = false;
        this.pauseReason = '';
        db.saveSetting('engine_paused', 'false');
        db.saveSetting('pause_reason', '');
        logger.info('engine', '▶️ 放貸已恢復');
        db.saveLog('info', 'engine', '放貸已恢復');
    }

    /**
     * 緊急停止 - 取消所有掛單並暫停
     */
    async emergencyStop() {
        this.pause('緊急停止');
        for (const cur of config.lending.currencies) {
            try {
                await rest.cancelAllFundingOffers(cur);
                logger.info('engine', `🚨 緊急停止: 已取消所有 ${cur} 掛單`);
            } catch (err) {
                logger.error('engine', `緊急停止取消 ${cur} 掛單失敗`, { error: err.message });
            }
        }
    }

    setCompounding(enabled) {
        this.compoundingEnabled = enabled;
        db.saveSetting('compounding', enabled.toString());
        logger.info('engine', `複利模式已${enabled ? '開啟' : '關閉'}`);
    }

    setAutoTransfer(enabled, threshold = 500) {
        this.autoTransferEnabled = enabled;
        this.autoTransferThreshold = threshold;
        db.saveSetting('auto_transfer', enabled.toString());
        db.saveSetting('auto_transfer_threshold', threshold.toString());
        logger.info('engine', `自動轉帳已${enabled ? '開啟' : '關閉'}，門檻: ${threshold}`);
    }

    /**
     * 設定 WebSocket 監聽器
     */
    _setupWSListeners(bfxWs) {
        // 錢包更新
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
                    logger.debug('engine', `錢包更新 ${cur}`, this.state.wallets[cur]);

                    // 方案 B：偵測新資金轉入且達到最小掛單金額 → 即刻觸發掛單
                    const newAvailable = wallet.available || 0;
                    if (newAvailable > prevAvailable && newAvailable >= config.lending.minOfferAmount) {
                        logger.info('engine', `⚡ 偵測到 ${cur} 新資金 +${(newAvailable - prevAvailable).toFixed(2)} 且餘額已達標，觸發即刻掛單`);
                        this._debouncedDecision(cur, 1500); // 1.5 秒後執行（等待餘額穩定）
                    }
                }
            }
        });

        // Funding Offer 快照
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

        // Funding Offer 新增
        bfxWs.on('fundingOfferNew', (data) => {
            const offer = rest.parseFundingOffer(data);
            if (offer) {
                const cur = offer.symbol.replace('f', '');
                if (this.state.activeOffers[cur]) {
                    this.state.activeOffers[cur].push(offer);
                    db.saveOffer({
                        id: offer.id, currency: cur, amount: Math.abs(offer.amount),
                        rate: offer.rate, period: offer.period, status: 'active',
                    });
                }
            }
        });

        // Funding Offer 取消
        bfxWs.on('fundingOfferCancel', (data) => {
            const offer = rest.parseFundingOffer(data);
            if (offer) {
                const cur = offer.symbol.replace('f', '');
                if (this.state.activeOffers[cur]) {
                    this.state.activeOffers[cur] = this.state.activeOffers[cur].filter((o) => o.id !== offer.id);
                    db.closeOffer(offer.id);
                }
            }
        });

        // Funding Credit 快照（已成交的放貸）
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

        // Funding Credit 新增（掛單成交）
        bfxWs.on('fundingCreditNew', (data) => {
            const credit = rest.parseFundingCredit(data);
            if (credit) {
                const cur = credit.symbol.replace('f', '');
                if (this.state.activeCredits[cur]) {
                    this.state.activeCredits[cur].push(credit);
                    db.saveLoan({
                        id: credit.id, currency: cur, amount: Math.abs(credit.amount),
                        rate: credit.rate, period: credit.period, status: 'active',
                    });
                    const amount = Math.abs(credit.amount);
                    logger.info('engine', `🎉 新放貸成交 ${cur} ${amount} @ ${(credit.rate * 100).toFixed(4)}%/天，期限 ${credit.period} 天`);
                    
                    // --- Telegram 成交通知合併機制 ---
                    if (!this._tradeBuffer[cur]) {
                        this._tradeBuffer[cur] = { amount: 0, rate: credit.rate, period: credit.period, timerId: null };
                    }
                    
                    // 累加金額
                    this._tradeBuffer[cur].amount += amount;
                    // 更新為最新的利率與期限（通常同一批成交的利率會相同）
                    this._tradeBuffer[cur].rate = credit.rate;
                    this._tradeBuffer[cur].period = credit.period;

                    // 如果已有計時器，先清除
                    if (this._tradeBuffer[cur].timerId) {
                        clearTimeout(this._tradeBuffer[cur].timerId);
                    }

                    // 設定 5 秒後發送合併通知
                    this._tradeBuffer[cur].timerId = setTimeout(() => {
                        const { sendTradeNotification } = require('../telegram');
                        const buffered = this._tradeBuffer[cur];
                        if (buffered && buffered.amount > 0) {
                            sendTradeNotification(cur, buffered.amount, buffered.rate, buffered.period);
                            logger.info('engine', `📢 已發送合併成交通知: ${cur} 總計 ${buffered.amount.toFixed(2)}`);
                            // 清空緩衝區
                            delete this._tradeBuffer[cur];
                        }
                    }, 5000); 
                }
            }
        });

        // Funding Credit 關閉（貸款到期）— 複利模式支援
        bfxWs.on('fundingCreditClose', (data) => {
            const credit = rest.parseFundingCredit(data);
            if (credit) {
                const cur = credit.symbol.replace('f', '');
                if (this.state.activeCredits[cur]) {
                    this.state.activeCredits[cur] = this.state.activeCredits[cur].filter((c) => c.id !== credit.id);
                    const rawInterest = Math.abs(credit.amount) * credit.rate * credit.period;
                    const interestEarned = rawInterest * 0.85; // 扣除 Bitfinex 15% 手續費
                    db.closeLoan(credit.id, interestEarned);
                    db.saveEarning({
                        currency: cur, amount: interestEarned, rate: credit.rate, period: credit.period,
                    });
                    this.state.stats.totalEarned[cur] = (this.state.stats.totalEarned[cur] || 0) + interestEarned;
                    logger.info('engine', `💰 放貸到期 ${cur}，賺取利息(稅後): ${interestEarned.toFixed(4)}`);

                    // 方案 B：複利模式 — 使用防抖即刻掛單（取代固定 3 秒延遲）
                    if (this.compoundingEnabled && this.running && !this.paused) {
                        logger.info('engine', `♻️ 複利模式：${cur} 到期資金將即刻重掛`);
                        this._debouncedDecision(cur, 2000);
                    }
                }
            }
        });

        // Funding Loan 快照 (未被使用的放貸，例如對方借走但尚未開倉)
        bfxWs.on('fundingLoanSnapshot', (data) => {
            if (Array.isArray(data)) {
                for (const l of data) {
                    const loan = rest.parseFundingCredit(l); // Loans 與 Credits 的 API 回傳結構完全相同
                    if (loan && loan.side === 1) { // 僅保留我們提供的放貸 (side === 1)
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

        // Funding Loan 新增 (放貸成交，但借款人尚未開倉使用)
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
                        });
                        const amount = Math.abs(loan.amount);
                        logger.info('engine', `🎉 新放貸成交 (對方尚未開倉) ${cur} ${amount} @ ${(loan.rate * 100).toFixed(4)}%/天，期限 ${loan.period} 天`);
                        
                        // 發送成交通知
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
                                sendTradeNotification(cur, buffered.amount, buffered.rate, buffered.period);
                                logger.info('engine', `📢 已發送合併成交通知 (對方尚未開倉): ${cur} 總計 ${buffered.amount.toFixed(2)}`);
                                delete this._tradeBuffer[cur];
                            }
                        }, 5000);
                    }
                }
            }
        });

        // Funding Loan 關閉 (有可能是被借款人開倉轉移成 Credit，也有可能是合約結束/還款)
        bfxWs.on('fundingLoanClose', (data) => {
            const loan = rest.parseFundingCredit(data);
            if (loan && loan.side === 1) {
                const cur = loan.symbol.replace('f', '');
                if (this.state.activeCredits[cur]) {
                    this.state.activeCredits[cur] = this.state.activeCredits[cur].filter((c) => c.id !== loan.id);
                    // 寫入 DB 關閉
                    const rawInterest = Math.abs(loan.amount) * loan.rate * loan.period;
                    const interestEarned = rawInterest * 0.85;
                    db.closeLoan(loan.id, interestEarned);
                    logger.info('engine', `🔄 放貸合約 (Loan) 結束或狀態移轉 #${loan.id}`);
                }
            }
        });

        // 重連失敗
        bfxWs.on('reconnectFailed', () => {
            logger.error('engine', '❌ WebSocket 重連失敗，暫停放貸');
            this.pause('WebSocket 重連失敗');
        });

        // 維護模式
        bfxWs.on('maintenance', (active) => {
            if (active) {
                this.pause('Bitfinex 維護中');
            } else {
                this.resume();
            }
        });
    }

    /**
     * 載入持久化設定
     */
    async _loadSettings() {
        try {
            const strategy = getStrategyEngine();
            
            // 1. 載入策略模式
            const mode = await db.getSetting('strategy_mode');
            if (mode) strategy.setMode(mode);

            // 2. 載入複利設定
            const compounding = await db.getSetting('compounding');
            if (compounding !== null) this.compoundingEnabled = compounding === 'true';

            // 3. 載入自動轉帳設定
            const autoTransfer = await db.getSetting('auto_transfer');
            const threshold = await db.getSetting('auto_transfer_threshold');
            if (autoTransfer !== null) this.autoTransferEnabled = autoTransfer === 'true';
            if (threshold !== null) this.autoTransferThreshold = parseFloat(threshold);

            // 4. 載入暫停狀態
            const paused = await db.getSetting('engine_paused');
            const reason = await db.getSetting('pause_reason');
            if (paused === 'true') {
                this.paused = true;
                this.pauseReason = reason || '上次運行的暫停狀態';
            }

            logger.info('engine', '✅ 持久化設定已載入', {
                mode: strategy.mode,
                compounding: this.compoundingEnabled,
                autoTransfer: this.autoTransferEnabled,
                paused: this.paused
            });
        } catch (err) {
            logger.error('engine', '載入持久化設定失敗', { error: err.message });
        }
    }

    /**
     * 初始載入帳戶狀態
     */
    async _loadInitialState() {
        try {
            // 載入錢包
            const wallets = await rest.getWallets();
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

            // 載入現有掛單和放貸
            for (const currency of config.lending.currencies) {
                try {
                    const offers = await rest.getActiveFundingOffers(currency);
                    if (Array.isArray(offers)) {
                        this.state.activeOffers[currency] = offers.map(rest.parseFundingOffer).filter(Boolean);
                    }

                    // 同步載入已使用放貸 (Credits) 與未使用放貸 (Loans) 合約
                    const [credits, loans] = await Promise.all([
                        rest.getActiveFundingCredits(currency),
                        rest.getActiveFundingLoans(currency),
                    ]);

                    const parsedCredits = Array.isArray(credits)
                        ? credits.map(rest.parseFundingCredit).filter(c => c && c.side === 1)
                        : [];
                    
                    const parsedLoans = Array.isArray(loans)
                        ? loans.map(rest.parseFundingCredit).filter(l => l && l.side === 1)
                        : [];

                    // 合併兩者，並過濾掉任何非我們出借的合約 (side === 1)
                    this.state.activeCredits[currency] = [...parsedCredits, ...parsedLoans];
                } catch (err) {
                    logger.error('engine', `載入 ${currency} 資料失敗`, { error: err.message });
                }
            }

            logger.info('engine', '帳戶狀態已載入', {
                wallets: this.state.wallets,
                offersCount: Object.values(this.state.activeOffers).reduce((s, a) => s + a.length, 0),
                creditsCount: Object.values(this.state.activeCredits).reduce((s, a) => s + a.length, 0),
            });
        } catch (err) {
            logger.error('engine', '載入初始狀態失敗', { error: err.message });
        }
    }

    /**
     * 核心決策週期（每 10 秒執行一次）
     */
    async _decisionCycle() {
        if (!this.running || this.paused) return;

        const bfxWs = getBitfinexWS();
        if (!bfxWs.isConnected() || !bfxWs.isAuthenticated()) return;

        const strategy = getStrategyEngine();

        for (const currency of config.lending.currencies) {
            try {
                // 定期檢查閒置資金：如果可用餘額大於最小掛單金額，強制執行決策
                const available = this.state.wallets[currency]?.available || 0;
                if (available >= config.lending.minOfferAmount) {
                    logger.debug('engine', `${currency} 定期檢查：發現可用餘額 ${available.toFixed(2)}，執行掛單決策`);
                    await this._processForCurrency(currency, bfxWs, strategy);
                } else {
                    await this._processForCurrency(currency, bfxWs, strategy);
                }
            } catch (err) {
                logger.error('engine', `${currency} 決策週期錯誤`, { error: err.message });
            }
        }

        this.state.stats.lastUpdate = Date.now();
    }

    /**
     * 處理單一幣種的放貸決策
     */
    async _processForCurrency(currency, bfxWs, strategy) {
        const marketData = bfxWs.getMarketData(currency);
        if (!marketData || !marketData.lastUpdate) return;

        // 檢查是否應該暫停
        const pauseCheck = strategy.shouldPause(marketData);
        if (pauseCheck.pause) {
            logger.debug('engine', `${currency}: 暫時跳過 - ${pauseCheck.reason}`);
            return;
        }

        // 利率飆升捕捉：檢查是否需要取消低利率掛單
        const spikeOffers = strategy.detectRateSpike(marketData, this.state.activeOffers[currency]);
        for (const { offer, reason, newRate } of spikeOffers) {
            logger.info('engine', `📈 ${currency} 利率飆升偵測: ${reason}`);
            try {
                await rest.cancelFundingOffer(offer.id);
                this.state.stats.offersCancelled++;
                // 新掛單將在下方自動處理
            } catch (err) {
                logger.error('engine', `取消掛單 #${offer.id} 失敗`, { error: err.message });
            }
        }

        // 計算可用金額（v2: 不預留資金，全額使用）
        const available = this.state.wallets[currency]?.available || 0;

        // 🌟 即使可用金額不足，我們依然使用名義上的最小金額來進行市場出清與 3D Hybrid 決策計算！
        // 這能確保系統即使在資金全數出借時，依然能在 Telegram 與 Dashboard 上精確顯示最新的決策與市場診斷指標！
        const nominalAvailable = Math.max(available, config.lending.minOfferAmount || 150);

        // 計算最佳掛單策略
        const optimalResult = strategy.calculateOptimalRate(marketData, currency, nominalAvailable);

        // 記錄決策（任何時候都要記錄，才能讓 Telegram 與前端 Dashboard 顯示最新決策診斷！）
        this.state.lastDecision[currency] = {
            timestamp: Date.now(),
            frr: marketData.frr,
            optimalResult,
            available,
        };

        if (available < config.lending.minOfferAmount) {
            return; // 資金不足掛單，在記錄完市場診斷後優雅退出
        }

        if (!optimalResult.shouldOffer) {
            logger.debug('engine', `${currency}: 不掛單 - ${optimalResult.reason}`);
            return;
        }

        // 記錄決策診斷數據（供 AI 訓練）
        if (optimalResult.diagnostics) {
            db.saveLog('debug', 'strategy-decision',
                `${currency}: ${optimalResult.reason}`,
                optimalResult.diagnostics
            );
        }

        // 執行 500 USD 固定網格掛單
        for (const order of optimalResult.orders) {
            if (order.amount < config.lending.minOfferAmount) continue;

            try {
                await rest.submitFundingOffer(
                    currency,
                    order.amount,
                    order.rate,
                    order.period
                );
                this.state.stats.offersPlaced++;
                logger.info('engine', `📝 掛單 ${currency} $${order.amount.toFixed(0)} @ ${(order.rate * 100).toFixed(4)}%/天 (年化${(order.rate * 365 * 100).toFixed(2)}%)，${order.period}天`);
            } catch (err) {
                // 如果是餘額不足錯誤，不發送 Telegram 警報（因為這通常是短暫的同步問題）
                const isBalanceError = err.message.includes('not enough') || err.message.includes('balance');
                const errorMsg = `❌ 掛單失敗 ${currency}: $${order.amount.toFixed(0)} @ ${(order.rate * 100).toFixed(4)}%/天, 錯誤: ${err.message}`;
                
                logger.error('engine', errorMsg);
                
                if (!isBalanceError) {
                    // 只有非餘額錯誤才發送 Telegram 警報
                    try {
                        const { sendAlert } = require('../telegram');
                        if (sendAlert) {
                            sendAlert('🚨 掛單失敗', errorMsg);
                        }
                    } catch (e) {
                        logger.error('engine', '發送掛單失敗警報失敗');
                    }
                } else {
                    logger.warn('engine', `跳過餘額不足警報，將在下個週期自動重試`);
                }
            }
        }
    }

    /**
     * 檢查並清理過期的 offer ID 記錄
     */
    _cleanupOfferRecords() {
        for (const currency of config.lending.currencies) {
            const activeOffers = this.state.activeOffers[currency] || [];
            const currentOfferIds = new Set(activeOffers.map(o => o.id));
            
            // 清理 _offerReoffered，避免記憶體洩漏
            for (const id of this._offerReoffered) {
                if (!currentOfferIds.has(id)) {
                    this._offerReoffered.delete(id);
                }
            }
        }
    }

    /**
     * 檢查並自動降息重掛（每 3 小時未成交，利率 * 0.96，保底年化 12%）
     */
    async _checkAndReofferTimeoutOffers() {
        // ⏱️ 自動降息重掛功能已依指示關閉，直接返回不執行
        return;

        // 先執行清理
        this._cleanupOfferRecords();

        const now = Date.now();
        const reofferTimeoutMs = 3 * 60 * 60 * 1000; // 3 小時
        const minDailyRate = 0.12 / 365; // 年化 12% 對應的日利率

        for (const currency of config.lending.currencies) {
            const activeOffers = this.state.activeOffers[currency] || [];
            
            for (const offer of activeOffers) {
                const createdAt = new Date(offer.createdAt).getTime();
                const durationMs = now - createdAt;

                // 如果超過 3 小時且尚未在當前週期處理過
                if (durationMs >= reofferTimeoutMs && !this._offerReoffered.has(offer.id)) {
                    const oldRate = offer.rate;
                    let newRate = oldRate * 0.96; // 利率 * 0.96

                    // 保底年化 12%
                    if (newRate < minDailyRate) {
                        if (oldRate <= minDailyRate) {
                            // 如果舊利率已經低於或等於保底利率，則不再調整
                            continue;
                        }
                        newRate = minDailyRate;
                    }

                    const amount = Math.abs(offer.amount);
                    const period = offer.period || 2;

                    logger.info('engine', `🔄 自動降息重掛: ${currency} #${offer.id} 已掛單 ${Math.floor(durationMs / 60000)} 分鐘，將利率從 ${(oldRate * 100).toFixed(4)}% 調降至 ${(newRate * 100).toFixed(4)}%`);

                    try {
                        // 1. 取消舊掛單
                        await rest.cancelFundingOffer(offer.id);
                        
                        // 2. 提交新掛單
                        await rest.submitFundingOffer(currency, amount, newRate, period);
                        
                        // 3. 記錄已處理，避免重複
                        this._offerReoffered.add(offer.id);

                        // 4. 發送 Telegram 通知
                        const { sendReofferNotification } = require('../telegram');
                        if (sendReofferNotification) {
                            const isFloor = newRate <= minDailyRate;
                            await sendReofferNotification(currency, amount, oldRate, newRate, period, isFloor);
                        }
                    } catch (err) {
                        logger.error('engine', `自動降息重掛失敗: ${currency} #${offer.id}`, { error: err.message });
                    }
                }
            }
        }
    }

    /**
     * 收集利率數據（用於歷史分析和回測）
     * v3: 同步收集 IBRR 快照供 ML 訓練
     */
    async _collectRateData() {
        const bfxWs = getBitfinexWS();
        const strategy = getStrategyEngine();

        for (const currency of config.lending.currencies) {
            const marketData = bfxWs.getMarketData(currency);
            if (!marketData || !marketData.lastUpdate) continue;

            const available = this.state.wallets[currency]?.available || 0;
            const optimalResult = strategy.calculateOptimalRate(marketData, currency, available);

            const snapshot = {
                currency,
                frr: marketData.frr,
                avgRate: marketData.lastPrice,
                highRate: marketData.high,
                lowRate: marketData.low,
                volume: marketData.volume,
                bidDepth: marketData.bidSize,
                askDepth: marketData.askSize,
                demandSupplyRatio: marketData.bidSize / (marketData.askSize || 1),
                activeOffersCount: this.state.activeOffers[currency]?.length || 0,
                activeCreditsCount: this.state.activeCredits[currency]?.length || 0,
                walletBalance: this.state.wallets[currency]?.balance || 0,
            };

            await db.saveRateSnapshot(snapshot);

            // 儲存 IBRR 快照
            if (optimalResult.diagnostics) {
                await db.saveIBRRSnapshot({
                    currency,
                    ibrr: optimalResult.diagnostics.ibrrRate,
                    equilibriumRate: optimalResult.diagnostics.equilibriumRate,
                    frr: marketData.frr,
                    frrTrend: optimalResult.diagnostics.frrTrend,
                    riskLevel: optimalResult.diagnostics.riskLevel,
                    demandSupplyRatio: optimalResult.diagnostics.demandSupplyRatio,
                    totalDemand: optimalResult.diagnostics.totalDemand,
                    totalSupply: optimalResult.diagnostics.totalSupply,
                    wallDetected: optimalResult.diagnostics.wallDetected,
                    wallRate: optimalResult.diagnostics.wallRate,
                    bestBidRate: marketData.bid,
                    bestAskRate: marketData.ask,
                    lastPrice: marketData.lastPrice,
                    method: optimalResult.diagnostics.method,
                });
            }
        }
    }

    /**
     * 更新歷史 FRR 均值
     */
    async _updateHistoricalFRR() {
        const strategy = getStrategyEngine();
        for (const cur of config.lending.currencies) {
            try {
                const avg7d = await db.getAverageFRR(cur, 168);
                const avg30d = await db.getAverageFRR(cur, 720);
                if (avg7d) strategy.updateHistoricalAvg(cur, '7d', avg7d);
                if (avg30d) strategy.updateHistoricalAvg(cur, '30d', avg30d);
            } catch (err) {
                logger.error('engine', `更新 ${cur} 歷史均值失敗`, { error: err.message });
            }
        }
    }

    /**
     * 防抖執行決策
     */
    _debouncedDecision(currency, delay = 2000) {
        if (this._pendingDecisions[currency]) {
            clearTimeout(this._pendingDecisions[currency]);
        }

        this._pendingDecisions[currency] = setTimeout(async () => {
            if (!this.running || this.paused) return;
            
            const bfxWs = getBitfinexWS();
            const strategy = getStrategyEngine();
            
            try {
                await this._processForCurrency(currency, bfxWs, strategy);
            } catch (err) {
                logger.error('engine', `${currency} 防抖決策錯誤`, { error: err.message });
            }
            
            delete this._pendingDecisions[currency];
        }, delay);
    }

    getStatus() {
        const strategy = getStrategyEngine();
        const bfxWs = getBitfinexWS();
        const marketData = bfxWs.marketData || {};
        const frr = marketData.frr || 0.0003;
        
        // 動態計算 IBRR 溢價差值 Delta
        let frrDelta = 0;
        if (frr > 0) {
            const usdHistory = strategy.ibrrHistory['USD'];
            if (usdHistory && usdHistory.length > 0) {
                const latestIbrr = usdHistory[usdHistory.length - 1].ibrr;
                frrDelta = (latestIbrr - frr) / frr;
            }
        }

        const strategyStatus = strategy.getStatus();
        // 注入並包裝前端 StrategyPanel 期待的完全對齊特徵
        strategyStatus.config = {
            ...strategyStatus.config,
            frrDelta: frrDelta,
            orderUnit: 500,
            defaultPeriod: '自適應 (2-30天)',
            reserveRatio: 0
        };
        // 為了相容，同時返回 balanced 作為前端當前模式
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
            connected: bfxWs.isConnected(),
            authenticated: bfxWs.isAuthenticated(),
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
            marketData: bfxWs.marketData,
            // 🌟 深度整合，點亮前端介面的數據指標
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

let engine = null;

function getLendingEngine() {
    if (!engine) {
        engine = new LendingEngine();
    }
    return engine;
}

module.exports = {
    getLendingEngine,
};

