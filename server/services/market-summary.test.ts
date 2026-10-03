import { describe, expect, it, vi } from 'vitest';
import { aggregateDailyRateHistory, annualizedPercent, buildFundingMarketSummary, buildHourlyFundingMatches, getCachedFundingMarketSummary, loadRecentFundingTrades } from './market-summary';

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

  it('aggregates five-minute snapshots into one point per Taipei calendar day', () => {
    const now = Date.parse('2026-08-28T08:00:00Z');
    const rows = aggregateDailyRateHistory([
      { recorded_at: '2026-08-27T00:00:00Z', avg_rate: 0.0002, high_rate: 0.0004, low_rate: 0.0001 },
      { recorded_at: '2026-08-27T12:00:00Z', avg_rate: 0.0004, high_rate: 0.0005, low_rate: 0.00015 },
      { recorded_at: '2026-08-28T00:00:00Z', avg_rate: 0.0003, high_rate: 0.0006, low_rate: 0.00015 },
    ], now);

    expect(rows).toHaveLength(2);
    expect(rows[0].recorded_at).toBe('2026-08-27T00:00:00+08:00');
    expect(rows[0].avg_rate).toBeCloseTo(0.0003, 10);
    expect(rows[0].high_rate).toBeCloseTo(0.0005, 10);
    expect(rows[0].low_rate).toBeCloseTo(0.0001, 10);
  });

  it('builds the dashboard metrics from public trades and local 30-day history', async () => {
    const now = Date.parse('2026-08-28T08:00:00Z');
    const getRateHistory = vi.fn().mockResolvedValue([
      { recorded_at: '2026-08-27T00:00:00Z', avg_rate: 0.0002, high_rate: 0.0004, low_rate: 0.0001 },
      { recorded_at: '2026-08-28T00:00:00Z', avg_rate: 0.0003, high_rate: 0.0006, low_rate: 0.00015 },
    ]);
    const summary = await buildFundingMarketSummary({
      now,
      publicWs: { getMarketData: () => ({ volume: 1500, high: 0.0005, low: 0.0003 }) },
      db: {
        getRateHistory,
      },
      restClient: {
        getFundingTrades: vi.fn().mockResolvedValue([
          [1, now - 10 * 60 * 1000, 1000, 0.0003, 2],
          [2, now - 20 * 60 * 1000, 500, 0.0005, 10],
        ]),
      },
    });

    expect(summary.currentApy).toBeCloseTo(13.3833333, 5);
    expect(summary.currentRateSource).toBe('funding_trades_24h_vwap');
    expect(summary.high24hApy).toBeCloseTo(18.25, 5);
    expect(summary.average30dApy).toBeCloseTo(9.125, 5);
    expect(summary.high30dApy).toBeCloseTo(21.9, 5);
    expect(summary.history).toHaveLength(2);
    expect(summary.historyCoverageDays).toBe(2);
    expect(summary.historyWindowDays).toBe(30);
    expect(summary.historyCoverageStartDate).toBe('2026-08-27');
    expect(summary.historyCoverageEndDate).toBe('2026-08-28');
    expect(summary.hourlyMatches).toHaveLength(1);
    expect(summary.hourlyMatches24).toHaveLength(24);
    expect(summary.hourlyMatches24[1].details).toHaveLength(2);
    expect(summary.hourlyMatches24[1].details[0].apy).toBeCloseTo(10.95, 5);
    expect(getRateHistory).toHaveBeenCalledWith('USD', 30 * 24, 'recorded_at,avg_rate,high_rate,low_rate');
  });

  it('reuses 30-day history between one-minute dashboard refreshes', async () => {
    const now = Date.parse('2026-08-28T08:00:00Z');
    const db = { getRateHistory: vi.fn().mockResolvedValue([]) };
    const restClient = { getFundingTrades: vi.fn().mockResolvedValue([]) };
    const options = {
      now,
      force: true,
      db,
      restClient,
      publicWs: { getMarketData: () => ({}) },
    };

    await getCachedFundingMarketSummary(options);
    await getCachedFundingMarketSummary({ ...options, force: false, now: now + 60 * 1000 });

    expect(db.getRateHistory).toHaveBeenCalledTimes(1);
  });

  it('uses OCI PostgreSQL funding trades instead of querying Supabase or Bitfinex per dashboard request', async () => {
    const now = Date.parse('2026-08-28T08:00:00Z');
    const getFundingTrades = vi.fn().mockResolvedValue([
      { id: 10, timestamp: now - 5 * 60 * 1000, amount: 800, rate: 0.0003, period: 2 },
    ]);
    const restClient = { getFundingTrades: vi.fn() };
    const summary = await buildFundingMarketSummary({
      now,
      publicWs: { getMarketData: () => ({}) },
      db: {
        getFundingTrades,
        getRateHistory: vi.fn().mockResolvedValue([]),
      },
      restClient,
    });

    expect(getFundingTrades).toHaveBeenCalledWith(
      'USD',
      new Date(now - 24 * 60 * 60 * 1000),
      new Date(now),
    );
    expect(restClient.getFundingTrades).not.toHaveBeenCalled();
    expect(summary.hourlyMatches24).toHaveLength(24);
    expect(summary.hourlyMatches24[1].details).toHaveLength(1);
  });

  it('self-heals an empty or stale Oracle trade table from the public feed', async () => {
    const now = Date.parse('2026-08-28T08:00:00Z');
    const getFundingTrades = vi.fn().mockResolvedValue([]);
    const getLatestFundingTradeTimestamp = vi.fn().mockResolvedValue(null);
    const upsertFundingTrades = vi.fn().mockResolvedValue(2);
    const restClient = {
      getFundingTrades: vi.fn().mockResolvedValue([
        [11, now - 2 * 60 * 1000, -150, 0.0003, 2],
        [12, now - 1 * 60 * 1000, 250, 0.0004, 10],
      ]),
    };

    const trades = await loadRecentFundingTrades({
      db: { getFundingTrades, getLatestFundingTradeTimestamp, upsertFundingTrades },
      restClient,
      now,
    });

    expect(trades).toHaveLength(2);
    expect(trades[0].amount).toBe(250);
    expect(upsertFundingTrades).toHaveBeenCalledWith(expect.any(Array), 'USD');
  });

  it('keeps empty hours visible while preserving the 24-hour window', () => {
    const now = Date.parse('2026-08-28T08:00:00Z');
    const rows = buildHourlyFundingMatches([
      { id: 1, timestamp: Date.parse('2026-08-28T07:15:00Z'), amount: 500, rate: 0.0003, period: 2 },
    ], now, 24, true);

    expect(rows).toHaveLength(24);
    expect(rows[0].timestamp).toBe(Date.parse('2026-08-28T08:00:00Z'));
    expect(rows[0].count).toBe(0);
    expect(rows[1].count).toBe(1);
    expect(rows[1].details[0].period).toBe(2);
  });

  it('does not use stale public ticker values as current market data', async () => {
    const now = Date.parse('2026-08-28T08:00:00Z');
    const summary = await buildFundingMarketSummary({
      now,
      publicWs: {
        getMarketData: () => ({
          frr: 0.0004,
          lastPrice: 0.0005,
          high: 0.0008,
          low: 0.0001,
          volume: 5000,
          tickerLastUpdate: now - 6 * 60 * 1000,
        }),
      },
      tradeData: [],
      historyData: [],
    });

    expect(summary.tickerFresh).toBe(false);
    expect(summary.currentApy).toBeNull();
    expect(summary.high24hApy).toBeNull();
    expect(summary.low24hApy).toBeNull();
    expect(summary.volume24h).toBe(0);
    expect(summary.currentRateSource).toBeNull();
    expect(summary.hourlyMatches24).toHaveLength(24);
  });

  it('marks failed market repositories unavailable instead of fabricating empty-hour data', async () => {
    const summary = await buildFundingMarketSummary({
      publicWs: { getMarketData: () => ({ frr: null, tickerLastUpdate: null }) },
      tradeData: Promise.reject(new Error('Oracle unavailable')),
      historyData: Promise.reject(new Error('history unavailable')),
    });

    expect(summary.tradeDataAvailable).toBe(false);
    expect(summary.historyDataAvailable).toBe(false);
    expect(summary.volume24h).toBeNull();
    expect(summary.collectedTradeCount).toBeNull();
    expect(summary.hourlyMatches24).toEqual([]);
    expect(summary.historyCoverageDays).toBeNull();
  });
});
