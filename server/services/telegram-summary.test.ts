import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getEarnings = vi.fn();
const getUsdToTwdRate = vi.fn();
const getAverageFRR = vi.fn();
const getUserSettings = vi.fn();

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};

mockModule('../config', {
  bitfinex: { restUrl: 'https://api.test/v2' },
  lending: { currencyMap: { USD: 'USD', USDT: 'UST' }, symbolToCurrency: { USD: 'USD', UST: 'USDT' } },
  telegram: {},
});
mockModule('../utils/logger', { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
mockModule('./database', { getEarnings, getAverageFRR, getUserSettings });
mockModule('./exchange-rate', {
  getUsdToTwdRate,
  convertToTwd: (amount: number, currency: string, quote: { rate: number } | null) => {
    if (!quote) return null;
    return Number(amount) * quote.rate;
  },
});

const {
  buildUserSummaryMessage,
  buildGlobalSummaryMessage,
  formatFundingMarketSection,
  buildInactiveUserSummaryMessage,
} = require('./telegram');

describe('Telegram daily summary currency display', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));
    vi.clearAllMocks();
    getAverageFRR.mockImplementation(async (currency: string) => currency === 'USD' ? 0 : 0.000262);
    getUserSettings.mockResolvedValue(null);
    getUsdToTwdRate.mockResolvedValue({
      rate: 31.5,
      source: 'ExchangeRate-API',
      quoteDate: '2026-08-30T00:02:31.000Z',
      stale: false,
    });
    getEarnings.mockImplementation(async (currency: string | null, from: string | null, to: string | null) => {
      if (to) return [{ amount: 2.0223, currency: 'USD' }];
      if (from && Date.now() - Date.parse(from) > 20 * 24 * 60 * 60 * 1000) {
        return [{ amount: 10, currency: 'USD' }];
      }
      if (from) return [{ amount: 2.1649, currency: 'USD' }, { amount: 1, currency: 'USDT' }];
      return [
        { amount: 127.2498, currency: 'USD' },
        { amount: 1, currency: 'USDT' },
      ];
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows wallet conversion in parentheses and reports earnings in TWD', async () => {
    const engine = {
      getDetailedStatus: () => ({
        wallets: { USD: { balance: '6048.57', available: '5000' } },
        activeOffers: { USD: [{ amount: '500' }] },
        activeCredits: {
          USD: [
            { amount: '548.57', period: 2, openedAt: '2026-08-28T04:00:00.000Z' },
            { amount: '100', period: 30, openedAt: '2026-08-01T04:00:00.000Z' },
          ],
        },
      }),
    };

    const message = await buildUserSummaryMessage(
      'user-a',
      engine,
      {},
      { getMarketData: () => null },
      { getEarnings },
      null,
    );

    expect(message).toContain('錢包總額: $6,048.57（約 NT$190,529.96）');
    expect(message).toContain('貸款中 2 筆 ($548.57(8/30)、$100.00(8/31))');
    expect(message).toContain('量化收益回報（TWD，已扣稅）');
    expect(message).toContain('來源：<a href="https://www.exchangerate-api.com">ExchangeRate-API</a>');
    expect(message).toContain('今日收益: <b>NT$99.6944</b>');
    expect(message).toContain('昨日收益: <b>NT$63.7025</b>');
    expect(message).toContain('本月收益: <b>NT$315.0000</b>');
    expect(message).toContain('累計收益: <b>NT$4,039.8687</b>');
    expect(message).not.toContain('今日收益: <b>$');
  });

  it('keeps the loan amount readable when repayment fields are unavailable', async () => {
    const engine = {
      getDetailedStatus: () => ({
        wallets: { USD: { balance: 100, available: 0 } },
        activeOffers: { USD: [] },
        activeCredits: { USD: [{ amount: '-25' }] },
      }),
    };

    const message = await buildUserSummaryMessage(
      'user-a',
      engine,
      {},
      { getMarketData: () => null },
      { getEarnings },
      null,
    );

    expect(message).toContain('貸款中 1 筆 ($25.00)');
  });

  it('reads the admin seven-day FRR average from history even with no strategy cache', async () => {
    const message = await buildGlobalSummaryMessage(
      { historicalFRR: {} },
      { getMarketData: currency => currency === 'USD' ? { frr: 0 } : { frr: 0.0002 } },
      { getAverageFRR },
      null,
    );

    expect(message).toContain('USD 市場</b>: FRR 0.0000%/天 | 7d 均值 0.0000%/天');
    expect(message).toContain('USDT 市場</b>: FRR 0.0200%/天 | 7d 均值 0.0262%/天');
    expect(getAverageFRR).toHaveBeenCalledWith('USD', 168);
    expect(getAverageFRR).toHaveBeenCalledWith('USDT', 168);
  });

  it('renders all 24 hourly buckets, including hours with no fills', () => {
    const now = Date.now();
    const rows = Array.from({ length: 24 }, (_, index) => ({
      timestamp: now - index * 60 * 60 * 1000,
      amount: index ? 0 : 500,
      minApy: index ? null : 4.5,
      maxApy: index ? null : 4.5,
      count: index ? 0 : 1,
    }));

    const message = formatFundingMarketSection({ hourlyMatches24: rows });

    expect(message).toContain('近 24 小時逐時撮合');
    expect((message.match(/筆/g) || []).length).toBe(24);
    expect(message).toContain('無成交');
  });

  it('uses the actual flat market summary fields for a stopped Telegram account', () => {
    const message = buildInactiveUserSummaryMessage(
      { user_id: 'user-a', status: 'stopped' },
      { currentApy: 4.59, high24hApy: 10.95, high30dApy: 11.68 },
      null,
    );

    expect(message).toContain('目前成交均值：4.59%');
    expect(message).toContain('24 小時最高：10.95%');
    expect(message).toContain('30 日最高：11.68%');
  });
});
