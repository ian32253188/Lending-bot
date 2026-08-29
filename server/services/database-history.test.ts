import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ranges: [] as Array<[number, number]>,
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

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};
mockModule('../config', configMock);
mockModule('@supabase/supabase-js', supabaseMock);

const db = require('./database');

describe('rate_history repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.ranges.length = 0;
    state.from.mockReturnValue(query);
    query.range.mockImplementation((start: number, end: number) => {
      state.ranges.push([start, end]);
      const data = start === 0
        ? Array.from({ length: 1000 }, (_, index) => ({ id: index }))
        : [{ id: 1000 }, { id: 1001 }];
      return Promise.resolve({ data, error: null });
    });
    query.select.mockReturnValue(query);
  });

  it('walks Supabase pages so a 30-day five-minute history is not truncated', async () => {
    const rows = await db.getRateHistory('USD', 720);

    expect(rows).toHaveLength(1002);
    expect(state.ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(query.eq).toHaveBeenCalledWith('currency', 'USD');
    expect(query.order).toHaveBeenCalledWith('recorded_at', { ascending: true });
  });

  it('maps a rate snapshot to the rate_history schema', async () => {
    const inserted = [{ id: 1 }];
    query.insert.mockReturnValue(query);
    query.select.mockResolvedValue({ data: inserted, error: null });

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

    expect(result).toBe(inserted);
    expect(query.insert).toHaveBeenCalledWith(expect.objectContaining({
      currency: 'USD',
      frr: 0.0003,
      avg_rate: 0.0004,
      high_rate: 0.0005,
      low_rate: 0.0002,
      demand_supply_ratio: 0.66,
      wallet_balance: 5000,
    }));
  });
});
