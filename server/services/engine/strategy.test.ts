import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StrategyEngine, MarketData, OrderBookItem } from './strategy';

// Mock getMLPredictor
vi.mock('./ml-predictor', () => ({
  getMLPredictor: () => ({
    getStatus: () => ({})
  })
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
}));

// Mock config
vi.mock('../../config', () => ({
  strategy: {
    defaultMode: '3D_Hybrid',
    modes: {
      '3D_Hybrid': {
        frrMultiplier: 1.0,
        maxRate: 0.008,
        minRate: 0.0002,
        orderUnit: 500,
        defaultPeriod: 2
      }
    }
  },
  lending: {
    minOfferAmount: 150
  }
}));

describe('StrategyEngine - 3D_Hybrid 核心策略演算法測試', () => {
  let engine: StrategyEngine;

  beforeEach(() => {
    engine = new StrategyEngine();
  });

  describe('calculateIBRR (即時最佳利率 - 脫水防釣魚版)', () => {
    it('應能在一般市場供需下找到均衡利率 (Equilibrium Rate)', () => {
      const mockMarketData: MarketData = {
        frr: 0.00035, // 0.035% per day
        lastPrice: 0.00036,
        high: 0.00045,
        low: 0.00030,
        volume: 100000,
        bidSize: 5000,
        askSize: 8000,
        bid: 0.00034,
        ask: 0.00036,
        asks: [
          { rate: 0.00030, amount: 4000, timestamp: Date.now() - 15 * 60 * 1000 },
          { rate: 0.00032, amount: 4000, timestamp: Date.now() - 15 * 60 * 1000 },
          { rate: 0.00035, amount: 4000, timestamp: Date.now() - 15 * 60 * 1000 }, // cumulative supply = 12,000
          { rate: 0.00038, amount: 4000, timestamp: Date.now() - 15 * 60 * 1000 },
          { rate: 0.00040, amount: 4000, timestamp: Date.now() - 15 * 60 * 1000 }
        ],
        bids: [
          { rate: 0.00034, amount: 4000, timestamp: Date.now() - 15 * 60 * 1000 },
          { rate: 0.00033, amount: 3000, timestamp: Date.now() - 15 * 60 * 1000 },
          { rate: 0.00031, amount: 2000, timestamp: Date.now() - 15 * 60 * 1000 } // total demand = 9,000
        ]
      };

      const result = engine.calculateIBRR(mockMarketData, 5, 'USD');
      
      expect(result.totalDemand).toBe(9000);
      expect(result.totalSupply).toBe(20000);
      expect(result.equilibriumRate).toBe(0.00035); // 9000 demand falls into 3rd ask tier (cumulative 12000)
      expect(result.ibrr).toBe(0.00035);
      expect(result.equilibriumFound).toBe(true);
    });

    it('應能自動識別並過濾 10 分鐘內建立的莊家高頻釣魚假單 (Spoofing Age Filter)', () => {
      const now = Date.now();
      const mockMarketData: MarketData = {
        frr: 0.00035,
        lastPrice: 0.00036,
        high: 0.00045,
        low: 0.00030,
        volume: 100000,
        bidSize: 5000,
        askSize: 8000,
        bid: 0.00034,
        ask: 0.00036,
        asks: [
          { rate: 0.00030, amount: 4000, timestamp: now - 15 * 60 * 1000 }, // 誠信單
          { rate: 0.00032, amount: 4000, timestamp: now - 1 * 60 * 1000 },  // 👈 1分鐘內假單，應被剔除
          { rate: 0.00035, amount: 4000, timestamp: now - 15 * 60 * 1000 }, // 誠信單
          { rate: 0.00038, amount: 4000, timestamp: now - 15 * 60 * 1000 }
        ],
        bids: [
          { rate: 0.00034, amount: 4000, timestamp: now - 15 * 60 * 1000 }
        ]
      };

      const result = engine.calculateIBRR(mockMarketData, 5, 'USD');
      // 過濾後，asks 剩餘: 0.00030 (4000), 0.00035 (4000), 0.00038 (4000)，總供給為 12000，第二檔 0.00032 消失了
      expect(result.totalSupply).toBe(12000);
      // 需求是 4000，落在第一檔 asks (0.00030) 就出清了！
      expect(result.equilibriumRate).toBe(0.00030);
    });

    it('在極端供不應求時，應能合理使用最高 Bid 利率作為均衡利率', () => {
      const mockMarketData: MarketData = {
        frr: 0.00035,
        lastPrice: 0.00036,
        high: 0.00045,
        low: 0.00030,
        volume: 100000,
        bidSize: 50000,
        askSize: 2000,
        bid: 0.00042,
        ask: 0.00045,
        asks: [
          { rate: 0.00030, amount: 1000, timestamp: Date.now() - 15 * 60 * 1000 },
          { rate: 0.00035, amount: 1000, timestamp: Date.now() - 15 * 60 * 1000 } // total supply = 2000
        ],
        bids: [
          { rate: 0.00042, amount: 5000, timestamp: Date.now() - 15 * 60 * 1000 } // total demand = 5000 (exceeds supply)
        ]
      };

      const result = engine.calculateIBRR(mockMarketData, 5, 'USD');
      expect(result.equilibriumFound).toBe(false);
      expect(result.equilibriumRate).toBe(0.00042); // falls back to highest bid rate (0.00042)
    });
  });

  describe('_detectRateWall (檢測 FRR 阻力牆)', () => {
    it('某一檔 Asks 的量佔總量大於 25% 時應判定為 Wall', () => {
      const asks: OrderBookItem[] = [
        { rate: 0.00030, amount: 1000 },
        { rate: 0.00032, amount: 5000 }, // 5000 / 10000 = 50% (> 25%)
        { rate: 0.00035, amount: 4000 }
      ];
      
      const wallInfo = engine._detectRateWall(asks, 10000);
      expect(wallInfo.hasWall).toBe(true);
      expect(wallInfo.wallRate).toBe(0.00032);
      expect(wallInfo.wallAmount).toBe(5000);
    });

    it('當無明顯單一檔牆時應返回 hasWall = false', () => {
      const asks: OrderBookItem[] = [
        { rate: 0.00030, amount: 2000 },
        { rate: 0.00033, amount: 2000 },
        { rate: 0.00036, amount: 2000 },
        { rate: 0.00039, amount: 2000 },
        { rate: 0.00042, amount: 2000 }
      ]; // total 10000, each is 20% (< 25%)
      
      const wallInfo = engine._detectRateWall(asks, 10000);
      expect(wallInfo.hasWall).toBe(false);
    });
  });

  describe('calculateOptimalRate - 3D_Hybrid 核心三維拆單網格測試', () => {
    it('應能將可用金額按比例精準劃分為 60% 底倉、20% 深度、20% 級聯探針訂單，且金額總和完全精準吻合', () => {
      const mockMarketData: MarketData = {
        frr: 0.00035,
        lastPrice: 0.00035,
        high: 0.0004,
        low: 0.0003,
        volume: 50000,
        bidSize: 1000,
        askSize: 1000,
        bid: 0.00034,
        ask: 0.00036,
        asks: [
          { rate: 0.00035, amount: 5000, timestamp: Date.now() - 15 * 60 * 1000 }
        ],
        bids: [
          { rate: 0.00034, amount: 2000, timestamp: Date.now() - 15 * 60 * 1000 }
        ]
      };

      // 可用餘額 1250 USD
      const result = engine.calculateOptimalRate(mockMarketData, 'USD', 1250);
      
      expect(result.shouldOffer).toBe(true);
      // 分配邏輯：
      // amountBase = 1250 * 0.60 = 750 USD -> 拆分為 2 筆 base 訂單 (合計 750)
      // amountDepth = 1250 * 0.20 = 250 USD -> 1 筆 depth 訂單 (金額 250)
      // amountCascade = 1250 * 0.20 = 250 USD -> 1 筆 cascade 訂單 (金額 250)
      // 總計 4 筆訂單
      expect(result.orders.length).toBe(4);

      // 驗證標籤
      const baseOrders = result.orders.filter(o => o.tag === 'grid_base');
      const depthOrders = result.orders.filter(o => o.tag === 'grid_depth');
      const cascadeOrders = result.orders.filter(o => o.tag === 'grid_cascade');

      expect(baseOrders.length).toBe(2);
      expect(depthOrders.length).toBe(1);
      expect(cascadeOrders.length).toBe(1);

      // 驗證金額總和 100% 精準吻合 (誤差傳遞無殘渣)
      const totalAllocated = result.orders.reduce((sum, o) => sum + o.amount, 0);
      expect(totalAllocated).toBeCloseTo(1250, 4);

      // 驗證底倉金額總和為 750
      const totalBase = baseOrders.reduce((sum, o) => sum + o.amount, 0);
      expect(totalBase).toBeCloseTo(750, 4);

      // 驗證深度和級聯訂單金額為 250
      expect(depthOrders[0].amount).toBeCloseTo(250, 4);
      expect(cascadeOrders[0].amount).toBeCloseTo(250, 4);

      // 驗證級聯探針之利率應為 baseRate 的 2.5倍 (天價探針)
      const baseRate = Math.max(0.00035, 0.00035); // IBRR vs FRR
      expect(cascadeOrders[0].rate).toBeCloseTo(baseRate * 2.5, 6);
    });

    it('當總餘額小於 150 USD 時，不應掛單', () => {
      const mockMarketData: MarketData = {
        frr: 0.00035,
        lastPrice: 0.00035,
        high: 0.0004,
        low: 0.0003,
        volume: 50000,
        bidSize: 1000,
        askSize: 1000,
        bid: 0.00034,
        ask: 0.00036,
        asks: [{ rate: 0.00035, amount: 5000, timestamp: Date.now() - 15 * 60 * 1000 }],
        bids: [{ rate: 0.00034, amount: 2000, timestamp: Date.now() - 15 * 60 * 1000 }]
      };

      const result = engine.calculateOptimalRate(mockMarketData, 'USD', 100);
      expect(result.shouldOffer).toBe(true);
      expect(result.orders.length).toBe(0); // 低於 minOfferAmount 150
    });
  });

  describe('fUSD 使用者策略基準與固定期限', () => {
    it('應依三種選項選取對應公開利率，且所有拆單都使用指定天數', () => {
      const marketData: MarketData = {
        frr: 0.0001,
        lastPrice: 0.0002,
        currentTradeAvg: 0.0003,
        high24h: 0.0004,
        high30d: 0.0005,
        high: 0.0004,
        low: 0.0001,
        volume: 1000,
        bidSize: 100,
        askSize: 100,
        bid: 0.0001,
        ask: 0.0002,
        asks: [],
        bids: [],
      };

      for (const [rateStrategy, expectedRate] of [
        ['current_avg', 0.0003],
        ['high_24h', 0.0004],
        ['high_30d', 0.0005],
      ] as const) {
        const result = engine.calculateOptimalRate(marketData, 'USD', 2000, {
          rateStrategy,
          periodDays: 120,
        });
        expect(result.diagnostics?.referenceRate).toBe(expectedRate);
        expect(result.orders.length).toBeGreaterThan(0);
        expect(result.orders.every(order => order.period === 120)).toBe(true);
        expect(result.orders.reduce((sum, order) => sum + order.amount, 0)).toBeCloseTo(2000, 8);
      }
    });
  });
});
