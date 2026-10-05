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
    getInactiveDashboardStatusForUser: vi.fn().mockResolvedValue({ running: false, inactive: true }),
    getReadOnlyAccountSnapshot: vi.fn().mockResolvedValue({
      accountDataAvailable: false,
      accountDataError: 'Bitfinex signature invalid',
      activeCredits: { USD: null },
      wallets: { USD: { balance: null } },
    }),
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
    isPostgresConfigured: vi.fn().mockReturnValue(true),
    getLogs: vi.fn().mockResolvedValue([
      { id: 1, level: 'info', category: 'engine', message: 'started' },
      { id: 2, level: 'warn', category: 'engine', message: 'delayed' },
      { id: 3, level: 'info', category: 'telegram', message: 'started' },
    ]),
    publicMarketData: {
      USD: { frr: 0.0004, tickerLastUpdate: Date.now() },
    },
    getMarketData: vi.fn((currency: string) => currency === 'USD' ? mocks.publicMarketData.USD : null),
  };
});

const managerMock = { getBot: mocks.getBot };
const marketSummaryMock = { getCachedFundingMarketSummary: mocks.getCachedFundingMarketSummary };
const dashboardStatusMock = { getInactiveDashboardStatusForUser: mocks.getInactiveDashboardStatusForUser };
const privateAccountStatusMock = { getReadOnlyAccountSnapshot: mocks.getReadOnlyAccountSnapshot };
const syncMock = { syncUserEarnings: mocks.syncUserEarnings };
const wsMock = {
  getBitfinexPublicWS: () => ({
    getMarketData: mocks.getMarketData,
  }),
  isPublicTickerFresh: (marketData: any) => Number.isFinite(Number(marketData?.tickerLastUpdate))
    && Number(marketData.tickerLastUpdate) > 0
    && Date.now() - Number(marketData.tickerLastUpdate) <= 5 * 60 * 1000
    && marketData.frr !== null
    && marketData.frr !== undefined
    && Number.isFinite(Number(marketData.frr)),
};
const databaseMock = {
  getRateHistory: mocks.getRateHistory,
  getEarnings: mocks.getEarnings,
  deleteEarnings: mocks.deleteEarnings,
  getActiveOffers: mocks.getActiveOffers,
  getActiveLoans: mocks.getActiveLoans,
  isPostgresConfigured: mocks.isPostgresConfigured,
  getLogs: mocks.getLogs,
};

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};
mockModule('../services/engine/manager', managerMock);
mockModule('../services/market-summary', marketSummaryMock);
mockModule('../services/dashboard-status', dashboardStatusMock);
mockModule('../services/private-account-status', privateAccountStatusMock);
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
    mocks.publicMarketData.USD = { frr: 0.0004, tickerLastUpdate: Date.now() };
    mocks.getMarketData.mockImplementation((currency: string) => currency === 'USD' ? mocks.publicMarketData.USD : null);
  });

  it('returns the authenticated user engine status and an inactive fallback', async () => {
    const active = await request(app).get('/api/dashboard/overview').expect(200);
    expect(active.body).toEqual({ running: true, userId: 'user-a' });
    expect(mocks.getBot).toHaveBeenCalledWith('user-a');

    mocks.getBot.mockReturnValueOnce(null);
    const inactive = await request(app).get('/api/dashboard/overview').expect(200);
    expect(inactive.body).toEqual({ running: false, inactive: true });
    expect(mocks.getInactiveDashboardStatusForUser).toHaveBeenCalledWith('user-a');
  });

  it('returns read-only private account data when the engine is stopped', async () => {
    mocks.getBot.mockReturnValueOnce(null);
    mocks.getInactiveDashboardStatusForUser.mockResolvedValueOnce({
      running: false,
      accountDataAvailable: true,
      activeOffers: { USD: 2 },
      activeCredits: { USD: 4 },
    });

    const res = await request(app).get('/api/dashboard/overview').expect(200);
    expect(res.body.accountDataAvailable).toBe(true);
    expect(res.body.activeCredits).toEqual({ USD: 4 });
    expect(mocks.getInactiveDashboardStatusForUser).toHaveBeenCalledWith('user-a');
  });

  it('returns full private account records from the stopped detailed endpoint', async () => {
    mocks.getBot.mockReturnValueOnce(null);
    mocks.getInactiveDashboardStatusForUser.mockResolvedValueOnce({
      running: false,
      accountDataAvailable: true,
      activeCredits: { USD: [{ id: 1, amount: 100 }] },
    });

    const res = await request(app).get('/api/dashboard/detailed').expect(200);
    expect(res.body.activeCredits.USD).toEqual([{ id: 1, amount: 100 }]);
    expect(mocks.getInactiveDashboardStatusForUser).toHaveBeenCalledWith('user-a', { detailed: true });
  });

  it('uses the shared public market service without exposing private tenant data', async () => {
    const res = await request(app).get('/api/dashboard/funding-market').expect(200);
    expect(res.body.currentApy).toBe(8.9);
    expect(mocks.getCachedFundingMarketSummary).toHaveBeenCalledWith(expect.objectContaining({
      publicWs: expect.any(Object),
      db: expect.any(Object),
    }));
  });

  it('rejects non-USD rate history requests', async () => {
    await request(app).get('/api/dashboard/rate-history/USDT').expect(400);
    expect(mocks.getRateHistory).not.toHaveBeenCalled();
  });

  it('always requests a fixed 30-day rate history window', async () => {
    await request(app).get('/api/dashboard/rate-history/USD?hours=24').expect(200);
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
    expect(res.body.utilizationDataAvailable).toBe(true);
    expect(res.body.utilizationDataSource).toContain('Bitfinex 私有 WebSocket');
  });

  it('adds Oracle numeric-string earnings as numbers instead of concatenating them', async () => {
    mocks.getEarnings.mockResolvedValue([
      { currency: 'USD', amount: '1.8603', earned_at: '2026-10-04T01:00:00Z' },
      { currency: 'USD', amount: '2.1397', earned_at: '2026-10-03T01:00:00Z' },
    ]);

    const res = await request(app).get('/api/dashboard/earnings/stats').expect(200);

    expect(res.body.today).toEqual({ byCurrency: { USD: 4 }, total: 4 });
    expect(res.body.allTime).toEqual({ byCurrency: { USD: 4 }, total: 4 });
  });

  it('adds Oracle numeric-string earnings correctly in the heatmap', async () => {
    mocks.getEarnings.mockResolvedValue([
      { currency: 'USD', amount: '1.8603', earned_at: '2026-10-04T01:00:00Z' },
      { currency: 'USD', amount: '2.1397', earned_at: '2026-10-04T02:00:00Z' },
    ]);

    const res = await request(app).get('/api/dashboard/earnings/heatmap').expect(200);

    expect(res.body).toEqual([{ date: '2026-10-04', amount: 4 }]);
  });

  it('groups earnings when PostgreSQL returns earned_at as Date objects', async () => {
    mocks.getEarnings.mockResolvedValue([
      { currency: 'USD', amount: '1.25', earned_at: new Date('2026-10-04T01:00:00Z') },
      { currency: 'USD', amount: '2.75', earned_at: new Date('2026-10-04T02:00:00Z') },
      { currency: 'USD', amount: '50', earned_at: new Date('invalid') },
    ]);

    const res = await request(app).get('/api/dashboard/earnings/heatmap').expect(200);

    expect(res.body).toEqual([{ date: '2026-10-04', amount: 4 }]);
  });

  it('keeps stopped-engine utilization unavailable when private Bitfinex data cannot be read', async () => {
    mocks.getBot.mockReturnValueOnce(null);
    const res = await request(app).get('/api/dashboard/earnings/stats').expect(200);
    expect(res.body.utilization).toBeNull();
    expect(res.body.utilizationDataAvailable).toBe(false);
    expect(res.body.utilizationError).toContain('signature invalid');
    expect(mocks.getReadOnlyAccountSnapshot).toHaveBeenCalledWith('user-a');
  });

  it('resets only the requested tenant earnings and engine counters', async () => {
    await request(app).post('/api/dashboard/earnings/reset').send({ currency: 'USD' }).expect(200);
    expect(mocks.deleteEarnings).toHaveBeenCalledWith('USD', 'user-a');
    expect(mocks.engine.state.stats.totalEarned.USD).toBe(0);
  });

  it('keeps history queries scoped to the authenticated tenant', async () => {
    const offers = await request(app).get('/api/dashboard/history/offers?currency=USD').expect(200);
    expect(offers.headers['x-data-source']).toBe('Oracle PostgreSQL');
    expect(offers.headers['x-record-scope']).toBe('Bot-tracked active offers');
    await request(app).get('/api/dashboard/history/loans?currency=USD').expect(200);
    expect(mocks.getActiveOffers).toHaveBeenCalledWith('USD', 'user-a');
    expect(mocks.getActiveLoans).toHaveBeenCalledWith('USD', 'user-a');
  });

  it('rejects non-USD history queries', async () => {
    await request(app).get('/api/dashboard/history/offers?currency=USDT').expect(400);
    await request(app).get('/api/dashboard/history/loans?currency=USDT').expect(400);
    expect(mocks.getActiveOffers).not.toHaveBeenCalled();
    expect(mocks.getActiveLoans).not.toHaveBeenCalled();
  });

  it('returns a database error instead of pretending a failed history query is empty', async () => {
    mocks.getActiveLoans.mockRejectedValueOnce(new Error('Oracle read failed'));
    const res = await request(app).get('/api/dashboard/history/loans').expect(500);
    expect(res.body.error).toBe('Oracle read failed');
  });
});
