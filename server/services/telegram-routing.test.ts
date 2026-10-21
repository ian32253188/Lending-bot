import { describe, expect, it } from 'vitest';

const {
  normalizeTelegramChatId,
  isPrivateTelegramSender,
  isPrivateTelegramChatId,
  resolveUserSettingsByChatId,
} = require('./telegram-routing');

describe('Telegram Chat ID binding isolation', () => {
  const users = [
    { user_id: '00000000-0000-0000-0000-000000000001', telegram_chat_id: '10001' },
    { user_id: 'user-b', telegram_chat_id: '10002' },
  ];

  it('resolves each user only by an exact normalized Chat ID', () => {
    expect(resolveUserSettingsByChatId(users, 10001).user_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(resolveUserSettingsByChatId(users, '10002')).toBeNull();
    expect(resolveUserSettingsByChatId(users, '010001')).toBeNull();
    expect(resolveUserSettingsByChatId(users, '99999')).toBeNull();
  });

  it('preserves negative group IDs and rejects arbitrary text', () => {
    expect(normalizeTelegramChatId('-1001234567890')).toBe('-1001234567890');
    expect(() => normalizeTelegramChatId('user-a')).toThrow('整數格式');
  });

  it('accepts only the matching human sender in a private chat', () => {
    expect(isPrivateTelegramChatId('10001')).toBe(true);
    expect(isPrivateTelegramChatId('-1001234567890')).toBe(false);
    expect(isPrivateTelegramSender({ id: 10001, type: 'private' }, { id: 10001 }, '10001')).toBe(true);
    expect(isPrivateTelegramSender({ id: -1001234567890, type: 'supergroup' }, { id: 10001 }, '-1001234567890')).toBe(false);
    expect(isPrivateTelegramSender({ id: 10001, type: 'private' }, { id: 10002 }, '10001')).toBe(false);
  });
});
