import { describe, expect, it, vi } from 'vitest';

const configMock = {
  bitfinex: {
    wsUrl: 'wss://api.test/ws',
    apiKey: 'global-key',
    apiSecret: 'global-secret',
  },
  lending: {
    currencies: ['USD', 'USDT'],
    currencyMap: { USD: 'USD', USDT: 'UST' },
    symbolToCurrency: { USD: 'USD', UST: 'USDT' },
  },
};

const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};
mockModule('../../config', configMock);
mockModule('../../utils/logger', loggerMock);

const { BitfinexWS, getBitfinexPublicWS, createBitfinexPrivateWS, isPublicTickerFresh } = require('./ws');

describe('Bitfinex public WebSocket adapter', () => {
  it('updates ticker cache and emits a normalized ticker event', () => {
    const ws = new BitfinexWS({ publicOnly: true });
    const listener = vi.fn();
    ws.on('tickerUpdate', listener);
    ws._handleEvent({ event: 'subscribed', chanId: 7, channel: 'ticker', symbol: 'fUST' });
    ws._handleMessage([7, [0.0003, 0.0004, 1000, 2, 0.0005, 800, 7, 0.00001, 0.02, 1, 250000, 0.0006, 0.0002, 0, 0, 5000]]);

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ currency: 'USDT' }));
    expect(ws.getMarketData('USDT')).toMatchObject({
      frr: 0.0003,
      bid: 0.0004,
      ask: 0.0005,
      volume: 250000,
      high: 0.0006,
      low: 0.0002,
      frrAmountAvailable: 5000,
      tickerLastUpdate: expect.any(Number),
    });
    expect(isPublicTickerFresh(ws.getMarketData('USDT'))).toBe(true);
  });

  it('keeps missing ticker rates null and does not treat a funding-book update as a fresh ticker', () => {
    const ws = new BitfinexWS({ publicOnly: true });
    expect(ws.getMarketData('USD').frr).toBeNull();
    expect(isPublicTickerFresh(ws.getMarketData('USD'))).toBe(false);

    ws._handleEvent({ event: 'subscribed', chanId: 10, channel: 'book', symbol: 'fUSD' });
    ws._handleMessage([10, [[0.0005, 2, 1, 100]]]);

    expect(ws.getMarketData('USD').lastUpdate).toEqual(expect.any(Number));
    expect(ws.getMarketData('USD').tickerLastUpdate).toBeNull();
    expect(isPublicTickerFresh(ws.getMarketData('USD'))).toBe(false);
  });

  it('splits funding book snapshots into sorted bid and ask sides', () => {
    const ws = new BitfinexWS({ publicOnly: true });
    const listener = vi.fn();
    ws.on('bookSnapshot', listener);
    ws._handleEvent({ event: 'subscribed', chanId: 8, channel: 'book', symbol: 'fUSD' });
    ws._handleMessage([8, [[0.0005, 2, 1, 100], [0.0003, 2, 1, 200], [0.0004, 2, 1, -300]]]);

    expect(ws.getMarketData('USD').bids.map((row: { rate: number }) => row.rate)).toEqual([0.0005, 0.0003]);
    expect(ws.getMarketData('USD').asks).toEqual([{ rate: 0.0004, period: 2, count: 1, amount: 300 }]);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ currency: 'USD' }));
  });

  it('applies book add, update and delete messages to the cache', () => {
    const ws = new BitfinexWS({ publicOnly: true });
    ws._handleEvent({ event: 'subscribed', chanId: 9, channel: 'book', symbol: 'fUSD' });
    ws._handleMessage([9, [0.0002, 2, 1, 100]]);
    ws._handleMessage([9, [0.0004, 2, 1, 200]]);
    expect(ws.getMarketData('USD').bids.map((row: { rate: number }) => row.rate)).toEqual([0.0004, 0.0002]);

    ws._handleMessage([9, [0.0002, 3, 2, 250]]);
    expect(ws.getMarketData('USD').bids[1]).toMatchObject({ period: 2, count: 2, amount: 250 });
    ws._handleMessage([9, [0.0006, 2, 1, -150]]);
    ws._handleMessage([9, [0.0006, 0, 0, 0]]);
    expect(ws.getMarketData('USD').bids.map((row: { rate: number }) => row.rate)).toEqual([0.0004, 0.0002]);
    expect(ws.getMarketData('USD').asks).toEqual([]);
  });

  it('tracks authentication and maintenance events', () => {
    const ws = new BitfinexWS();
    const authenticated = vi.fn();
    const maintenance = vi.fn();
    const authError = vi.fn();
    ws.on('authenticated', authenticated);
    ws.on('maintenance', maintenance);
    ws.on('authError', authError);

    ws._handleEvent({ event: 'auth', status: 'OK' });
    ws._handleEvent({ event: 'info', code: 20060 });
    ws._handleEvent({ event: 'info', code: 20061 });
    ws._handleEvent({ event: 'auth', status: 'ERROR', msg: 'bad key' });

    expect(ws.isAuthenticated()).toBe(true);
    expect(authenticated).toHaveBeenCalledOnce();
    expect(maintenance.mock.calls.map(call => call[0])).toEqual([true, false]);
    expect(authError).toHaveBeenCalledWith(expect.objectContaining({ msg: 'bad key' }));
  });

  it('uses one shared public instance while private clients remain isolated', () => {
    const publicA = getBitfinexPublicWS();
    const publicB = getBitfinexPublicWS();
    const privateA = createBitfinexPrivateWS({ apiKey: 'a', apiSecret: 'a-secret' });
    const privateB = createBitfinexPrivateWS({ apiKey: 'b', apiSecret: 'b-secret' });

    expect(publicA).toBe(publicB);
    expect(privateA).not.toBe(privateB);
    expect(privateA.credentials).toEqual({ apiKey: 'a', apiSecret: 'a-secret' });
    publicA.disconnect();
    privateA.disconnect();
    privateB.disconnect();
  });
});
