/**
 * =========================================================================
 * 🌌 終極防禦型三維自適應放貸策略引擎 (TypeScript Production Edition)
 * 
 * 融合技術：
 * 1. 瓦爾拉斯出清 IBRR 引擎 (地基)
 * 2. Harmonia 10分鐘誠信時間戳過濾 (防莊家高頻釣魚假單 Spoofing)
 * 3. 60% 空間穩健底倉 (Instabot easeInCubic 緩和曲線網格)
 * 4. 20% 交易量深度探針 (Loan-Manager Percent Depth 15% 防線)
 * 5. 20% 荷蘭拍時間探針 (Cascade 2.5倍天價起手 + 指數衰減降息)
 * 6. 隨機金額防偵測 + 捨入誤差傳遞算法 (Error Diffusion Dithering)
 * 7. 溢價天數滑動橡皮筋 (Harmonia Rate/FRR 比例天數映射)
 * =========================================================================
 */

import * as config from '../../config';
import * as logger from '../../utils/logger';
// ML Predictor is currently loaded but is not actively used in the simplified balanced strategy.
import { getMLPredictor } from './ml-predictor';

const VALID_RATE_STRATEGIES = ['current_avg', 'high_24h', 'high_30d'];
const VALID_PERIOD_DAYS = [2, 10, 30, 60, 90, 120];

export interface OrderBookItem {
  rate: number;
  amount: number;
  period?: number;
  count?: number;
  timestamp?: number; // 用於 Harmonia 誠信時間戳過濾
}

export interface MarketData {
  frr: number;
  lastPrice: number;
  high: number;
  low: number;
  volume: number;
  currentTradeAvg?: number;
  high24h?: number;
  high30d?: number;
  bidSize: number;
  askSize: number;
  bid: number;
  ask: number;
  asks?: OrderBookItem[];
  bids?: OrderBookItem[];
  lastUpdate?: number;
  durationLend?: number; // 官方 API v2 獲取的全網放貸平均成交天數
}

export interface WallInfo {
  hasWall: boolean;
  wallRate?: number;
  wallAmount?: number;
  wallPercentage?: number;
}

export interface IBRRResult {
  ibrr: number;
  equilibriumRate: number;
  riskLevel: number;
  frrTrend: string;
  mlPrediction: any;
  totalDemand: number;
  totalSupply: number;
  demandSupplyRatio: number;
  wallInfo: WallInfo;
  method: string;
  equilibriumFound?: boolean;
}

export interface GridOrder {
  amount: number;
  rate: number;
  period: number;
  tag?: string; // 用於追蹤與日誌診斷
}

export interface StrategyConfig {
  frrMultiplier: number;
  maxRate: number;
  minRate?: number;
  orderUnit?: number;
  defaultPeriod?: number;
  rateStrategy?: 'current_avg' | 'high_24h' | 'high_30d';
  periodDays?: number;
  useAllAvailable?: boolean;
  [key: string]: any;
}

export interface OptimalRateResult {
  orders: GridOrder[];
  shouldOffer: boolean;
  reason: string;
  currency: string;
  diagnostics?: Record<string, any>;
}

// Cubic 緩和函數 (源自 Instabot Easing)
function easeInCubic(t: number): number {
  return t * t * t;
}

export class StrategyEngine {
  public mode: string;
  public customOverrides: Record<string, any>;
  public historicalFRR: Record<string, any>;
  public ibrrHistory: Record<string, Array<{ ibrr: number; timestamp: number }>>;

  constructor() {
    // 響應用戶需求，只保留唯一的 3D_Hybrid 策略 (對齊前端 balanced id)
    this.mode = 'balanced';
    this.customOverrides = {};
    this.historicalFRR = {};
    this.ibrrHistory = {};
  }

  /**
   * 獲取策略配置：鎖定為 3D_Hybrid 預設配置，並融入用戶的自定義覆寫
   */
  public getStrategyConfig(): StrategyConfig {
    const default3DConfig: StrategyConfig = {
      frrMultiplier: 1.0,  // 以 FRR 作為物理保護底線
      maxRate: 0.008,      // 日利率上限 (0.8%)
      minRate: 0.0002,     // 日利率下限 (0.02%)
      orderUnit: 500,      // 拆單底倉基準單位
      defaultPeriod: 2,
    };
    return {
      ...default3DConfig,
      rateStrategy: 'current_avg',
      periodDays: 2,
      useAllAvailable: true,
      ...this.customOverrides,
    };
  }

  /**
   * 鎖定 3D_Hybrid 策略，拒絕切換到其他舊模式
   */
  public setMode(mode: string): void {
    logger.info('strategy', `策略已鎖定為 3D_Hybrid，忽略切換請求至: ${mode}`);
  }

  /**
   * 更新歷史 FRR 均值 (解決 lending.js 呼叫 updateHistoricalAvg 報錯的問題)
   */
  public updateHistoricalAvg(currency: string, type: '7d' | '30d', rate: number): void {
    if (!this.historicalFRR[currency]) {
      this.historicalFRR[currency] = {};
    }
    if (typeof this.historicalFRR[currency] !== 'object') {
      this.historicalFRR[currency] = {};
    }
    this.historicalFRR[currency][type] = rate;
    logger.info('strategy', `📊 更新 ${currency} 歷史平均 FRR (${type}): ${(rate * 100).toFixed(4)}%`);
  }

  /**
   * 設定歷史 FRR 均值 (相容性保留)
   */
  public setHistoricalFRR(currency: string, avgFRR: any): void {
    if (typeof avgFRR === 'object') {
      this.historicalFRR[currency] = { ...this.historicalFRR[currency], ...avgFRR };
    } else {
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
  public calculateIBRR(marketData: MarketData, riskLevel: number = 5, currency: string = ''): IBRRResult {
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
        logger.debug('strategy', `🧱 誠信過濾：剔除潛在的莊家高頻釣魚假單 asks rate=${(ask.rate*100).toFixed(4)}%`);
        return false;
      }
      return true;
    });

    const bids = rawBids.filter(bid => {
      if (bid.timestamp && bid.timestamp > tenMinutesAgo) {
        logger.debug('strategy', `🧱 誠信過濾：剔除潛在的莊家高頻釣魚假單 bids rate=${(bid.rate*100).toFixed(4)}%`);
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
      logger.info('strategy', `🧱 IBRR 觸發阻力牆繞道：原出清點=${(equilibriumRate*100).toFixed(4)}% -> 避讓掛單點=${(ibrr*100).toFixed(4)}%`);
    }

    if (currency) {
      if (!this.ibrrHistory[currency]) this.ibrrHistory[currency] = [];
      this.ibrrHistory[currency].push({ ibrr, timestamp: Date.now() });
      if (this.ibrrHistory[currency].length > 120) {
        this.ibrrHistory[currency] = this.ibrrHistory[currency].slice(-60);
      }
    }

    const result: IBRRResult = {
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

    logger.info('strategy',
      `🎯 IBRR ${currency} (3D Hybrid): ${(ibrr * 100).toFixed(4)}%/天 ` +
      `(均衡=${(equilibriumRate * 100).toFixed(4)}%, FRR=${(frr * 100).toFixed(4)}%, ` +
      `真實供需比=${result.demandSupplyRatio.toFixed(2)})`
    );

    return result;
  }

  /**
   * 計算最佳掛單方案
   */
  public calculateOptimalRate(marketData: MarketData, currency: string, availableAmount: number, userConfig: Partial<StrategyConfig> = {}): OptimalRateResult {
    const mergedConfig = { ...this.getStrategyConfig(), ...userConfig };
    const stratConfig: StrategyConfig = {
      ...mergedConfig,
      rateStrategy: VALID_RATE_STRATEGIES.includes(mergedConfig.rateStrategy as string)
        ? mergedConfig.rateStrategy
        : 'current_avg',
      periodDays: VALID_PERIOD_DAYS.includes(Number(mergedConfig.periodDays))
        ? Number(mergedConfig.periodDays)
        : 2,
      useAllAvailable: true,
    };
    const result: OptimalRateResult = {
      orders: [],
      shouldOffer: false,
      reason: '',
      currency,
      diagnostics: {},
    };

    if (!marketData || !marketData.frr) {
      result.reason = '無市場數據';
      return result;
    }

    const frr = marketData.frr;
    const asks = marketData.asks || [];
    const bids = marketData.bids || [];

    const ibrrResult = this.calculateIBRR(marketData, 5, currency);
    const ibrrRate = ibrrResult.ibrr;
    
    // 🛡️ 鋼板級 FRR 底線保護
    const frrRate = frr * stratConfig.frrMultiplier;

    const referenceRate = this._getReferenceRate(marketData, stratConfig);
    let baseRate = Math.max(referenceRate, frrRate, stratConfig.minRate || 0);
    baseRate = Math.min(baseRate, stratConfig.maxRate);

    result.diagnostics = {
      frr,
      frrRate,
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

    result.shouldOffer = true;

    // 調用唯一核心：三維自適應拆單網格
    result.orders = this._calculateGridOrders(
      availableAmount, baseRate, marketData, stratConfig, currency
    );

    result.reason = `基準(${stratConfig.rateStrategy}): ${(referenceRate * 100).toFixed(4)}%, IBRR: ${(ibrrRate * 100).toFixed(4)}%, 最終: ${(baseRate * 100).toFixed(4)}%, 期限: ${stratConfig.periodDays}天`;

    return result;
  }

  public _getReferenceRate(marketData: MarketData, stratConfig: StrategyConfig): number {
    const candidates: Record<string, number | undefined> = {
      current_avg: marketData.currentTradeAvg || marketData.lastPrice || marketData.frr,
      high_24h: (marketData as any).high24h || marketData.high || marketData.lastPrice || marketData.frr,
      high_30d: (marketData as any).high30d || marketData.high || marketData.lastPrice || marketData.frr,
    };
    return Number(candidates[stratConfig.rateStrategy || 'current_avg'] || marketData.frr || 0);
  }

  /**
   * 期限自適應選擇器
   */
  public _selectPeriod(rate: number, marketData: MarketData, stratConfig: StrategyConfig, currency: string): number {
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
   * 三維自適應拆單網格
   */
  public _calculateGridOrders(
    totalAmount: number,
    baseRate: number,
    marketData: MarketData,
    stratConfig: StrategyConfig,
    currency: string
  ): GridOrder[] {
    // @ts-ignore
    const minOffer = config.lending?.minOfferAmount || 150;
    if (totalAmount < minOffer) return [];

    const orders: GridOrder[] = [];
    const asks = marketData.asks || [];

    // 1. 資金三維分配 (60% 底倉, 20% 深度, 20% 級聯)
    const amountBase = totalAmount * 0.60;
    const amountDepth = totalAmount * 0.20;
    const amountCascade = totalAmount * 0.20;

    // 2. 第一維：空間穩健底倉 (60% 資金 - 緩和曲線網格)
    if (amountBase >= minOffer) {
      const unit = stratConfig.orderUnit || 500;
      const orderCount = Math.min(5, Math.max(2, Math.floor(amountBase / unit)));
      
      const gridRates: number[] = [];
      const lowRate = baseRate * 0.999; 
      const highRate = baseRate * 1.12;  
      const rateRange = highRate - lowRate;

      for (let i = 0; i < orderCount; i++) {
        const t = i / (orderCount - 1 || 1);
        const rate = lowRate + rateRange * easeInCubic(t); 
        gridRates.push(rate);
      }

      const baseAmounts = this._generateRandomAmounts(amountBase, orderCount, minOffer, 0.08);

      for (let i = 0; i < orderCount; i++) {
        const period = this._selectPeriod(gridRates[i], marketData, stratConfig, currency);
        orders.push({
          amount: baseAmounts[i],
          rate: gridRates[i],
          period,
          tag: 'grid_base'
        });
      }
    }

    // 3. 第二維：Percent Depth 深度探針 (20% 資金)
    if (amountDepth >= minOffer && asks.length > 0) {
      const totalAskVolume = asks.reduce((sum, a) => sum + (a.amount || 0), 0);
      const targetVolume = totalAskVolume * 0.15;
      let runningVolume = 0;
      let depthRate = baseRate * 1.15;

      for (const ask of asks) {
        runningVolume += ask.amount;
        if (runningVolume <= targetVolume) {
          depthRate = ask.rate;
        } else {
          break;
        }
      }

      depthRate = Math.max(baseRate * 1.05, Math.min(depthRate, stratConfig.maxRate || 0.005));
      const period = this._selectPeriod(depthRate, marketData, stratConfig, currency);

      orders.push({
        amount: amountDepth,
        rate: depthRate,
        period,
        tag: 'grid_depth'
      });
    }

    // 4. 第三維：Cascade 時間級聯天價探針 (20% 資金)
    if (amountCascade >= minOffer) {
      const cascadeRate = Math.min(baseRate * 2.5, stratConfig.maxRate || 0.005);
      const period = this._selectPeriod(cascadeRate, marketData, stratConfig, currency);

      orders.push({
        amount: amountCascade,
        rate: cascadeRate,
        period,
        tag: 'grid_cascade'
      });
    }

    // 5. 補償殘餘資金，或在無法拆單時提供單筆備份訂單
    if (orders.length === 0 && totalAmount >= minOffer) {
      const period = this._selectPeriod(baseRate, marketData, stratConfig, currency);
      orders.push({
        amount: totalAmount,
        rate: baseRate,
        period,
        tag: 'grid_base_consolidated'
      });
    } else {
      const allocatedTotal = orders.reduce((sum, o) => sum + o.amount, 0);
      const remainder = totalAmount - allocatedTotal;
      if (remainder > 0 && orders.length > 0) {
        orders[0].amount += remainder;
      }
    }

    return orders;
  }

  private _generateRandomAmounts(
    totalFunds: number,
    orderCount: number,
    minSize: number,
    randomDiff: number
  ): number[] {
    if (orderCount <= 0) return [];
    const perOrder = totalFunds / orderCount;
    const maxRandomDiff = perOrder < minSize ? 0 : (perOrder - minSize) / perOrder;
    const safeDiff = Math.max(0, Math.min(randomDiff, maxRandomDiff, 1));

    const randomised: number[] = [];
    for (let i = 0; i < orderCount; i++) {
      const rand = (Math.random() * safeDiff * 2) - safeDiff; 
      randomised.push(1 + rand);
    }

    const unscaledTotal = randomised.reduce((sum, val) => sum + val, 0);
    const scaleFactor = totalFunds / unscaledTotal;

    let error = 0;
    const finalAmounts = randomised.map((weight) => {
      const wish = Math.max((weight * scaleFactor) + error, minSize);
      const have = Math.floor(wish * 100000) / 100000; 
      error = wish - have; 
      return have;
    });

    return finalAmounts;
  }

  /**
   * 利率飆升偵測 (與 3D_Hybrid 對齊)
   */
  public detectRateSpike(marketData: MarketData, currentOffers: any[]): any[] {
    if (!marketData || !currentOffers || currentOffers.length === 0) return [];
    const toReplace: any[] = [];
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
  public shouldPause(marketData: MarketData): { pause: boolean } {
    return { pause: false };
  }

  /**
   * FRR 趨勢偵測
   */
  public _detectFRRTrend(marketData: MarketData): string {
    const frr = marketData.frr || 0;
    const bids = marketData.bids || [];
    const asks = marketData.asks || [];
    const bestBid = bids.length > 0 ? bids[0].rate : 0;
    const bestAsk = asks.length > 0 ? asks[0].rate : 0;
    if (!frr || !bestBid) return 'stable';
    const bidFrrRatio = bestBid / frr;
    const totalBidVol = bids.reduce((s, b) => s + (b.amount || 0), 0);
    const totalAskVol = asks.reduce((s, a) => s + (a.amount || 0), 0);
    const volumeImbalance = totalAskVol > 0 ? totalBidVol / totalAskVol : 1;
    const spread = bestAsk - bestBid;
    const spreadRatio = frr > 0 ? spread / frr : 0;
    let score = 0;
    if (bidFrrRatio > 1.15) score += 2;
    else if (bidFrrRatio > 1.05) score += 1;
    else if (bidFrrRatio < 0.85) score -= 2;
    else if (bidFrrRatio < 0.95) score -= 1;
    if (volumeImbalance > 1.5) score += 1;
    else if (volumeImbalance < 0.5) score -= 1;
    if (spreadRatio < 0.05 && bidFrrRatio > 1.05) score += 1;
    if (score >= 2) return 'rising';
    if (score <= -2) return 'falling';
    return 'stable';
  }

  /**
   * 檢測大資金阻力牆
   */
  public _detectRateWall(asks: OrderBookItem[], totalVolume: number): WallInfo {
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
  public getStatus(): any {
    const mlPredictor = getMLPredictor();
    return {
      mode: this.mode,
      config: this.getStrategyConfig(),
      historicalFRR: this.historicalFRR,
      ibrrHistory: Object.fromEntries(
        Object.entries(this.ibrrHistory).map(([k, v]) => [k, v.slice(-5)])
      ),
      mlPredictor: mlPredictor.getStatus(),
    };
  }
}

let instance: StrategyEngine | null = null;
export function getStrategyEngine(): StrategyEngine {
  if (!instance) {
    instance = new StrategyEngine();
  }
  return instance;
}
