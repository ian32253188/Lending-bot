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
const cryptoMock = {
  encrypt: (value: string) => `encrypted:${value}`,
  decryptWithFallback: (value: string) => value.startsWith('encrypted:') ? value.slice('encrypted:'.length) : value,
};
const credentialImportMock = {
  encryptImportedCredential: vi.fn((value: string) => value.startsWith('encrypted:') ? value : `encrypted:${value}`),
};
const telegramBindingMock = {
  getSharedTelegramBotToken: (settings: { telegram_bot_token?: string } = {}) => configMock.telegram.botToken ||
    (settings.telegram_bot_token?.startsWith('encrypted:') ? settings.telegram_bot_token.slice('encrypted:'.length) : settings.telegram_bot_token) || null,
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
mockModule('../utils/credential-import', credentialImportMock);
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
    configMock.telegram.botToken = 'shared-token';
    mocks.getUserSettings.mockResolvedValue(null);
    mocks.getUserSettingsByTelegramChatId.mockResolvedValue(null);
    mocks.verifyTelegramChatId.mockResolvedValue('10001');
    mocks.getBot.mockReturnValue(null);
  });

  it('returns fixed compounding and omits the removed transfer and reserve settings', async () => {
    mocks.getUserSettings.mockResolvedValue({
      lending_currencies: ['BTC'],
      compounding_enabled: false,
      compounding_hold_amount: 25,
      min_offer_amount: 100,
      auto_transfer_enabled: true,
      auto_transfer_threshold: 500,
      strategy_config: { rateStrategy: 'high_24h', periodDays: 30, minRate: 0.001, maxRate: 0.01 },
    });

    const res = await request(app).get('/api/lending/settings').expect(200);

    expect(res.body).toMatchObject({
      lending_currencies: ['USD'],
      compounding_enabled: true,
      strategy_config: { rateStrategy: 'high_24h', periodDays: 30 },
    });
    expect(res.body).not.toHaveProperty('compounding_hold_amount');
    expect(res.body).not.toHaveProperty('min_offer_amount');
    expect(res.body).not.toHaveProperty('auto_transfer_enabled');
    expect(res.body).not.toHaveProperty('auto_transfer_threshold');
    expect(res.body.strategy_config).not.toHaveProperty('minRate');
    expect(res.body.strategy_config).not.toHaveProperty('maxRate');
  });

  it('forces compounding on and disables automatic transfer settings on writes', async () => {
    await request(app)
      .post('/api/lending/settings')
      .send({ compounding_enabled: false, compounding_hold_amount: 25, auto_transfer_enabled: true, auto_transfer_threshold: 500 })
      .expect(200);

    expect(mocks.saveUserSettings).toHaveBeenCalledWith('user-a', expect.objectContaining({
      compounding_enabled: true,
      compounding_hold_amount: 0,
      auto_transfer_enabled: false,
    }));
    expect(mocks.saveUserSettings.mock.calls[0][1]).not.toHaveProperty('auto_transfer_threshold');
  });

  it('keeps the legacy compounding endpoint fixed on and removes automatic transfer', async () => {
    const compounding = await request(app).post('/api/lending/compounding').send({ enabled: false }).expect(200);
    expect(compounding.body).toMatchObject({ compounding: true });
    expect(mocks.saveUserSettings).toHaveBeenCalledWith('user-a', {
      compounding_enabled: true,
      compounding_hold_amount: 0,
    });

    const transfer = await request(app).post('/api/lending/auto-transfer').send({ enabled: true }).expect(410);
    expect(transfer.body.error).toContain('已移除');
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

  it('encrypts a newly supplied Telegram Bot Token before saving it', async () => {
    configMock.telegram.botToken = null;

    await request(app)
      .post('/api/lending/settings')
      .send({ telegram_bot_token: '123456789:synthetic-token', telegram_chat_id: '10001' })
      .expect(200);

    expect(mocks.verifyTelegramChatId).toHaveBeenCalledWith({
      botToken: '123456789:synthetic-token',
      chatId: '10001',
    });
    expect(mocks.saveUserSettings).toHaveBeenCalledWith('user-a', expect.objectContaining({
      telegram_bot_token: 'encrypted:123456789:synthetic-token',
    }));
    expect(mocks.initUserTelegram).toHaveBeenCalledWith('user-a', '123456789:synthetic-token', '10001');
  });

  it('encrypts first-time credentials even when their values contain ellipses', async () => {
    configMock.telegram.botToken = null;

    await request(app)
      .post('/api/lending/settings')
      .send({
        bitfinex_api_key: 'api...key',
        bitfinex_api_secret: 'secret...value',
        telegram_bot_token: '123456789:token...part',
        telegram_chat_id: '10001',
      })
      .expect(200);

    expect(mocks.saveUserSettings).toHaveBeenCalledWith('user-a', expect.objectContaining({
      bitfinex_api_key: 'encrypted:api...key',
      bitfinex_api_secret: 'encrypted:secret...value',
      telegram_bot_token: 'encrypted:123456789:token...part',
    }));
  });

  it('preserves credentials only when the complete expected mask is submitted', async () => {
    mocks.getUserSettings.mockResolvedValue({
      bitfinex_api_key: 'encrypted:existing-key',
      bitfinex_api_secret: 'encrypted:existing-secret',
      telegram_bot_token: 'encrypted:123456789:existing-token',
    });

    await request(app)
      .post('/api/lending/settings')
      .send({
        bitfinex_api_key: '********...',
        bitfinex_api_secret: '******',
        telegram_bot_token: '**********...',
      })
      .expect(200);

    expect(mocks.saveUserSettings).toHaveBeenCalledWith('user-a', expect.objectContaining({
      bitfinex_api_key: 'encrypted:existing-key',
      bitfinex_api_secret: 'encrypted:existing-secret',
      telegram_bot_token: 'encrypted:123456789:existing-token',
    }));
    expect(credentialImportMock.encryptImportedCredential).not.toHaveBeenCalled();
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
