import { describe, expect, it, vi } from 'vitest';
import { annualizedPercent, buildFundingMarketSummary, buildHourlyFundingMatches } from './market-summary';

describe('fUSD market summary helpers', () => {
  it('converts Bitfinex daily funding rates to annualized percentages', () => {
    expect(annualizedPercent(0.00035)).toBeCloseTo(12.775, 6);
  });

  it('groups public funding trades into hourly ranges and volume', () => {
    const now = Date.parse('2026-08-28T08:00:00Z');
    const rows = buildHourlyFundingMatches([
      { timestamp: Date.parse('2026-08-28T07:15:00Z'), amount: 500, rate: 0.0003, period: 2 },
      { timestamp: Date.parse('2026-08-28T07:45:00Z'), amount: 336, rate: 0.0004, period: 2 },
      { timestamp: Date.parse('2026-08-27T06:59:00Z'), amount: 100, rate: 0.0005, period: 2 },
    ], now);

    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(836);
    expect(rows[0].count).toBe(2);
    expect(rows[0].minApy).toBeCloseTo(10.95, 6);
    expect(rows[0].maxApy).toBeCloseTo(14.6, 6);
  });

  it('builds the dashboard metrics from public trades and local 30-day history', async () => {
    const now = Date.parse('2026-08-28T08:00:00Z');
    const summary = await buildFundingMarketSummary({
      now,
      publicWs: { getMarketData: () => ({ volume: 1500, high: 0.0005, low: 0.0003 }) },
      db: {
        getRateHistory: vi.fn().mockResolvedValue([
          { recorded_at: '2026-08-27T00:00:00Z', avg_rate: 0.0002, high_rate: 0.0004, low_rate: 0.0001 },
          { recorded_at: '2026-08-28T00:00:00Z', avg_rate: 0.0003, high_rate: 0.0006, low_rate: 0.00015 },
        ]),
      },
      restClient: {
        getFundingTrades: vi.fn().mockResolvedValue([
          [1, now - 10 * 60 * 1000, 1000, 0.0003, 2],
          [2, now - 20 * 60 * 1000, 500, 0.0005, 10],
        ]),
      },
    });

    expect(summary.currentApy).toBeCloseTo(13.3833333, 5);
    expect(summary.high24hApy).toBeCloseTo(18.25, 5);
    expect(summary.average30dApy).toBeCloseTo(9.125, 5);
    expect(summary.high30dApy).toBeCloseTo(21.9, 5);
    expect(summary.history).toHaveLength(2);
    expect(summary.hourlyMatches).toHaveLength(1);
  });
});
