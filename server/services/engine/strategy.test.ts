import { describe, expect, it } from 'vitest';

const { StrategyEngine } = require('./strategy');

const marketData = {
  frr: 0.001,
  lastPrice: 0,
  high: 0,
  low: 0,
  volume: 0,
  bidSize: 0,
  askSize: 0,
  bid: 0,
  ask: 0,
  asks: [],
  bids: [],
  currentTradeAvg: 0.002,
  high24h: 0.003,
  high30d: 0.004,
};

describe('Lending strategy selected benchmark', () => {
  it.each([
    ['current_avg', 0.002],
    ['high_24h', 0.003],
    ['high_30d', 0.004],
  ])('uses %s exactly for one full-balance offer', (rateStrategy, expectedRate) => {
    const strategy = new StrategyEngine();

    const result = strategy.calculateOptimalRate(marketData, 'USD', 500, {
      rateStrategy,
      periodDays: 30,
      minRate: 0.0001,
      maxRate: 0.0005,
      frrMultiplier: 99,
    });

    expect(result.shouldOffer).toBe(true);
    expect(result.orders).toEqual([{
      amount: 500,
      rate: expectedRate,
      period: 30,
      tag: 'strategy_single',
    }]);
    expect(result.diagnostics?.finalRate).toBe(expectedRate);
  });

  it.each([0, 150])('does not offer when available balance is $%s', (amount) => {
    const result = new StrategyEngine().calculateOptimalRate(marketData, 'USD', amount, {
      rateStrategy: 'current_avg',
      periodDays: 2,
    });

    expect(result.shouldOffer).toBe(false);
    expect(result.orders).toEqual([]);
  });

  it('offers when available balance is strictly above $150', () => {
    const result = new StrategyEngine().calculateOptimalRate(marketData, 'USD', 150.01, {
      rateStrategy: 'current_avg',
      periodDays: 2,
    });

    expect(result.shouldOffer).toBe(true);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].amount).toBe(150.01);
  });

  it('waits when the selected benchmark has no data instead of falling back to another rate', () => {
    const result = new StrategyEngine().calculateOptimalRate({
      ...marketData,
      currentTradeAvg: undefined,
    }, 'USD', 500, {
      rateStrategy: 'current_avg',
      periodDays: 2,
    });

    expect(result.shouldOffer).toBe(false);
    expect(result.orders).toEqual([]);
    expect(result.reason).toContain('所選利率基準');
  });
});
