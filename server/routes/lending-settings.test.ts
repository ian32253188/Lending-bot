import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getUserSettings: vi.fn().mockResolvedValue(null),
  saveUserSettings: vi.fn().mockResolvedValue(null),
  getUserSettingsByTelegramChatId: vi.fn().mockResolvedValue(null),
  initUserTelegram: vi.fn(),
  destroyUserTelegram: vi.fn(),
  verifyTelegramChatId: vi.fn().mockResolvedValue('10001'),
  getBot: vi.fn().mockReturnValue(null),
  restartBotPreservingState: vi.fn(),
}));

const configMock = { telegram: { botToken: 'shared-token' } };
const databaseMock = {
  getUserSettings: mocks.getUserSettings,
  saveUserSettings: mocks.saveUserSettings,
  getUserSettingsByTelegramChatId: mocks.getUserSettingsByTelegramChatId,
};
const managerMock = {
  getBot: mocks.getBot,
  restartBotPreservingState: mocks.restartBotPreservingState,
  startBot: vi.fn(),
  stopBot: vi.fn(),
};
const strategyMock = { getStrategyEngine: () => ({ getStatus: () => ({}) }) };
const restMock = {};
const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const cryptoMock = { encrypt: (value: string) => `encrypted:${value}`, decryptWithFallback: (value: string) => value };
const telegramBindingMock = {
  getSharedTelegramBotToken: () => 'shared-token',
  verifyTelegramChatId: mocks.verifyTelegramChatId,
};
const telegramMock = { initUserTelegram: mocks.initUserTelegram, destroyUserTelegram: mocks.destroyUserTelegram };

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};
mockModule('../config', configMock);
mockModule('../services/database', databaseMock);
mockModule('../services/engine/manager', managerMock);
mockModule('../services/engine/strategy', strategyMock);
mockModule('../services/bitfinex/rest', restMock);
mockModule('../utils/logger', loggerMock);
mockModule('../utils/crypto', cryptoMock);
mockModule('../services/telegram-binding', telegramBindingMock);
mockModule('../services/telegram', telegramMock);

const router = require('./lending');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: 'user-a' };
  next();
});
app.use('/api/lending', router);

describe('per-user settings and Telegram binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserSettings.mockResolvedValue(null);
    mocks.getUserSettingsByTelegramChatId.mockResolvedValue(null);
    mocks.verifyTelegramChatId.mockResolvedValue('10001');
    mocks.getBot.mockReturnValue(null);
  });

  it('rejects a Telegram Chat ID already owned by another tenant', async () => {
    mocks.getUserSettingsByTelegramChatId.mockResolvedValue({ user_id: 'user-b', telegram_chat_id: '10001' });

    const res = await request(app)
      .post('/api/lending/settings')
      .send({ telegram_chat_id: '10001' })
      .expect(409);

    expect(res.body.error).toContain('已綁定其他使用者');
    expect(mocks.saveUserSettings).not.toHaveBeenCalled();
    expect(mocks.verifyTelegramChatId).not.toHaveBeenCalled();
  });

  it('verifies and stores a normalized Chat ID without accepting another user token', async () => {
    const res = await request(app)
      .post('/api/lending/settings')
      .send({ telegram_chat_id: 10001, bitfinex_api_key: 'api-key', bitfinex_api_secret: 'api-secret' })
      .expect(200);

    expect(res.body.message).toBe('設定更新成功');
    expect(mocks.verifyTelegramChatId).toHaveBeenCalledWith({ botToken: 'shared-token', chatId: '10001' });
    expect(mocks.saveUserSettings).toHaveBeenCalledWith('user-a', expect.objectContaining({
      telegram_chat_id: '10001',
      bitfinex_api_key: 'encrypted:api-key',
      bitfinex_api_secret: 'encrypted:api-secret',
    }));
    expect(mocks.initUserTelegram).toHaveBeenCalledWith('user-a', 'shared-token', '10001');
  });

  it('rejects malformed Chat IDs before persistence', async () => {
    const res = await request(app)
      .post('/api/lending/settings')
      .send({ telegram_chat_id: 'not-a-chat-id' })
      .expect(400);

    expect(res.body.error).toContain('整數格式');
    expect(mocks.saveUserSettings).not.toHaveBeenCalled();
  });
});
