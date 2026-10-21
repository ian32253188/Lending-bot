import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  queries: [] as Array<[string, unknown[]]>,
  credentialRows: [] as Array<Record<string, unknown>>,
}));
const configMock = {
  supabase: { url: '', key: '' },
  database: { host: 'postgres', port: 5432, user: 'postgres', password: 'synthetic-test-password', database: 'lending_bot' },
};

class MockPool {
  on() { return this; }
  async query(sql: string, params: unknown[] = []) {
    state.queries.push([sql, params]);
    if (sql.includes('SELECT user_id, bitfinex_api_key, bitfinex_api_secret, telegram_bot_token')) {
      return { rows: state.credentialRows.map(row => ({ ...row })) };
    }
    return { rows: [] };
  }
}

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};

const originalJwtSecret = process.env.JWT_SECRET;
const originalEncryptionSalt = process.env.ENCRYPTION_SALT;
const originalRunDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS;
process.env.JWT_SECRET = 'database-migration-test-secret-32-characters';
process.env.ENCRYPTION_SALT = 'database-migration-test-salt';
process.env.RUN_DB_INTEGRATION_TESTS = '1';

mockModule('../config', configMock);
mockModule('@supabase/supabase-js', { createClient: vi.fn() });
mockModule('pg', { Pool: MockPool });

const db = require('./database');
const { decrypt, encrypt } = require('../utils/crypto');

beforeEach(() => {
  vi.clearAllMocks();
  state.queries.length = 0;
  state.credentialRows = [];
});

afterAll(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  if (originalEncryptionSalt === undefined) delete process.env.ENCRYPTION_SALT;
  else process.env.ENCRYPTION_SALT = originalEncryptionSalt;
  if (originalRunDbIntegrationTests === undefined) delete process.env.RUN_DB_INTEGRATION_TESTS;
  else process.env.RUN_DB_INTEGRATION_TESTS = originalRunDbIntegrationTests;
});

describe('legacy PostgreSQL credential migration', () => {
  it('migrates legacy Bitfinex and Telegram values using a compare-and-set update', async () => {
    state.credentialRows = [{
      user_id: '00000000-0000-0000-0000-000000000010',
      bitfinex_api_key: 'synthetic-legacy-api-key',
      bitfinex_api_secret: encrypt('synthetic-existing-encrypted-secret'),
      telegram_bot_token: '123456789:synthetic-telegram-token',
    }];

    await expect(db.ensureUserBotSettingsTable()).resolves.toBe(true);

    const update = state.queries.find(([sql]) => /^\s*UPDATE user_bot_settings\s+SET /i.test(sql));
    expect(update).toBeDefined();
    const [sql, params] = update!;
    expect(sql).toContain('bitfinex_api_key = $1');
    expect(sql).toContain('telegram_bot_token = $2');
    expect(sql).not.toContain('bitfinex_api_secret =');
    expect(sql).toContain('IS NOT DISTINCT FROM');
    expect(decrypt(params[0] as string)).toBe('synthetic-legacy-api-key');
    expect(decrypt(params[1] as string)).toBe('123456789:synthetic-telegram-token');
    expect(params).toContain('synthetic-legacy-api-key');
    expect(params).toContain('123456789:synthetic-telegram-token');
  });
});
