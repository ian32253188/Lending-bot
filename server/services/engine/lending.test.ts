import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWallets: vi.fn(),
  getActiveFundingOffers: vi.fn(),
  getActiveFundingCredits: vi.fn(),
  getActiveFundingLoans: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};

mockModule('../../config', { lending: { currencies: ['USD', 'USDT'] } });
mockModule('../../utils/logger', mocks.logger);
mockModule('../database', {});
mockModule('../bitfinex/rest', {
  getWallets: mocks.getWallets,
  getActiveFundingOffers: mocks.getActiveFundingOffers,
  getActiveFundingCredits: mocks.getActiveFundingCredits,
  getActiveFundingLoans: mocks.getActiveFundingLoans,
  parseWallet: (row: any) => row,
  parseFundingOffer: (row: any) => row,
  parseFundingCredit: (row: any) => row,
});
mockModule('../bitfinex/ws', {
  getBitfinexPublicWS: () => ({ getMarketData: () => null, isConnected: () => true }),
  createBitfinexPrivateWS: vi.fn(() => new (require('events').EventEmitter)()),
  isPublicTickerFresh: () => true,
});
mockModule('./strategy', { getStrategyEngine: () => ({ ibrrHistory: {}, getStatus: () => ({}) }) });
mockModule('../market-summary', { getCachedFundingMarketSummary: vi.fn() });
mockModule('../private-account-status', {
  classifyPrivateApiError: (error: any) => String(error?.message).includes('10100')
    ? { code: 'BITFINEX_SIGNATURE_INVALID', status: 500, message: 'Bitfinex 拒絕 API 簽章。' }
    : { code: 'BITFINEX_PRIVATE_API_ERROR', status: null, message: 'Bitfinex 私有 API 讀取失敗。' },
});

const { LendingBot } = require('./lending');

describe('LendingBot private account status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWallets.mockResolvedValue([
      { type: 'funding', currency: 'USD', balance: 100, available: 20 },
    ]);
    mocks.getActiveFundingOffers.mockResolvedValue([]);
    mocks.getActiveFundingCredits.mockResolvedValue([]);
    mocks.getActiveFundingLoans.mockResolvedValue([]);
  });

  it('marks account data complete only after every private endpoint succeeds', async () => {
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' });

    await bot._loadInitialState();

    const status = bot.getStatus();
    expect(status.accountDataAvailable).toBe(true);
    expect(status.accountDataComplete).toBe(true);
    expect(status.accountDataError).toBeNull();
    expect(status.wallets.USD).toEqual({ balance: 100, available: 20 });
    expect(status.activeCredits.USD).toBe(0);
  });

  it('does not report initialized zeroes when private wallet reads fail', async () => {
    mocks.getWallets.mockRejectedValue(new Error('Bitfinex API 錯誤 (500): ["error",10100,"digest invalid"]'));
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' });

    await bot._loadInitialState();

    const status = bot.getStatus();
    expect(status.accountDataComplete).toBe(false);
    expect(status.accountDataErrorCode).toBe('BITFINEX_SIGNATURE_INVALID');
    expect(status.accountDataError).toContain('拒絕 API 簽章');
    expect(status.accountDataError).not.toContain('digest invalid');
    expect(status.wallets.USD).toEqual({ balance: null, available: null });
  });

  it('treats empty authenticated websocket snapshots as confirmed zero records', () => {
    const { EventEmitter } = require('events');
    const socket = new EventEmitter();
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' });
    bot._setupWSListeners(socket);

    socket.emit('walletSnapshot', [
      { type: 'funding', currency: 'USD', balance: 25, available: 10 },
    ]);
    socket.emit('fundingOfferSnapshot', []);
    socket.emit('fundingCreditSnapshot', []);
    socket.emit('fundingLoanSnapshot', []);

    const status = bot.getStatus();
    expect(status.accountDataComplete).toBe(true);
    expect(status.accountDataError).toBeNull();
    expect(status.wallets.USDT).toEqual({ balance: 0, available: 0 });
    expect(status.activeOffers).toEqual({ USD: 0, USDT: 0 });
    expect(status.activeCredits).toEqual({ USD: 0, USDT: 0 });
  });
});
