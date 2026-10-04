import { describe, expect, it } from 'vitest';

const { resolveUserSettingsByChatId } = require('./telegram-routing');

describe('shared Telegram Bot multi-tenant isolation', () => {
  const accounts = [
    { user_id: '00000000-0000-0000-0000-000000000001', telegram_chat_id: '10001', balance: 123 },
    { user_id: 'user-b', telegram_chat_id: '10002', balance: 456 },
  ];

  function routePrivateMessage(chatId: string) {
    const account = resolveUserSettingsByChatId(accounts, chatId);
    return account ? { userId: account.user_id, balance: account.balance } : null;
  }

  it('routes only the canonical private account through the shared Bot', () => {
    expect(routePrivateMessage('10001')).toEqual({ userId: '00000000-0000-0000-0000-000000000001', balance: 123 });
    expect(routePrivateMessage('10002')).toBeNull();
  });

  it('does not fallback an unknown tenant to another user or admin chat', () => {
    expect(routePrivateMessage('99999')).toBeNull();
  });
});
