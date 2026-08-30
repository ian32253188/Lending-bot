import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEarnings = vi.fn();
const getUsdToTwdRate = vi.fn();

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
mockModule('./database', { getEarnings });
mockModule('./exchange-rate', {
  getUsdToTwdRate,
  convertToTwd: (amount: number, currency: string, quote: { rate: number } | null) => {
    if (!quote) return null;
    return Number(amount) * quote.rate;
  },
});

const { buildUserSummaryMessage } = require('./telegram');

describe('Telegram daily summary currency display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('shows wallet conversion in parentheses and reports earnings in TWD', async () => {
    const engine = {
      getDetailedStatus: () => ({
        wallets: { USD: { balance: '6048.57', available: '5000' } },
        activeOffers: { USD: [{ amount: '500' }] },
        activeCredits: { USD: [{ amount: '548.57' }] },
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
    expect(message).toContain('量化收益回報（TWD，已扣稅）');
    expect(message).toContain('來源：<a href="https://www.exchangerate-api.com">ExchangeRate-API</a>');
    expect(message).toContain('今日收益: <b>NT$99.6944</b>');
    expect(message).toContain('昨日收益: <b>NT$63.7025</b>');
    expect(message).toContain('本月收益: <b>NT$315.0000</b>');
    expect(message).toContain('累計收益: <b>NT$4,039.8687</b>');
    expect(message).not.toContain('今日收益: <b>$');
  });
});
