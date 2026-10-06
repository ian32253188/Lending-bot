import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const configMock = {
  bitfinex: {
    restUrl: 'https://api.test/v2',
    apiKey: undefined,
    apiSecret: undefined,
  },
  lending: {
    currencyMap: { USD: 'USD' },
    symbolToCurrency: { USD: 'USD' },
  },
};

const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const retryMock = {
  withRetry: (operation: () => unknown) => operation(),
};

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};
mockModule('../../config', configMock);
mockModule('../../utils/logger', loggerMock);
mockModule('../../utils/retry', retryMock);

const rest = require('./rest');

function okResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(''),
  };
}

describe('Bitfinex REST adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects non-USD symbols for public ticker requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([0.0003]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(rest.getFundingTicker('USDT')).rejects.toThrow('目前僅支援 USD Funding。');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes only provided public trade query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await rest.getFundingTrades('USD', { limit: 25, start: 100, end: null, sort: undefined });

    expect(fetchMock).toHaveBeenCalledWith('https://api.test/v2/trades/fUSD/hist?limit=25&start=100');
  });

  it('links private Funding Trades by the documented OFFER_ID field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([[31, 'fUSD', 1700000000000, 987654, -500, 0.0004, 2]]));
    vi.stubGlobal('fetch', fetchMock);

    const trades = await rest.getUserFundingTrades('USD', { start: 100, end: 200, limit: 20 }, {
      apiKey: 'research-key', apiSecret: 'research-secret',
    });

    expect(fetchMock).toHaveBeenCalledWith('https://api.test/v2/auth/r/funding/trades/fUSD/hist', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ start: 100, end: 200, limit: 20 });
    expect(trades).toEqual([{ id: 31, timestamp: 1700000000000, offerId: 987654, amount: 500, rate: 0.0004, period: 2 }]);
  });

  it('requests hourly public funding candles for the mapped Bitfinex symbol', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await rest.getFundingCandles('USD', { limit: 1000, sort: -1 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/v2/candles/trade:1h:fUSD:a30:p2:p30/hist?limit=1000&sort=-1',
    );
  });

  it('uses per-user credentials and a Bitfinex HMAC signature for private calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([{ type: 'funding' }]));
    vi.stubGlobal('fetch', fetchMock);
    const body = { currency: 'USD' };

    await rest.authRequest('/auth/r/wallets', body, { apiKey: 'user-key', apiSecret: 'user-secret' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/v2/auth/r/wallets');
    expect(options.method).toBe('POST');
    expect(options.headers['bfx-apikey']).toBe('user-key');
    expect(options.headers['bfx-nonce']).toMatch(/^\d+$/);
    const expectedSignature = crypto
      .createHmac('sha384', 'user-secret')
      .update(`/api/v2/auth/r/wallets${options.headers['bfx-nonce']}${JSON.stringify(body)}`)
      .digest('hex');
    expect(options.headers['bfx-signature']).toBe(expectedSignature);
    expect(options.body).toBe(JSON.stringify(body));
  });

  it('serializes private requests that use the same API key to preserve nonce order', async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => {
        firstStarted?.();
        return new Promise(resolve => { releaseFirst = resolve; });
      })
      .mockResolvedValueOnce(okResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const credentials = { apiKey: 'shared-key', apiSecret: 'shared-secret' };
    const first = rest.authRequest('/auth/r/wallets', {}, credentials);
    const second = rest.authRequest('/auth/r/funding/offers/fUSD', {}, credentials);
    await started;
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFirst?.(okResponse([]));
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const nonces = fetchMock.mock.calls.map(([, options]) => Number(options.headers['bfx-nonce']));
    expect(nonces[1]).toBeGreaterThan(nonces[0]);
  });

  it('rejects an authenticated request before fetch when credentials are missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(rest.authRequest('/auth/r/wallets', {}, { apiKey: '', apiSecret: '' }))
      .rejects.toThrow('Bitfinex API key or secret is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps funding offer and transfer payloads to Bitfinex API fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await rest.submitFundingOffer('USD', 500, 0.0004, 10, { apiKey: 'key', apiSecret: 'secret' });
    await rest.transfer('exchange', 'funding', 'USD', 123.45, { apiKey: 'key', apiSecret: 'secret' });

    const offerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(offerBody).toMatchObject({ type: 'LIMIT', symbol: 'fUSD', amount: '500', rate: '0.0004', period: 10 });
    const transferBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(transferBody).toEqual({ from: 'exchange', to: 'funding', currency: 'USD', currency_to: 'USD', amount: '123.45' });
  });

  it('converts Bitfinex array responses into isolated domain objects', () => {
    const offer = rest.parseFundingOffer([1, 'fUSD', 1700000000000, 1700000001000, '500', '500', 'LIMIT', null, null, 0, 'ACTIVE', null, null, null, '0.0004', 10, 0, 0, null, 0]);
    const credit = rest.parseFundingCredit([2, 'fUSD', 'CREDIT', 1700000000000, 1700000001000, '250', 0, 'ACTIVE', null, null, null, '0.0003', 7, 1700000002000, null]);
    const wallet = rest.parseWallet(['funding', 'USD', '1000', '2', '998']);

    expect(offer).toMatchObject({ id: 1, currency: 'USD', amount: '500', period: 10 });
    expect(credit).toMatchObject({ id: 2, currency: 'USD', amount: '250', period: 7 });
    expect(wallet).toMatchObject({ type: 'funding', currency: 'USD', rawCurrency: 'USD', balance: '1000', available: '998' });
    expect(rest.parseFundingOffer([3, 'fUST'])).toBeNull();
    expect(rest.parseWallet(['funding', 'UST', '50', '0', '50'])).toBeNull();
  });

  it('turns public HTTP failures into an actionable error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue('rate limited'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(rest.getFundingBook('USD')).rejects.toThrow('Bitfinex API 公開端點錯誤 (429)');
  });
});
