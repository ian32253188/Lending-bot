import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => {
  const engine = {
    getStatus: vi.fn().mockReturnValue({ running: true, userId: 'user-a' }),
    getDetailedStatus: vi.fn().mockReturnValue({ running: true, activeOffers: [] }),
    state: {
      wallets: { USD: { balance: 1000 } },
      activeCredits: { USD: [{ amount: 250 }] },
      stats: { totalEarned: { USD: 12 } },
    },
  };
  return {
    engine,
    getBot: vi.fn().mockReturnValue(engine),
    getInactiveDashboardStatus: vi.fn().mockReturnValue({ running: false, inactive: true }),
    getCachedFundingMarketSummary: vi.fn().mockResolvedValue({ currentApy: 8.9, hourlyMatches24: [] }),
    syncUserEarnings: vi.fn().mockResolvedValue(undefined),
    getRateHistory: vi.fn().mockResolvedValue([{ recorded_at: '2026-08-28T00:00:00Z' }]),
    getEarnings: vi.fn().mockResolvedValue([
      { currency: 'USD', amount: 1.25, earned_at: '2026-08-28T01:00:00Z' },
      { currency: 'USD', amount: 2.75, earned_at: '2026-08-27T01:00:00Z' },
    ]),
    deleteEarnings: vi.fn().mockResolvedValue(true),
    getActiveOffers: vi.fn().mockResolvedValue([{ offer_id: 1 }]),
    getActiveLoans: vi.fn().mockResolvedValue([{ loan_id: 2 }]),
    getLogs: vi.fn().mockResolvedValue([
      { id: 1, level: 'info', category: 'engine', message: 'started' },
      { id: 2, level: 'warn', category: 'engine', message: 'delayed' },
      { id: 3, level: 'info', category: 'telegram', message: 'started' },
    ]),
  };
});

const managerMock = { getBot: mocks.getBot };
const marketSummaryMock = { getCachedFundingMarketSummary: mocks.getCachedFundingMarketSummary };
const dashboardStatusMock = { getInactiveDashboardStatus: mocks.getInactiveDashboardStatus };
const syncMock = { syncUserEarnings: mocks.syncUserEarnings };
const wsMock = {
  getBitfinexPublicWS: () => ({
    getMarketData: (currency: string) => currency === 'USD' ? { frr: 0.0004 } : { frr: 0.0002 },
  }),
};
const databaseMock = {
  getRateHistory: mocks.getRateHistory,
  getEarnings: mocks.getEarnings,
  deleteEarnings: mocks.deleteEarnings,
  getActiveOffers: mocks.getActiveOffers,
  getActiveLoans: mocks.getActiveLoans,
  getLogs: mocks.getLogs,
};

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};
mockModule('../services/engine/manager', managerMock);
mockModule('../services/market-summary', marketSummaryMock);
mockModule('../services/dashboard-status', dashboardStatusMock);
mockModule('../services/engine/sync', syncMock);
mockModule('../services/bitfinex/ws', wsMock);
mockModule('../services/database', databaseMock);

const router = require('./dashboard');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: 'user-a' };
  next();
});
app.use('/api/dashboard', router);

describe('Dashboard routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBot.mockReturnValue(mocks.engine);
    mocks.getEarnings.mockResolvedValue([
      { currency: 'USD', amount: 1.25, earned_at: '2026-08-28T01:00:00Z' },
      { currency: 'USD', amount: 2.75, earned_at: '2026-08-27T01:00:00Z' },
    ]);
  });

  it('returns the authenticated user engine status and an inactive fallback', async () => {
    const active = await request(app).get('/api/dashboard/overview').expect(200);
    expect(active.body).toEqual({ running: true, userId: 'user-a' });
    expect(mocks.getBot).toHaveBeenCalledWith('user-a');

    mocks.getBot.mockReturnValueOnce(null);
    const inactive = await request(app).get('/api/dashboard/overview').expect(200);
    expect(inactive.body).toEqual({ running: false, inactive: true });
  });

  it('uses the shared public market service without exposing private tenant data', async () => {
    const res = await request(app).get('/api/dashboard/funding-market').expect(200);
    expect(res.body.currentApy).toBe(8.9);
    expect(mocks.getCachedFundingMarketSummary).toHaveBeenCalledWith(expect.objectContaining({
      publicWs: expect.any(Object),
      db: expect.any(Object),
    }));
  });

  it('passes a 30-day window to the rate history repository', async () => {
    await request(app).get('/api/dashboard/rate-history/USD?hours=720').expect(200);
    expect(mocks.getRateHistory).toHaveBeenCalledWith('USD', 720, 'recorded_at,frr');
  });

  it('filters logs in memory and caps the returned result', async () => {
    const res = await request(app).get('/api/dashboard/logs?limit=1&level=info&keyword=engine').expect(200);
    expect(mocks.getLogs).toHaveBeenCalledWith(3, null, 'user-a');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1);
  });

  it('syncs and aggregates earnings for all fixed periods with the tenant id', async () => {
    const res = await request(app).get('/api/dashboard/earnings/stats').expect(200);
    expect(mocks.syncUserEarnings).toHaveBeenCalledWith('user-a');
    expect(mocks.getEarnings).toHaveBeenCalledTimes(5);
    for (const call of mocks.getEarnings.mock.calls) expect(call[3]).toBe('user-a');
    expect(res.body.today).toEqual({ byCurrency: { USD: 4 }, total: 4 });
    expect(res.body.utilization).toEqual({ USD: 0.25 });
  });

  it('resets only the requested tenant earnings and engine counters', async () => {
    await request(app).post('/api/dashboard/earnings/reset').send({ currency: 'USD' }).expect(200);
    expect(mocks.deleteEarnings).toHaveBeenCalledWith('USD', 'user-a');
    expect(mocks.engine.state.stats.totalEarned.USD).toBe(0);
  });

  it('keeps history queries scoped to the authenticated tenant', async () => {
    await request(app).get('/api/dashboard/history/offers?currency=USD').expect(200);
    await request(app).get('/api/dashboard/history/loans?currency=USD').expect(200);
    expect(mocks.getActiveOffers).toHaveBeenCalledWith('USD', 'user-a');
    expect(mocks.getActiveLoans).toHaveBeenCalledWith('USD', 'user-a');
  });
});
