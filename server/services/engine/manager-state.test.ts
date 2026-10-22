import { beforeEach, describe, expect, it, vi } from 'vitest';

const userId = '00000000-0000-0000-0000-000000000001';
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
  manualPauseReason = '';
  maintenancePaused = false;
  stop = vi.fn(async () => { this.running = false; });

  async start() {
    this.running = true;
  }

  pause(reason: string) {
    this.manualPauseReason = reason;
    this.paused = true;
    this.pauseReason = reason;
  }

  restorePauseState({ manualPauseReason, maintenancePaused, pauseReason }: {
    manualPauseReason?: string;
    maintenancePaused?: boolean;
    pauseReason?: string;
  }) {
    this.manualPauseReason = manualPauseReason ?? '';
    this.maintenancePaused = maintenancePaused === true;
    if (!this.manualPauseReason && !this.maintenancePaused) {
      this.manualPauseReason = pauseReason || '重啟前已暫停';
    }
    this.paused = Boolean(this.manualPauseReason) || this.maintenancePaused;
    this.pauseReason = [this.manualPauseReason, this.maintenancePaused ? 'Bitfinex 系統維護中' : '']
      .filter(Boolean).join('、');
  }

  setMaintenancePaused(active: boolean) {
    this.maintenancePaused = active;
    this.paused = Boolean(this.manualPauseReason) || this.maintenancePaused;
    this.pauseReason = [this.manualPauseReason, this.maintenancePaused ? 'Bitfinex 系統維護中' : '']
      .filter(Boolean).join('、');
  }

  resume() {
    this.manualPauseReason = '';
    this.paused = this.maintenancePaused;
    this.pauseReason = this.maintenancePaused ? 'Bitfinex 系統維護中' : '';
    return !this.paused;
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

const { getBot, startBot, restartBotPreservingState, shutdownAll, getEngineStateCounts } = require('./manager');

describe('Engine manager persisted state', () => {
  beforeEach(async () => {
    await shutdownAll();
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
    expect(getEngineStateCounts().paused).toBeGreaterThanOrEqual(1);

    saveUserSettings.mockClear();
    const restartedBot = await restartBotPreservingState(userId);
    expect(restartedBot.paused).toBe(true);
    expect(saveUserSettings).not.toHaveBeenCalledWith(userId, { status: 'stopped' });
  });

  it('恢復 running 使用者時會持久化 running 而不意外改成 stopped', async () => {
    getUserSettings.mockResolvedValueOnce({
      bitfinex_api_key: 'key',
      bitfinex_api_secret: 'secret',
      status: 'running',
      lending_currencies: ['USD'],
      strategy_config: { rateStrategy: 'current_avg', periodDays: 2 },
    });

    const bot = await startBot(userId);

    expect(bot.running).toBe(true);
    expect(saveUserSettings).toHaveBeenCalledWith(userId, expect.objectContaining({
      status: 'running',
      compounding_enabled: true,
      compounding_hold_amount: 0,
      auto_transfer_enabled: false,
    }));
    expect(saveUserSettings).not.toHaveBeenCalledWith(userId, { status: 'stopped' });
  });

  it('管理員重新啟動仍在維護暫停的引擎時不會持久化為 running', async () => {
    const bot = await startBot(userId);
    bot.maintenancePaused = true;
    bot.paused = true;
    bot.pauseReason = 'Bitfinex 系統維護中';
    saveUserSettings.mockClear();

    await startBot(userId);

    expect(bot.paused).toBe(true);
    expect(saveUserSettings).toHaveBeenCalledWith(userId, {
      status: 'paused',
      pause_reason: 'Bitfinex 系統維護中',
    });
    expect(saveUserSettings).not.toHaveBeenCalledWith(userId, {
      status: 'running',
      pause_reason: '',
    });
  });

  it('重啟時還原維護暫停來源，維護結束後可解除', async () => {
    getUserSettings.mockResolvedValueOnce({
      bitfinex_api_key: 'key',
      bitfinex_api_secret: 'secret',
      status: 'paused',
      pause_reason: 'Bitfinex 系統維護中',
      manual_pause_reason: '',
      maintenance_paused: true,
      lending_currencies: ['USD'],
      strategy_config: { rateStrategy: 'current_avg', periodDays: 2 },
    });

    const bot = await startBot(userId);

    expect(bot.paused).toBe(true);
    expect(bot.maintenancePaused).toBe(true);
    expect(bot.manualPauseReason).toBe('');
    bot.setMaintenancePaused(false);
    expect(bot.paused).toBe(false);
    expect(bot.pauseReason).toBe('');
  });

  it('拒絕啟動第二個帳戶，也不讀取或修改其設定', async () => {
    await expect(startBot('another-account')).rejects.toMatchObject({ code: 'SINGLE_ACCOUNT_ONLY' });
    expect(getUserSettings).not.toHaveBeenCalled();
    expect(saveUserSettings).not.toHaveBeenCalled();
  });

  it('程序關閉時停止引擎但不把 persisted status 改成 stopped', async () => {
    await startBot(userId);
    saveUserSettings.mockClear();
    await shutdownAll();

    expect(saveUserSettings).not.toHaveBeenCalledWith(userId, { status: 'stopped' });
  });
});
