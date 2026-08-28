import { describe, expect, it } from 'vitest';
import { annualizedPercent, buildHourlyFundingMatches } from './market-summary';

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
});
