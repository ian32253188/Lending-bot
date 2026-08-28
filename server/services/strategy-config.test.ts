import { describe, expect, it } from 'vitest';
import {
  PERIOD_DAYS,
  RATE_STRATEGIES,
  normalizeStrategyConfig,
  validateStrategyConfig,
} from './strategy-config';

describe('fUSD strategy configuration', () => {
  it('accepts exactly the three rate strategies and six periods', () => {
    expect(Object.values(RATE_STRATEGIES)).toEqual(['current_avg', 'high_24h', 'high_30d']);
    expect(PERIOD_DAYS).toEqual([2, 10, 30, 60, 90, 120]);
    expect(validateStrategyConfig({ rateStrategy: 'high_30d', periodDays: 120 })).toEqual([]);
  });

  it('normalizes invalid or missing values to safe defaults and always uses all available funds', () => {
    expect(normalizeStrategyConfig({ rateStrategy: 'unknown', periodDays: 7 })).toMatchObject({
      rateStrategy: 'current_avg',
      periodDays: 2,
      useAllAvailable: true,
    });
    expect(validateStrategyConfig({ rateStrategy: 'unknown', periodDays: 7 })).toHaveLength(2);
  });
});
