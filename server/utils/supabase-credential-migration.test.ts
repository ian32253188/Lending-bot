import { describe, expect, it, vi } from 'vitest';

const { compareAndSetEncryptedCredentials } = require('./supabase-credential-migration');

describe('Supabase credential compare-and-set transport', () => {
  it('sends expected plaintext credentials as RPC body arguments instead of URL filters', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const supabase = { rpc };
    const current = {
      bitfinex_api_key: 'synthetic-legacy-key',
      bitfinex_api_secret: 'synthetic-legacy-secret',
      telegram_bot_token: null,
    };
    const updates = {
      bitfinex_api_key: 'encrypted-placeholder-key',
      bitfinex_api_secret: 'encrypted-placeholder-secret',
    };

    await expect(compareAndSetEncryptedCredentials(supabase, 'synthetic-user', current, updates))
      .resolves.toEqual({ updated: true, error: null });

    expect(rpc).toHaveBeenCalledWith('migrate_user_bot_settings_credentials', {
      p_user_id: 'synthetic-user',
      p_expected_credentials: current,
      p_encrypted_credentials: updates,
    });
  });

  it('returns the RPC error without logging or interpolating credential values', async () => {
    const error = new Error('permission denied');
    const rpc = vi.fn().mockResolvedValue({ data: null, error });

    await expect(compareAndSetEncryptedCredentials(
      { rpc },
      'synthetic-user',
      { bitfinex_api_key: 'synthetic-legacy-key' },
      { bitfinex_api_key: 'encrypted-placeholder-key' },
    )).resolves.toEqual({ updated: false, error });
  });
});
