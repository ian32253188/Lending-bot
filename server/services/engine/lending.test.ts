import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWallets: vi.fn(),
  getActiveFundingOffers: vi.fn(),
  getActiveFundingCredits: vi.fn(),
  getActiveFundingLoans: vi.fn(),
  saveLoan: vi.fn(),
  closeLoan: vi.fn(),
  saveUserSettings: vi.fn(),
  submitFundingOffer: vi.fn(),
  strategy: {
    ibrrHistory: {},
    getStatus: vi.fn().mockReturnValue({}),
    shouldPause: vi.fn(),
    detectRateSpike: vi.fn(),
    calculateOptimalRate: vi.fn(),
  },
  getCachedFundingMarketSummary: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};

mockModule('../../config', { lending: { currencies: ['USD'] } });
mockModule('../../utils/logger', mocks.logger);
mockModule('../database', {
  saveLoan: mocks.saveLoan,
  closeLoan: mocks.closeLoan,
  saveUserSettings: mocks.saveUserSettings,
});
mockModule('../bitfinex/rest', {
  getWallets: mocks.getWallets,
  getActiveFundingOffers: mocks.getActiveFundingOffers,
  getActiveFundingCredits: mocks.getActiveFundingCredits,
  getActiveFundingLoans: mocks.getActiveFundingLoans,
  submitFundingOffer: mocks.submitFundingOffer,
  parseWallet: (row: any) => row,
  parseFundingOffer: (row: any) => row,
  parseFundingCredit: (row: any) => row,
});
mockModule('../bitfinex/ws', {
  getBitfinexPublicWS: () => ({ getMarketData: () => ({ frr: 0.001 }), isConnected: () => true }),
  createBitfinexPrivateWS: vi.fn(() => new (require('events').EventEmitter)()),
  isPublicTickerFresh: () => true,
});
mockModule('./strategy', { getStrategyEngine: () => mocks.strategy });
mockModule('../market-summary', { getCachedFundingMarketSummary: mocks.getCachedFundingMarketSummary });
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
    mocks.saveUserSettings.mockResolvedValue({});
    mocks.submitFundingOffer.mockReset().mockResolvedValue([]);
    mocks.closeLoan.mockResolvedValue([]);
    mocks.strategy.shouldPause.mockReturnValue({ pause: false });
    mocks.strategy.detectRateSpike.mockReturnValue([]);
    mocks.strategy.calculateOptimalRate.mockReturnValue({ shouldOffer: false, reason: 'test' });
    mocks.getCachedFundingMarketSummary.mockResolvedValue({
      currentRate: 0.001,
      high24h: 0.001,
      high30d: 0.001,
      currentApy: null,
      high24hApy: null,
      high30dApy: null,
    });
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

  it('backfills active Bitfinex lending positions into the local loan history', async () => {
    const openedAt = new Date('2026-10-03T08:30:00Z');
    mocks.getActiveFundingCredits.mockResolvedValueOnce([
      { id: 77, currency: 'USD', side: 1, amount: '-500', rate: 0.0003, period: 2, openedAt },
    ]);
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' });

    await bot._loadInitialState();

    expect(mocks.saveLoan).toHaveBeenCalledWith({
      id: 77,
      currency: 'USD',
      amount: 500,
      rate: 0.0003,
      period: 2,
      openedAt,
      status: 'active',
    }, 'user-a');
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
    expect(status.wallets).toEqual({ USD: { balance: 25, available: 10 } });
    expect(status.activeOffers).toEqual({ USD: 0 });
    expect(status.activeCredits).toEqual({ USD: 0 });
  });

  it('解除 Bitfinex 維護暫停時恢復原本未暫停的引擎', () => {
    const { EventEmitter } = require('events');
    const socket = new EventEmitter();
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' });
    bot._setupWSListeners(socket);

    socket.emit('maintenance', true);
    expect(bot.paused).toBe(true);
    expect(bot.pauseReason).toBe('Bitfinex 系統維護中');

    socket.emit('maintenance', false);
    expect(bot.paused).toBe(false);
    expect(bot.pauseReason).toBe('');
    expect(mocks.saveUserSettings).toHaveBeenLastCalledWith('user-a', {
      status: 'running',
      pause_reason: '',
      manual_pause_reason: '',
      maintenance_paused: false,
    });
  });

  it('維護結束後仍保留先前的手動或緊急暫停', () => {
    const { EventEmitter } = require('events');
    const socket = new EventEmitter();
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' });
    bot._setupWSListeners(socket);
    bot.pause('緊急停止');

    socket.emit('maintenance', true);
    socket.emit('maintenance', false);

    expect(bot.paused).toBe(true);
    expect(bot.pauseReason).toBe('緊急停止');
    expect(mocks.saveUserSettings).toHaveBeenLastCalledWith('user-a', {
      status: 'paused',
      pause_reason: '緊急停止',
      manual_pause_reason: '緊急停止',
      maintenance_paused: false,
    });
  });

  it('維護期間的明確 resume 不會提前解除維護暫停', () => {
    const { EventEmitter } = require('events');
    const socket = new EventEmitter();
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' });
    bot._setupWSListeners(socket);
    socket.emit('maintenance', true);

    expect(bot.resume()).toBe(false);
    expect(bot.paused).toBe(true);
    expect(bot.pauseReason).toBe('Bitfinex 系統維護中');
    expect(mocks.saveUserSettings).toHaveBeenLastCalledWith('user-a', {
      status: 'paused',
      pause_reason: 'Bitfinex 系統維護中',
      manual_pause_reason: '',
      maintenance_paused: true,
    });
  });

  it('從持久化狀態還原維護來源後，maintenance=false 可解除暫停', () => {
    const { EventEmitter } = require('events');
    const socket = new EventEmitter();
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' });
    bot.restorePauseState({
      manualPauseReason: '',
      maintenancePaused: true,
      pauseReason: 'Bitfinex 系統維護中',
    });
    bot._setupWSListeners(socket);

    expect(bot.paused).toBe(true);
    socket.emit('maintenance', false);

    expect(bot.paused).toBe(false);
    expect(bot.pauseReason).toBe('');
    expect(mocks.saveUserSettings).toHaveBeenLastCalledWith('user-a', {
      status: 'running',
      pause_reason: '',
      manual_pause_reason: '',
      maintenance_paused: false,
    });
  });

  it('keeps compounding enabled and clears legacy held interest', async () => {
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' }, {
      compoundingEnabled: false,
      compoundingHoldAmount: 12.5,
    });
    bot.running = true;
    bot._debouncedDecision = vi.fn();

    await bot.setCompounding(true);

    expect(mocks.saveUserSettings).toHaveBeenCalledWith('user-a', {
      compounding_enabled: true,
      compounding_hold_amount: 0,
    });
    expect(bot.compoundingEnabled).toBe(true);
    expect(bot.compoundingHoldAmount).toBeUndefined();
    expect(bot._debouncedDecision).toHaveBeenCalledWith('USD', 1000);
  });

  it('closes a repaid loan without estimating interest from its original term', () => {
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' }, {
      compoundingEnabled: false,
    });
    bot.running = true;
    bot.state.activeCredits.USD = [{ id: 88 }];
    bot._debouncedDecision = vi.fn();

    bot._handleFundingClose({
      id: 88,
      currency: 'USD',
      side: 1,
      amount: '-500',
      rate: 0.001,
      period: 10,
    });

    expect(mocks.closeLoan).toHaveBeenCalledWith(88, null, 'user-a');
    expect(bot.compoundingHoldAmount).toBeUndefined();
    expect(bot._debouncedDecision).toHaveBeenCalledWith('USD', 2000);
    clearTimeout(bot.pendingEarningsSyncTimer);
  });

  it('uses the full available USD balance and ignores legacy compounding reserves', async () => {
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' }, {
      compoundingEnabled: false,
      compoundingHoldAmount: 100,
    });
    bot.state.wallets.USD = { balance: 500, available: 500 };

    await bot._processForCurrency('USD');

    expect(mocks.strategy.calculateOptimalRate).toHaveBeenCalledWith(
      expect.objectContaining({ frr: 0.001 }),
      'USD',
      500,
      bot.strategyConfig,
    );
    expect(bot.compoundingEnabled).toBe(true);
    expect(bot.compoundingHoldAmount).toBeUndefined();
  });

  it('does not reserve balance from legacy settings when available USD is below the minimum', async () => {
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' }, {
      compoundingEnabled: false,
      compoundingHoldAmount: 100,
    });
    bot.state.wallets.USD = { balance: 50, available: 50 };

    await bot._processForCurrency('USD');

    expect(bot.compoundingEnabled).toBe(true);
    expect(bot.compoundingHoldAmount).toBeUndefined();
    expect(mocks.strategy.calculateOptimalRate).toHaveBeenCalledWith(
      expect.any(Object), 'USD', 50, bot.strategyConfig,
    );
  });

  it('pauses auto-lending after an ambiguous offer result to prevent a later duplicate submission', async () => {
    const bot = new LendingBot('user-a', { apiKey: 'key', apiSecret: 'secret' });
    bot.running = true;
    bot.state.wallets.USD = { balance: 500, available: 500 };
    bot.bfxWs = { isConnected: () => true, isAuthenticated: () => true };
    mocks.strategy.calculateOptimalRate.mockReturnValue({
      shouldOffer: true,
      orders: [{ amount: 500, rate: 0.0004, period: 10 }],
      reason: '',
    });
    mocks.submitFundingOffer.mockRejectedValueOnce(Object.assign(
      new Error('Funding Offer 結果不明；請先查詢 Bitfinex 狀態，再決定是否重新提交。'),
      { code: 'BITFINEX_WRITE_RESULT_UNKNOWN' },
    ));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await Promise.all([
        bot._processForCurrency('USD'),
        bot._processForCurrency('USD'),
      ]);
      await bot._decisionCycle();

      expect(bot.paused).toBe(true);
      expect(bot.pauseReason).toContain('Funding Offer 結果待查證');
      expect(mocks.submitFundingOffer).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
