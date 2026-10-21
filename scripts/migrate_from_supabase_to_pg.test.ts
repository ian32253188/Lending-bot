import { afterAll, describe, expect, it } from 'vitest';

const originalJwtSecret = process.env.JWT_SECRET;
const originalEncryptionSalt = process.env.ENCRYPTION_SALT;
process.env.JWT_SECRET = 'supabase-migration-test-secret-32-characters';
process.env.ENCRYPTION_SALT = 'supabase-migration-test-salt';

const { encryptLegacySupabaseCredentials } = require('./migrate_from_supabase_to_pg');
const { decrypt, isEncryptedCredential } = require('../server/utils/crypto');

afterAll(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  if (originalEncryptionSalt === undefined) delete process.env.ENCRYPTION_SALT;
  else process.env.ENCRYPTION_SALT = originalEncryptionSalt;
});

describe('Supabase-to-PostgreSQL credential migration', () => {
  it('encrypts and compare-and-set persists legacy source credentials before copying', async () => {
    const rows = [
      { user_id: 'user-1', bitfinex_api_key: 'synthetic-api-key', telegram_bot_token: 'synthetic-telegram-token' },
      { user_id: 'user-2', bitfinex_api_secret: null },
    ];
    let page: [number, number] = [0, 500];
    const rpcCalls: Array<[string, Record<string, any>]> = [];
    const filters: Array<[string, unknown]> = [];
    const builder: any = {
      select: () => builder,
      order: () => builder,
      range: (start: number, end: number) => { page = [start, end + 1]; return builder; },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
      maybeSingle: async () => {
        const row = rows.find(candidate => filters.every(([key, value]) => candidate[key] === value));
        return { data: row ? { ...row } : null, error: null };
      },
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve({
        data: rows.slice(...page).map(row => ({ ...row })),
        error: null,
      }).then(resolve, reject),
    };
    const supabase = {
      from: () => { filters.length = 0; return builder; },
      rpc: async (name: string, args: Record<string, any>) => {
        rpcCalls.push([name, args]);
        const row = rows.find(candidate => candidate.user_id === args.p_user_id
          && Object.entries(args.p_expected_credentials).every(([column, value]) => (candidate[column] ?? null) === value));
        if (!row) return { data: false, error: null };
        Object.assign(row, args.p_encrypted_credentials);
        return { data: true, error: null };
      },
    };

    await expect(encryptLegacySupabaseCredentials(supabase)).resolves.toBe(1);

    expect(isEncryptedCredential(rows[0].bitfinex_api_key as string)).toBe(true);
    expect(isEncryptedCredential(rows[0].telegram_bot_token as string)).toBe(true);
    expect(decrypt(rows[0].bitfinex_api_key as string)).toBe('synthetic-api-key');
    expect(decrypt(rows[0].telegram_bot_token as string)).toBe('synthetic-telegram-token');
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0][0]).toBe('migrate_user_bot_settings_credentials');
    expect(rpcCalls[0][1].p_expected_credentials).toEqual({
      bitfinex_api_key: 'synthetic-api-key',
      bitfinex_api_secret: null,
      telegram_bot_token: 'synthetic-telegram-token',
    });
    expect(rpcCalls[0][1].p_encrypted_credentials).toEqual(expect.objectContaining({
      bitfinex_api_key: expect.any(String),
      telegram_bot_token: expect.any(String),
    }));
  });
});
