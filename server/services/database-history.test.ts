import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ranges: [] as Array<[number, number]>,
  pgQueries: [] as Array<[string, unknown[]]>,
  from: vi.fn(),
}));

const configMock = { supabase: { url: 'https://supabase.test', key: 'service-key' } };

const query = {
  select: vi.fn(),
  eq: vi.fn(),
  gte: vi.fn(),
  order: vi.fn(),
  range: vi.fn(),
  insert: vi.fn(),
};
for (const method of ['select', 'eq', 'gte', 'order', 'insert']) {
  query[method as keyof typeof query].mockReturnValue(query);
}

const supabaseMock = { createClient: vi.fn(() => ({ from: state.from })) };

class MockPool {
  on() { return this; }
  async query(sql: string, params: unknown[]) {
    state.pgQueries.push([sql, params]);
    return { rows: [] };
  }
}

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};
mockModule('../config', configMock);
mockModule('@supabase/supabase-js', supabaseMock);
mockModule('pg', { Pool: MockPool });

const db = require('./database');

describe('rate_history repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.ranges.length = 0;
    state.pgQueries.length = 0;
    state.from.mockReturnValue(query);
    query.range.mockImplementation((start: number, end: number) => {
      state.ranges.push([start, end]);
      const data = start === 0
        ? Array.from({ length: 1000 }, (_, index) => ({ id: index }))
        : [{ id: 1000 }, { id: 1001 }];
      return Promise.resolve({ data, error: null });
    });
    query.select.mockReturnValue(query);
    query.insert.mockResolvedValue({ error: null });
  });

  it('walks Supabase pages so a 30-day five-minute history is not truncated', async () => {
    const rows = await db.getRateHistory('USD', 720);

    expect(rows).toHaveLength(1002);
    expect(state.ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(query.eq).toHaveBeenCalledWith('currency', 'USD');
    expect(query.order).toHaveBeenCalledWith('recorded_at', { ascending: true });
  });

  it('falls back to legacy Supabase history when Oracle has no coverage for the requested window', async () => {
    const originalRunDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS;
    configMock.database = { host: 'postgres', password: 'test-password' };
    process.env.RUN_DB_INTEGRATION_TESTS = '1';

    try {
      const rows = await db.getRateHistory('USD', 720, 'recorded_at,avg_rate,high_rate,low_rate');

      expect(state.pgQueries).toHaveLength(1);
      expect(rows).toHaveLength(1002);
      expect(state.ranges).toEqual([[0, 999], [1000, 1999]]);
    } finally {
      delete configMock.database;
      if (originalRunDbIntegrationTests === undefined) {
        delete process.env.RUN_DB_INTEGRATION_TESTS;
      } else {
        process.env.RUN_DB_INTEGRATION_TESTS = originalRunDbIntegrationTests;
      }
    }
  });

  it('maps a rate snapshot to the rate_history schema', async () => {
    const result = await db.saveRateSnapshot({
      currency: 'USD',
      frr: 0.0003,
      avgRate: 0.0004,
      highRate: 0.0005,
      lowRate: 0.0002,
      volume: 1000,
      bidDepth: 200,
      askDepth: 300,
      demandSupplyRatio: 0.66,
      activeOffersCount: 4,
      activeCreditsCount: 3,
      walletBalance: 5000,
    });

    expect(result).toBe(true);
    expect(query.insert).toHaveBeenCalledWith([expect.objectContaining({
      currency: 'USD',
      frr: 0.0003,
      avg_rate: 0.0004,
      high_rate: 0.0005,
      low_rate: 0.0002,
      demand_supply_ratio: 0.66,
      wallet_balance: 5000,
    })]);
    expect(query.select).not.toHaveBeenCalled();
  });

  it('writes both currency snapshots in one insert', async () => {
    const result = await db.saveRateSnapshots([
      { currency: 'USD', frr: 0.0003 },
      { currency: 'USDT', frr: 0.0002 },
    ]);

    expect(result).toBe(true);
    expect(query.insert).toHaveBeenCalledTimes(1);
    expect(query.insert.mock.calls[0][0]).toEqual([
      expect.objectContaining({ currency: 'USD', frr: 0.0003 }),
      expect.objectContaining({ currency: 'USDT', frr: 0.0002 }),
    ]);
  });

  it('creates the per-user settings schema idempotently for an existing PostgreSQL volume', async () => {
    const originalRunDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS;
    configMock.database = { host: 'postgres', password: 'test-password' };
    process.env.RUN_DB_INTEGRATION_TESTS = '1';

    try {
      const ready = await db.ensureUserBotSettingsTable();
      expect(ready).toBe(true);
      const sql = state.pgQueries.map(([statement]) => statement).join('\n');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS user_bot_settings');
      expect(sql).toContain('user_id UUID PRIMARY KEY');
      expect(sql).toContain('user_bot_settings_telegram_chat_id_unique');
    } finally {
      delete configMock.database;
      if (originalRunDbIntegrationTests === undefined) {
        delete process.env.RUN_DB_INTEGRATION_TESTS;
      } else {
        process.env.RUN_DB_INTEGRATION_TESTS = originalRunDbIntegrationTests;
      }
    }
  });

  it('creates dashboard history, earnings, and log tables on an existing PostgreSQL volume', async () => {
    const originalRunDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS;
    configMock.database = { host: 'postgres', password: 'test-password' };
    process.env.RUN_DB_INTEGRATION_TESTS = '1';

    try {
      const ready = await db.ensureApplicationDataTables();
      expect(ready).toBe(true);
      const sql = state.pgQueries.map(([statement]) => statement).join('\n');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS funding_offers');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS funding_loans');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS earnings');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS operation_logs');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_funding_offers_status');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_funding_loans_status');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_earnings_currency_time');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_logs_time');
    } finally {
      delete configMock.database;
      if (originalRunDbIntegrationTests === undefined) {
        delete process.env.RUN_DB_INTEGRATION_TESTS;
      } else {
        process.env.RUN_DB_INTEGRATION_TESTS = originalRunDbIntegrationTests;
      }
    }
  });
});
