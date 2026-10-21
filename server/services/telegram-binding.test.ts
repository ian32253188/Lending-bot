import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const telegramBot = vi.fn(function TelegramBotMock() {});
const configMock = { telegram: { botToken: 'shared-bot-token' } };
const originalJwtSecret = process.env.JWT_SECRET;
const originalEncryptionSalt = process.env.ENCRYPTION_SALT;
process.env.JWT_SECRET = 'telegram-binding-test-secret-32-characters';
process.env.ENCRYPTION_SALT = 'telegram-binding-test-salt';
const routingMock = {
  normalizeTelegramChatId: (value: unknown) => {
    const normalized = String(value);
    if (!/^-?\d+$/.test(normalized)) throw new Error('Chat ID 必須為整數格式');
    return normalized;
  },
};

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};
mockModule('node-telegram-bot-api', { TelegramBot: telegramBot });
mockModule('../config', configMock);
mockModule('./telegram-routing', routingMock);

const { encrypt } = require('../utils/crypto');
const { getSharedTelegramBotToken, verifyTelegramChatId } = require('./telegram-binding');

afterAll(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  if (originalEncryptionSalt === undefined) delete process.env.ENCRYPTION_SALT;
  else process.env.ENCRYPTION_SALT = originalEncryptionSalt;
});

describe('shared Telegram binding verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.telegram.botToken = 'shared-bot-token';
  });

  it('always prefers the shared server Bot token', () => {
    expect(getSharedTelegramBotToken({ telegram_bot_token: 'legacy-user-token' })).toBe('shared-bot-token');
  });

  it('decrypts new database tokens and continues to accept legacy plaintext rows', () => {
    configMock.telegram.botToken = null;
    const ciphertext = encrypt('123456789:synthetic-token');

    expect(getSharedTelegramBotToken({ telegram_bot_token: ciphertext })).toBe('123456789:synthetic-token');
    expect(getSharedTelegramBotToken({ telegram_bot_token: 'legacy-plaintext-token' })).toBe('legacy-plaintext-token');
  });

  it('normalizes and verifies a Chat ID through Telegram getChat', async () => {
    const getChat = vi.fn().mockResolvedValue({ id: 10001, type: 'private' });
    telegramBot.mockImplementation(function createTelegramBot() { return { getChat }; });

    await expect(verifyTelegramChatId({ botToken: 'token', chatId: 10001 })).resolves.toBe('10001');
    expect(telegramBot).toHaveBeenCalledWith('token', { polling: false });
    expect(getChat).toHaveBeenCalledWith('10001');
  });

  it('rejects Telegram groups and channels as account bindings', async () => {
    telegramBot.mockImplementation(function createTelegramBot() {
      return { getChat: vi.fn().mockResolvedValue({ id: -1001234567890, type: 'supergroup' }) };
    });

    await expect(verifyTelegramChatId({ botToken: 'token', chatId: -1001234567890 }))
      .rejects.toMatchObject({ code: 'TELEGRAM_PRIVATE_CHAT_REQUIRED' });
  });

  it('returns stable error codes for missing token and failed verification', async () => {
    await expect(verifyTelegramChatId({ botToken: '', chatId: 10001 })).rejects.toMatchObject({ code: 'TELEGRAM_BOT_TOKEN_MISSING' });

    telegramBot.mockImplementation(function createTelegramBot() {
      return { getChat: vi.fn().mockRejectedValue(new Error('not found')) };
    });
    await expect(verifyTelegramChatId({ botToken: 'token', chatId: 99999 })).rejects.toMatchObject({ code: 'TELEGRAM_CHAT_VERIFICATION_FAILED' });
  });
});
