const logger = require('../../utils/logger');
const path = require('path');
const fs = require('fs');

/**
 * ML 利率預測器
 * 
 * 使用簡易神經網路模型預測短期利率走勢，增強 IBRR 計算的準確度。
 * 
 * 模型架構：
 * - 輸入：近 N 個時間點的市場特徵向量
 * - 輸出：預測的利率方向與幅度
 * 
 * 特徵工程：
 * - FRR、bestBid、bestAsk、spread、供需比、volume
 * - 利率變化率（momentum）
 * - 訂單簿不平衡度（order book imbalance）
 * 
 * 階段：
 * Phase 1 (當前)：基於統計的輕量預測（不需要 TensorFlow）
 * Phase 2 (未來)：可接入 TensorFlow.js / ONNX 模型
 */
class MLPredictor {
    constructor() {
        // 滑動視窗：最近 N 筆市場快照
        this.windowSize = 60;  // 保留 60 個快照（10秒一次 = 10分鐘歷史）
        this.historyBuffer = {};  // { currency: [snapshot, ...] }

        // 模型權重（Phase 1: 手動調整；Phase 2: 從檔案載入訓練好的權重）
        this.weights = {
            momentum: 0.35,        // 利率動量
            orderBookImbalance: 0.25, // 訂單簿不平衡度
            volumeTrend: 0.15,     // 成交量趨勢
            spreadSignal: 0.15,    // 價差信號
            frrDeviation: 0.10,    // FRR 偏離度
        };

        // 外部 ML 模型（Phase 2）
        this.externalModel = null;
        this.modelLoaded = false;

        logger.info('ml-predictor', '📊 ML 預測器已初始化（Phase 1: 統計模型）');
    }

    /**
     * 推送最新市場快照到歷史緩衝區
     * @param {string} currency 
     * @param {Object} marketData 
     */
    pushSnapshot(currency, marketData) {
        if (!this.historyBuffer[currency]) {
            this.historyBuffer[currency] = [];
        }

        const snapshot = this._extractFeatures(marketData);
        if (!snapshot) return;

        this.historyBuffer[currency].push(snapshot);

        // 維持視窗大小
        if (this.historyBuffer[currency].length > this.windowSize) {
            this.historyBuffer[currency].shift();
        }
    }

    /**
     * 預測利率走勢
     * @param {string} currency 
     * @param {Object} currentMarketData - 當前市場數據
     * @returns {{ direction: 'rising'|'falling'|'stable', confidence: number, predictedDelta: number, features: Object }}
     */
    predict(currency, currentMarketData) {
        const history = this.historyBuffer[currency] || [];

        if (history.length < 5) {
            return {
                direction: 'stable',
                confidence: 0,
                predictedDelta: 0,
                features: {},
                reason: '歷史數據不足（需至少 5 筆快照）',
            };
        }

        // 如果有外部 ML 模型，優先使用
        if (this.externalModel && this.modelLoaded) {
            return this._predictWithExternalModel(currency, currentMarketData, history);
        }

        // Phase 1: 統計模型預測
        return this._predictWithStatModel(currency, currentMarketData, history);
    }

    /**
     * Phase 1: 基於統計特徵的預測
     */
    _predictWithStatModel(currency, currentMarketData, history) {
        const current = this._extractFeatures(currentMarketData);
        if (!current) {
            return { direction: 'stable', confidence: 0, predictedDelta: 0, features: {} };
        }

        // ---- 1. 利率動量 (Momentum) ----
        // 計算最近 5 筆的利率變化斜率
        const recentRates = history.slice(-5).map(s => s.frr);
        const momentum = this._calcLinearSlope(recentRates);
        const momentumSignal = Math.tanh(momentum * 10000); // 正規化到 [-1, 1]

        // ---- 2. 訂單簿不平衡度 (Order Book Imbalance) ----
        // OBI > 0 = 需求大於供給 → 利率上漲信號
        // OBI < 0 = 供給大於需求 → 利率下跌信號
        const obi = current.totalBidVolume - current.totalAskVolume;
        const totalVolume = current.totalBidVolume + current.totalAskVolume;
        const obiSignal = totalVolume > 0 ? obi / totalVolume : 0;

        // ---- 3. 成交量趨勢 ----
        const recentVolumes = history.slice(-5).map(s => s.volume);
        const volumeTrend = this._calcLinearSlope(recentVolumes);
        const volumeSignal = Math.tanh(volumeTrend * 0.001);

        // ---- 4. 價差信號 ----
        // spread 縮小 → 市場活躍 → 容易成交
        // spread 大 → 市場冷清
        const avgSpread = history.slice(-5).reduce((s, h) => s + h.spread, 0) / 5;
        const spreadChange = current.spread - avgSpread;
        const spreadSignal = -Math.tanh(spreadChange * 10000); // 價差縮小 = 正信號

        // ---- 5. FRR 偏離度 ----
        // bestBid 與 FRR 的偏差越大，方向信號越強
        const frrDev = current.frr > 0 ? (current.bestBid - current.frr) / current.frr : 0;
        const frrSignal = Math.tanh(frrDev * 5);

        // ---- 加權合成 ----
        const weightedScore =
            this.weights.momentum * momentumSignal +
            this.weights.orderBookImbalance * obiSignal +
            this.weights.volumeTrend * volumeSignal +
            this.weights.spreadSignal * spreadSignal +
            this.weights.frrDeviation * frrSignal;

        // 方向與信心度
        const confidence = Math.min(Math.abs(weightedScore), 1);
        let direction = 'stable';
        if (weightedScore > 0.15) direction = 'rising';
        else if (weightedScore < -0.15) direction = 'falling';

        // 預測利率變動幅度（相對於當前 FRR 的百分比變動）
        const predictedDelta = weightedScore * current.frr * 0.1;

        const features = {
            momentumSignal,
            obiSignal,
            volumeSignal,
            spreadSignal,
            frrSignal,
            weightedScore,
            historyLength: history.length,
        };

        logger.debug('ml-predictor', `${currency} 預測: ${direction} (信心=${(confidence * 100).toFixed(1)}%, score=${weightedScore.toFixed(4)})`);

        return {
            direction,
            confidence,
            predictedDelta,
            features,
            reason: `統計模型 score=${weightedScore.toFixed(4)}`,
        };
    }

    /**
     * Phase 2: 使用外部 ML 模型預測（預留介面）
     */
    _predictWithExternalModel(currency, currentMarketData, history) {
        // 將歷史特徵轉換為模型輸入張量
        const inputFeatures = history.slice(-this.windowSize).map(s => [
            s.frr, s.bestBid, s.bestAsk, s.spread,
            s.totalBidVolume, s.totalAskVolume,
            s.volume, s.demandSupplyRatio,
        ]);

        try {
            // TODO: Phase 2 接入 TensorFlow.js 或 ONNX Runtime
            // const tensor = tf.tensor3d([inputFeatures]);
            // const output = this.externalModel.predict(tensor);
            // const prediction = output.dataSync();

            logger.debug('ml-predictor', `${currency} 使用外部 ML 模型預測`);

            // 暫時回退到統計模型
            return this._predictWithStatModel(currency, currentMarketData, history);
        } catch (err) {
            logger.error('ml-predictor', `外部模型預測失敗: ${err.message}`);
            return this._predictWithStatModel(currency, currentMarketData, history);
        }
    }

    /**
     * 載入外部 ML 模型（Phase 2）
     * @param {string} modelPath - 模型檔案路徑
     */
    async loadModel(modelPath) {
        try {
            // Phase 2: 支援載入 TensorFlow.js SavedModel 或 ONNX 模型
            // const tf = require('@tensorflow/tfjs-node');
            // this.externalModel = await tf.loadLayersModel(`file://${modelPath}`);

            if (fs.existsSync(modelPath)) {
                logger.info('ml-predictor', `載入 ML 模型: ${modelPath}`);
                this.modelLoaded = true;
            } else {
                logger.warn('ml-predictor', `ML 模型檔案不存在: ${modelPath}，使用統計模型`);
            }
        } catch (err) {
            logger.error('ml-predictor', `載入 ML 模型失敗: ${err.message}`);
            this.modelLoaded = false;
        }
    }

    /**
     * 更新模型權重（在線學習或根據回測結果調整）
     * @param {Object} newWeights 
     */
    updateWeights(newWeights) {
        this.weights = { ...this.weights, ...newWeights };
        logger.info('ml-predictor', '模型權重已更新', this.weights);
    }

    /**
     * 從市場數據中提取特徵向量
     */
    _extractFeatures(marketData) {
        if (!marketData || !marketData.frr) return null;

        const bids = marketData.bids || [];
        const asks = marketData.asks || [];
        const totalBidVolume = bids.reduce((s, b) => s + (b.amount || 0), 0);
        const totalAskVolume = asks.reduce((s, a) => s + (a.amount || 0), 0);
        const bestBid = bids.length > 0 ? bids[0].rate : 0;
        const bestAsk = asks.length > 0 ? asks[0].rate : 0;

        return {
            timestamp: Date.now(),
            frr: marketData.frr,
            bestBid,
            bestAsk,
            spread: bestAsk - bestBid,
            totalBidVolume,
            totalAskVolume,
            demandSupplyRatio: totalAskVolume > 0 ? totalBidVolume / totalAskVolume : 1,
            volume: marketData.volume || 0,
            lastPrice: marketData.lastPrice || marketData.frr,
        };
    }

    /**
     * 計算線性回歸斜率（用於趨勢偵測）
     * @param {number[]} values 
     * @returns {number} 斜率
     */
    _calcLinearSlope(values) {
        const n = values.length;
        if (n < 2) return 0;

        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (let i = 0; i < n; i++) {
            sumX += i;
            sumY += values[i];
            sumXY += i * values[i];
            sumXX += i * i;
        }

        const denominator = n * sumXX - sumX * sumX;
        if (denominator === 0) return 0;

        return (n * sumXY - sumX * sumY) / denominator;
    }

    /**
     * 取得預測器狀態
     */
    getStatus() {
        const bufferStatus = {};
        for (const [currency, buffer] of Object.entries(this.historyBuffer)) {
            bufferStatus[currency] = {
                snapshotCount: buffer.length,
                windowSize: this.windowSize,
                oldestSnapshot: buffer.length > 0 ? new Date(buffer[0].timestamp).toISOString() : null,
                newestSnapshot: buffer.length > 0 ? new Date(buffer[buffer.length - 1].timestamp).toISOString() : null,
            };
        }
        return {
            modelType: this.modelLoaded ? 'external_ml' : 'statistical',
            weights: this.weights,
            bufferStatus,
        };
    }
}

// 單例
let instance = null;
function getMLPredictor() {
    if (!instance) {
        instance = new MLPredictor();
    }
    return instance;
}

module.exports = { MLPredictor, getMLPredictor };
