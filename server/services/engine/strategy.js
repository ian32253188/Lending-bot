"use strict";
/**
 * =========================================================================
 * 🌌 自適應放貸策略引擎 (TypeScript Production Edition)
 *
 * 融合技術：
 * 1. 瓦爾拉斯出清 IBRR 引擎 (地基)
 * 2. Harmonia 10分鐘誠信時間戳過濾 (防莊家高頻釣魚假單 Spoofing)
 * 3. 依使用者選擇的利率基準計算單筆掛單利率
 * 4. 全部可用餘額以一筆掛單投入，並使用所選期限
 * =========================================================================
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategyEngine = void 0;
exports.getStrategyEngine = getStrategyEngine;
const logger = __importStar(require("../../utils/logger"));
// ML Predictor is currently loaded but is not actively used in the simplified balanced strategy.
const ml_predictor_1 = require("./ml-predictor");
const VALID_RATE_STRATEGIES = ['current_avg', 'high_24h', 'high_30d'];
const VALID_PERIOD_DAYS = [2, 10, 30, 60, 90, 120];
class StrategyEngine {
    mode;
    customOverrides;
    historicalFRR;
    ibrrHistory;
    constructor() {
        // 保留唯一的自適應放貸策略 (對齊前端 balanced id)
        this.mode = 'balanced';
        this.customOverrides = {};
        this.historicalFRR = {};
        this.ibrrHistory = {};
    }
    /**
     * 獲取放貸策略預設配置，並融入用戶的自定義覆寫
     */
    getStrategyConfig() {
        return {
            rateStrategy: 'current_avg',
            periodDays: 2,
            useAllAvailable: true,
            ...this.customOverrides,
        };
    }
    /**
     * 保留唯一的自適應放貸策略，拒絕切換到其他舊模式
     */
    setMode(mode) {
        logger.info('strategy', `策略已鎖定為自適應放貸，忽略切換請求至: ${mode}`);
    }
    /**
     * 更新歷史 FRR 均值 (解決 lending.js 呼叫 updateHistoricalAvg 報錯的問題)
     */
    updateHistoricalAvg(currency, type, rate) {
        if (!this.historicalFRR[currency]) {
            this.historicalFRR[currency] = {};
        }
        if (typeof this.historicalFRR[currency] !== 'object') {
            this.historicalFRR[currency] = {};
        }
        this.historicalFRR[currency][type] = rate;
        // 這是週期性快取更新，不需要寫入 operation_logs；保留 debug 供需要時追蹤。
        logger.debug('strategy', `📊 更新 ${currency} 歷史平均 FRR (${type}): ${(rate * 100).toFixed(4)}%`);
    }
    /**
     * 設定歷史 FRR 均值 (相容性保留)
     */
    setHistoricalFRR(currency, avgFRR) {
        if (typeof avgFRR === 'object') {
            this.historicalFRR[currency] = { ...this.historicalFRR[currency], ...avgFRR };
        }
        else {
            if (typeof this.historicalFRR[currency] !== 'object') {
                this.historicalFRR[currency] = {};
            }
            this.historicalFRR[currency]['24h'] = avgFRR;
            this.historicalFRR[currency]['7d'] = avgFRR;
        }
    }
    /**
     * 🎯 計算 IBRR — 融入 Harmonia 10 分鐘誠信過濾
     */
    calculateIBRR(marketData, riskLevel = 5, currency = '') {
        const rawAsks = [...(marketData.asks || [])].sort((a, b) => a.rate - b.rate);
        const rawBids = [...(marketData.bids || [])].sort((a, b) => b.rate - a.rate);
        const frr = marketData.frr || 0;
        if (rawAsks.length === 0 || rawBids.length === 0) {
            return {
                ibrr: frr,
                equilibriumRate: frr,
                riskLevel,
                frrTrend: 'stable',
                mlPrediction: null,
                totalDemand: 0,
                totalSupply: 0,
                demandSupplyRatio: 1,
                wallInfo: { hasWall: false },
                method: 'fallback_frr',
            };
        }
        // 🛡️ Harmonia 10分鐘誠信過濾 (Age Filter)
        const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
        const asks = rawAsks.filter(ask => {
            if (ask.timestamp && ask.timestamp > tenMinutesAgo) {
                logger.debug('strategy', `🧱 誠信過濾：剔除潛在的莊家高頻釣魚假單 asks rate=${(ask.rate * 100).toFixed(4)}%`);
                return false;
            }
            return true;
        });
        const bids = rawBids.filter(bid => {
            if (bid.timestamp && bid.timestamp > tenMinutesAgo) {
                logger.debug('strategy', `🧱 誠信過濾：剔除潛在的莊家高頻釣魚假單 bids rate=${(bid.rate * 100).toFixed(4)}%`);
                return false;
            }
            return true;
        });
        const activeAsks = asks.length > 0 ? asks : rawAsks;
        const activeBids = bids.length > 0 ? bids : rawBids;
        const totalDemand = activeBids.reduce((sum, b) => sum + b.amount, 0);
        const totalSupply = activeAsks.reduce((sum, a) => sum + a.amount, 0);
        // 模擬瓦爾拉斯市場出清
        let cumulativeSupply = 0;
        let equilibriumRate = activeAsks[0].rate;
        let equilibriumFound = false;
        for (const ask of activeAsks) {
            cumulativeSupply += ask.amount;
            if (cumulativeSupply >= totalDemand) {
                equilibriumRate = ask.rate;
                equilibriumFound = true;
                break;
            }
            equilibriumRate = ask.rate;
        }
        if (!equilibriumFound) {
            const highestBid = activeBids[0].rate;
            equilibriumRate = Math.max(equilibriumRate, highestBid);
        }
        // 檢測大資金阻力牆 (用未過濾數據，確保阻力牆判斷的物理完整性)
        const wallInfo = this._detectRateWall(rawAsks, rawAsks.reduce((s, a) => s + a.amount, 0));
        let ibrr = equilibriumRate;
        // 繞過大阻力牆，搶先在莊家巨牆前 2% 利率插隊成交
        if (wallInfo.hasWall && wallInfo.wallRate !== undefined && ibrr < wallInfo.wallRate) {
            ibrr = wallInfo.wallRate * 0.98;
            logger.debug('strategy', `🧱 IBRR 觸發阻力牆繞道：原出清點=${(equilibriumRate * 100).toFixed(4)}% -> 避讓掛單點=${(ibrr * 100).toFixed(4)}%`);
        }
        if (currency) {
            if (!this.ibrrHistory[currency])
                this.ibrrHistory[currency] = [];
            this.ibrrHistory[currency].push({ ibrr, timestamp: Date.now() });
            if (this.ibrrHistory[currency].length > 120) {
                this.ibrrHistory[currency] = this.ibrrHistory[currency].slice(-60);
            }
        }
        const result = {
            ibrr,
            equilibriumRate,
            riskLevel,
            frrTrend: this._detectFRRTrend(marketData),
            mlPrediction: null,
            totalDemand,
            totalSupply,
            demandSupplyRatio: totalSupply > 0 ? totalDemand / totalSupply : 999,
            wallInfo,
            equilibriumFound,
            method: 'ibrr_3d_hybrid',
        };
        logger.debug('strategy', `🎯 IBRR ${currency} (3D Hybrid): ${(ibrr * 100).toFixed(4)}%/天 ` +
            `(均衡=${(equilibriumRate * 100).toFixed(4)}%, FRR=${(frr * 100).toFixed(4)}%, ` +
            `真實供需比=${result.demandSupplyRatio.toFixed(2)})`);
        return result;
    }
    /**
     * 計算最佳掛單方案
     */
    calculateOptimalRate(marketData, currency, availableAmount, userConfig = {}) {
        const mergedConfig = { ...this.getStrategyConfig(), ...userConfig };
        const stratConfig = {
            ...mergedConfig,
            rateStrategy: VALID_RATE_STRATEGIES.includes(mergedConfig.rateStrategy)
                ? mergedConfig.rateStrategy
                : 'current_avg',
            periodDays: VALID_PERIOD_DAYS.includes(Number(mergedConfig.periodDays))
                ? Number(mergedConfig.periodDays)
                : 2,
            useAllAvailable: true,
        };
        const result = {
            orders: [],
            shouldOffer: false,
            reason: '',
            currency,
            diagnostics: {},
        };
        if (!marketData) {
            result.reason = '無市場數據';
            return result;
        }
        const frr = Number(marketData.frr) || 0;
        const asks = marketData.asks || [];
        const bids = marketData.bids || [];
        const ibrrResult = this.calculateIBRR(marketData, 5, currency);
        const ibrrRate = ibrrResult.ibrr;
        const referenceRate = this._getReferenceRate(marketData, stratConfig);
        if (!Number.isFinite(referenceRate) || referenceRate <= 0) {
            result.reason = '所選利率基準目前無有效數據';
            return result;
        }
        // 掛單利率直接採用使用者選取的市場基準，不加 FRR、最低或最高利率修正。
        const baseRate = referenceRate;
        result.diagnostics = {
            frr,
            frrRate: frr,
            referenceRate,
            rateStrategy: stratConfig.rateStrategy,
            periodDays: stratConfig.periodDays,
            useAllAvailable: true,
            ibrrRate,
            equilibriumRate: ibrrResult.equilibriumRate,
            finalRate: baseRate,
            demandSupplyRatio: ibrrResult.demandSupplyRatio,
            wallDetected: ibrrResult.wallInfo.hasWall,
            wallRate: ibrrResult.wallInfo.wallRate,
            wallAmount: ibrrResult.wallInfo.wallAmount,
            askDepth: asks.length,
            bidDepth: bids.length,
            totalAskVolume: asks.reduce((s, a) => s + (a.amount || 0), 0),
            totalBidVolume: bids.reduce((s, b) => s + (b.amount || 0), 0),
            bestAsk: asks.length > 0 ? asks[0].rate : null,
            bestBid: bids.length > 0 ? bids[0].rate : null,
            mode: this.mode,
            method: ibrrResult.method,
            timestamp: Date.now(),
        };
        // 依選定的利率基準與期限，把全部可用餘額放在同一筆掛單
        result.orders = this._calculateSingleOrder(availableAmount, baseRate, marketData, stratConfig, currency);
        result.shouldOffer = result.orders.length > 0;
        result.reason = result.shouldOffer
            ? `直接採用基準(${stratConfig.rateStrategy}): ${(baseRate * 100).toFixed(4)}%, 期限: ${stratConfig.periodDays}天`
            : '可用餘額必須大於 150 USD 才會掛單';
        return result;
    }
    _getReferenceRate(marketData, stratConfig) {
        const candidates = {
            current_avg: marketData.currentTradeAvg,
            high_24h: marketData.high24h,
            high_30d: marketData.high30d,
        };
        const candidate = Number(candidates[stratConfig.rateStrategy || 'current_avg']);
        return Number.isFinite(candidate) && candidate > 0 ? candidate : 0;
    }
    /**
     * 期限自適應選擇器
     */
    _selectPeriod(rate, marketData, stratConfig, currency) {
        if (VALID_PERIOD_DAYS.includes(Number(stratConfig.periodDays))) {
            return Number(stratConfig.periodDays);
        }
        const frr = marketData.frr || 0.0001;
        const consensusBaseDays = marketData.durationLend || 6;
        if (rate <= frr) {
            return 2;
        }
        const premiumRatio = (rate - frr) / frr;
        const calculatedDays = Math.floor(consensusBaseDays + premiumRatio * 20);
        return Math.max(2, Math.min(30, calculatedDays));
    }
    /**
     * 以全部可用餘額建立單筆掛單
     */
    _calculateSingleOrder(totalAmount, rate, marketData, stratConfig, currency) {
        if (!Number.isFinite(totalAmount) || totalAmount <= 150)
            return [];
        return [{
                amount: totalAmount,
                rate,
                period: this._selectPeriod(rate, marketData, stratConfig, currency),
                tag: 'strategy_single',
            }];
    }
    /**
     * 利率飆升偵測 (與 3D_Hybrid 對齊)
     */
    detectRateSpike(marketData, currentOffers) {
        if (!marketData || !currentOffers || currentOffers.length === 0)
            return [];
        const toReplace = [];
        const ibrrResult = this.calculateIBRR(marketData, 5);
        const currentIBRR = ibrrResult.ibrr;
        for (const offer of currentOffers) {
            const offerRate = offer.rate || offer.Rate;
            if (currentIBRR > offerRate * 1.2) {
                toReplace.push({
                    offer,
                    reason: `IBRR (${(currentIBRR * 100).toFixed(4)}%) 大幅高於掛單利率 (${(offerRate * 100).toFixed(4)}%)`,
                    newRate: currentIBRR,
                });
            }
        }
        return toReplace;
    }
    /**
     * 極端行情暫停檢查 (保留相容性)
     */
    shouldPause(marketData) {
        return { pause: false };
    }
    /**
     * FRR 趨勢偵測
     */
    _detectFRRTrend(marketData) {
        const frr = marketData.frr || 0;
        const bids = marketData.bids || [];
        const asks = marketData.asks || [];
        const bestBid = bids.length > 0 ? bids[0].rate : 0;
        const bestAsk = asks.length > 0 ? asks[0].rate : 0;
        if (!frr || !bestBid)
            return 'stable';
        const bidFrrRatio = bestBid / frr;
        const totalBidVol = bids.reduce((s, b) => s + (b.amount || 0), 0);
        const totalAskVol = asks.reduce((s, a) => s + (a.amount || 0), 0);
        const volumeImbalance = totalAskVol > 0 ? totalBidVol / totalAskVol : 1;
        const spread = bestAsk - bestBid;
        const spreadRatio = frr > 0 ? spread / frr : 0;
        let score = 0;
        if (bidFrrRatio > 1.15)
            score += 2;
        else if (bidFrrRatio > 1.05)
            score += 1;
        else if (bidFrrRatio < 0.85)
            score -= 2;
        else if (bidFrrRatio < 0.95)
            score -= 1;
        if (volumeImbalance > 1.5)
            score += 1;
        else if (volumeImbalance < 0.5)
            score -= 1;
        if (spreadRatio < 0.05 && bidFrrRatio > 1.05)
            score += 1;
        if (score >= 2)
            return 'rising';
        if (score <= -2)
            return 'falling';
        return 'stable';
    }
    /**
     * 檢測大資金阻力牆
     */
    _detectRateWall(asks, totalVolume) {
        if (!asks || asks.length === 0 || totalVolume <= 0) {
            return { hasWall: false };
        }
        const sortedAsks = [...asks].sort((a, b) => a.rate - b.rate);
        for (const ask of sortedAsks) {
            const percentage = ask.amount / totalVolume;
            if (percentage > 0.25) {
                return {
                    hasWall: true,
                    wallRate: ask.rate,
                    wallAmount: ask.amount,
                    wallPercentage: percentage,
                };
            }
        }
        return { hasWall: false };
    }
    /**
     * 獲取狀態結構
     */
    getStatus() {
        const mlPredictor = (0, ml_predictor_1.getMLPredictor)();
        return {
            mode: this.mode,
            config: this.getStrategyConfig(),
            historicalFRR: this.historicalFRR,
            ibrrHistory: Object.fromEntries(Object.entries(this.ibrrHistory).map(([k, v]) => [k, v.slice(-5)])),
            mlPredictor: mlPredictor.getStatus(),
        };
    }
}
exports.StrategyEngine = StrategyEngine;
let instance = null;
function getStrategyEngine() {
    if (!instance) {
        instance = new StrategyEngine();
    }
    return instance;
}
