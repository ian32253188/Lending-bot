import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// 1. 定義 Mock 放貸引擎
const mockEngine = {
  running: false,
  paused: false,
  start: vi.fn().mockResolvedValue(null),
  stop: vi.fn().mockResolvedValue(null),
  pause: vi.fn(),
  resume: vi.fn(),
  emergencyStop: vi.fn().mockResolvedValue(null),
  getStatus: () => ({
    running: false,
    connected: false
  })
};

const mockGetUserSettings = vi.fn().mockResolvedValue({
  strategy_config: { rateStrategy: 'current_avg', periodDays: 2, useAllAvailable: true },
});
const mockSaveUserSettings = vi.fn().mockResolvedValue(null);
const mockManager = {
  getBot: vi.fn().mockReturnValue(mockEngine),
  startBot: vi.fn().mockResolvedValue(mockEngine),
  stopBot: vi.fn().mockResolvedValue(null),
  restartBotPreservingState: vi.fn().mockResolvedValue(mockEngine)
};

// 2. 利用 Node.js require.cache 全域劫持 CommonJS 模組
const lendingPath = require.resolve('../services/engine/lending');
const telegramPath = require.resolve('../services/telegram');
const databasePath = require.resolve('../services/database');
const managerPath = require.resolve('../services/engine/manager');

const mockSupabase = {
  auth: {
    getUser: vi.fn().mockImplementation((token) => {
      if (token === 'valid-test-token') {
        return Promise.resolve({ data: { user: { id: 'test-user-id' } }, error: null });
      }
      return Promise.resolve({ data: { user: null }, error: new Error('Invalid token') });
    })
  }
};

require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: {
    getSupabase: () => mockSupabase,
    initDatabase: vi.fn(),
    getUserSettings: mockGetUserSettings,
    saveUserSettings: mockSaveUserSettings,
  }
} as any;

require.cache[managerPath] = {
  id: managerPath,
  filename: managerPath,
  loaded: true,
  exports: {
    ...mockManager,
  }
} as any;

require.cache[lendingPath] = {
  id: lendingPath,
  filename: lendingPath,
  loaded: true,
  exports: {
    getLendingEngine: () => mockEngine
  }
} as any;

require.cache[telegramPath] = {
  id: telegramPath,
  filename: telegramPath,
  loaded: true,
  exports: {
    initTelegram: vi.fn(),
    getTelegramBot: vi.fn()
  }
} as any;

// 3. 載入 App 路由
const { app } = require('../index');

describe('API & Endpoint 整合測試 (supertest)', () => {
  
  it('GET /api/health 應能成功取得健康狀態 JSON 且不需驗證', async () => {
    const res = await request(app)
      .get('/api/health')
      .expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.publicWsConnected).toBeDefined();
    expect(res.body.uptime).toBeDefined();
  });

  it('GET /metrics 應能輸出符合 Prometheus Exposition 格式之指標', async () => {
    const res = await request(app)
      .get('/metrics')
      .expect(200);

    // 驗證是否回傳文字格式指標
    expect(res.text).toContain('lending_bot_balance_usd');
    expect(res.text).toContain('lending_bot_active_loans_count');
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('POST /api/lending/engine/start 在無 Token 時應回傳 401 Unauthorized', async () => {
    await request(app)
      .post('/api/lending/engine/start')
      .expect(401);
  });

  it('POST /api/lending/engine/start 在 Token 無效時應回傳 401 Unauthorized', async () => {
    await request(app)
      .post('/api/lending/engine/start')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
  });

  it('POST /api/lending/engine/start 在 Token 正確時應能成功執行啟動指令', async () => {
    const res = await request(app)
      .post('/api/lending/engine/start')
      .set('Authorization', 'Bearer valid-test-token')
      .expect(200);

    expect(res.body.message).toContain('放貸機器人已啟動');
  });

  it('引擎 pause/resume/emergency-stop 應路由到該使用者的引擎', async () => {
    await request(app)
      .post('/api/lending/engine/pause')
      .set('Authorization', 'Bearer valid-test-token')
      .send({ reason: '測試暫停' })
      .expect(200);
    await request(app)
      .post('/api/lending/engine/resume')
      .set('Authorization', 'Bearer valid-test-token')
      .expect(200);
    await request(app)
      .post('/api/lending/engine/emergency-stop')
      .set('Authorization', 'Bearer valid-test-token')
      .expect(200);

    expect(mockEngine.pause).toHaveBeenCalledWith('測試暫停');
    expect(mockEngine.resume).toHaveBeenCalledOnce();
    expect(mockEngine.emergencyStop).toHaveBeenCalledOnce();
  });

  it('未知引擎操作或沒有已啟動引擎時應拒絕請求', async () => {
    await request(app)
      .post('/api/lending/engine/restart')
      .set('Authorization', 'Bearer valid-test-token')
      .expect(400);

    mockManager.getBot.mockReturnValueOnce(null);
    await request(app)
      .post('/api/lending/engine/pause')
      .set('Authorization', 'Bearer valid-test-token')
      .expect(400);
  });

  it('手動掛單與轉帳的輸入驗證應在觸碰交易 API 前完成', async () => {
    await request(app)
      .post('/api/lending/offer')
      .set('Authorization', 'Bearer valid-test-token')
      .send({ currency: 'BTC', amount: 500, rate: 0.001, period: 2 })
      .expect(400);

    await request(app)
      .post('/api/lending/offer')
      .set('Authorization', 'Bearer valid-test-token')
      .send({ currency: 'USD', amount: 100, rate: 0.001, period: 2 })
      .expect(400);

    await request(app)
      .post('/api/lending/transfer')
      .set('Authorization', 'Bearer valid-test-token')
      .send({ from: 'funding', to: 'funding', currency: 'USD', amount: 1 })
      .expect(400);
  });

  it('POST /api/lending/strategy-settings 應只接受三種利率基準與六種期限', async () => {
    const valid = await request(app)
      .post('/api/lending/strategy-settings')
      .set('Authorization', 'Bearer valid-test-token')
      .send({ rateStrategy: 'high_30d', periodDays: 120 })
      .expect(200);

    expect(valid.body.rateStrategy).toBe('high_30d');
    expect(valid.body.periodDays).toBe(120);
    expect(valid.body.useAllAvailable).toBe(true);
    expect(mockSaveUserSettings).toHaveBeenCalledWith('test-user-id', expect.objectContaining({
      strategy_config: expect.objectContaining({ rateStrategy: 'high_30d', periodDays: 120, useAllAvailable: true }),
    }));

    await request(app)
      .post('/api/lending/strategy-settings')
      .set('Authorization', 'Bearer valid-test-token')
      .send({ rateStrategy: 'not-supported', periodDays: 7 })
      .expect(400);
  });

});
