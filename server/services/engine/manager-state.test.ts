import { beforeEach, describe, expect, it, vi } from 'vitest';

const userId = '11111111-1111-4111-8111-111111111111';
const saveUserSettings = vi.fn().mockResolvedValue(null);
const getUserSettings = vi.fn().mockResolvedValue({
  bitfinex_api_key: 'key',
  bitfinex_api_secret: 'secret',
  status: 'paused',
  pause_reason: '手動暫停',
  lending_currencies: ['USD'],
  strategy_config: { rateStrategy: 'current_avg', periodDays: 2 },
});
const getUsersToResume = vi.fn().mockResolvedValue([{ user_id: userId, status: 'paused', pause_reason: '手動暫停' }]);

const publicWs = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn().mockReturnValue(false),
  getMarketData: vi.fn().mockReturnValue(null),
};

class MockLendingBot {
  running = false;
  paused = false;
  pauseReason = '';
  stop = vi.fn(async () => { this.running = false; });

  async start() {
    this.running = true;
  }

  pause(reason: string) {
    this.paused = true;
    this.pauseReason = reason;
  }
}

const moduleMock = (path: string, exports: Record<string, unknown>) => {
  require.cache[require.resolve(path)] = {
    id: require.resolve(path),
    filename: require.resolve(path),
    loaded: true,
    exports,
  } as any;
};

moduleMock('../../utils/logger', {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});
moduleMock('../database', {
  getUserSettings,
  saveUserSettings,
  getUsersToResume,
  getActiveUsers: vi.fn().mockResolvedValue([]),
  saveRateSnapshot: vi.fn(),
  getRateHistory: vi.fn().mockResolvedValue([]),
});
moduleMock('../bitfinex/rest', {});
moduleMock('../bitfinex/ws', { getBitfinexPublicWS: () => publicWs });
moduleMock('./strategy', { getStrategyEngine: () => ({ calculateOptimalRate: vi.fn() }) });
moduleMock('./lending', { LendingBot: MockLendingBot });
moduleMock('../../utils/crypto', { decryptWithFallback: (value: string) => value });

const { getBot, startBot, restartBotPreservingState, shutdownAll } = require('./manager');

describe('Engine manager persisted state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserSettings.mockResolvedValue({
      bitfinex_api_key: 'key',
      bitfinex_api_secret: 'secret',
      status: 'paused',
      pause_reason: '手動暫停',
      lending_currencies: ['USD'],
      strategy_config: { rateStrategy: 'current_avg', periodDays: 2 },
    });
  });

  it('恢復 paused 使用者時會保留暫停狀態', async () => {
    const bot = await startBot(userId);

    expect(bot).toBe(getBot(userId));
    expect(bot.paused).toBe(true);
    expect(bot.pauseReason).toBe('手動暫停');

    saveUserSettings.mockClear();
    const restartedBot = await restartBotPreservingState(userId);
    expect(restartedBot.paused).toBe(true);
    expect(saveUserSettings).not.toHaveBeenCalledWith(userId, { status: 'stopped' });
  });

  it('程序關閉時停止引擎但不把 persisted status 改成 stopped', async () => {
    await shutdownAll();

    expect(saveUserSettings).not.toHaveBeenCalledWith(userId, { status: 'stopped' });
  });
});
