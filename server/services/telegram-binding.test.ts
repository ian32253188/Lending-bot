import { beforeEach, describe, expect, it, vi } from 'vitest';

const telegramBot = vi.fn();
const configMock = { telegram: { botToken: 'shared-bot-token' } };
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
mockModule('node-telegram-bot-api', telegramBot);
mockModule('../config', configMock);
mockModule('./telegram-routing', routingMock);

const { getSharedTelegramBotToken, verifyTelegramChatId } = require('./telegram-binding');

describe('shared Telegram binding verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always prefers the shared server Bot token', () => {
    expect(getSharedTelegramBotToken({ telegram_bot_token: 'legacy-user-token' })).toBe('shared-bot-token');
  });

  it('normalizes and verifies a Chat ID through Telegram getChat', async () => {
    const getChat = vi.fn().mockResolvedValue({ id: 10001 });
    telegramBot.mockImplementation(() => ({ getChat }));

    await expect(verifyTelegramChatId({ botToken: 'token', chatId: 10001 })).resolves.toBe('10001');
    expect(telegramBot).toHaveBeenCalledWith('token', { polling: false });
    expect(getChat).toHaveBeenCalledWith('10001');
  });

  it('returns stable error codes for missing token and failed verification', async () => {
    await expect(verifyTelegramChatId({ botToken: '', chatId: 10001 })).rejects.toMatchObject({ code: 'TELEGRAM_BOT_TOKEN_MISSING' });

    telegramBot.mockImplementation(() => ({ getChat: vi.fn().mockRejectedValue(new Error('not found')) }));
    await expect(verifyTelegramChatId({ botToken: 'token', chatId: 99999 })).rejects.toMatchObject({ code: 'TELEGRAM_CHAT_VERIFICATION_FAILED' });
  });
});
