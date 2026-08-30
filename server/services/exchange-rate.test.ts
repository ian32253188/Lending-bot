import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const configMock = {
  exchangeRate: {
    primaryUrl: 'https://open.er-api.com/v6/latest/USD',
    fallbackUrl: 'https://api.frankfurter.dev/v2/rate/USD/TWD',
    cacheTtlMs: 24 * 60 * 60 * 1000,
    timeoutMs: 1000,
  },
};

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};

mockModule('../config', configMock);
mockModule('../utils/logger', loggerMock);

const exchangeRate = require('./exchange-rate');

function okResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(payload),
  };
}

describe('USD/TWD exchange rate service', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    exchangeRate.resetExchangeRateCache();
  });

  it('reads the TWD quote from the primary public endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      result: 'success',
      base_code: 'USD',
      time_last_update_utc: 'Sun, 30 Aug 2026 00:02:31 +0000',
      rates: { TWD: 31.66227 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const quote = await exchangeRate.getUsdToTwdRate();

    expect(quote).toMatchObject({ rate: 31.66227, source: 'ExchangeRate-API', stale: false });
    expect(fetchMock).toHaveBeenCalledWith('https://open.er-api.com/v6/latest/USD', expect.objectContaining({
      headers: { accept: 'application/json' },
    }));
    expect(exchangeRate.convertToTwd(2, 'USD', quote)).toBeCloseTo(63.32454);
    expect(exchangeRate.convertToTwd(2, 'USDT', quote)).toBeCloseTo(63.32454);
  });

  it('caches a successful quote so daily summaries do not call the provider repeatedly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ result: 'success', rates: { TWD: 31.5 } }));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeRate.getUsdToTwdRate();
    await exchangeRate.getUsdToTwdRate();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Frankfurter when the primary endpoint fails', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('primary unavailable'))
      .mockResolvedValueOnce(okResponse({ date: '2026-08-28', base: 'USD', quote: 'TWD', rate: 31.657 }));
    vi.stubGlobal('fetch', fetchMock);

    const quote = await exchangeRate.getUsdToTwdRate();

    expect(quote).toMatchObject({ rate: 31.657, source: 'Frankfurter', stale: false });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.frankfurter.dev/v2/rate/USD/TWD', expect.any(Object));
  });

  it('reuses the last quote when a later refresh fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ result: 'success', rates: { TWD: 31.6 } }))
      .mockRejectedValue(new Error('provider unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeRate.getUsdToTwdRate();
    const staleQuote = await exchangeRate.getUsdToTwdRate({ force: true });
    const reusedQuote = await exchangeRate.getUsdToTwdRate();

    expect(staleQuote).toMatchObject({ rate: 31.6, stale: true });
    expect(reusedQuote).toMatchObject({ rate: 31.6, stale: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
