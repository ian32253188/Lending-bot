import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  pgQueries: [] as Array<[string, unknown[]]>,
  supabaseRows: [] as Array<Record<string, unknown>>,
  supabaseUpdateError: false,
  supabaseClientCounter: 0,
}));
const configMock: any = { supabase: { url: '', key: '' } };

class MockPool {
  on() { return this; }
  async query(sql: string, params: unknown[] = []) {
    state.pgQueries.push([sql, params]);
    if (sql.includes('INSERT INTO user_bot_settings')) {
      return { rows: [{ user_id: params[0], status: params[1] }] };
    }
    return { rows: [] };
  }
}

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};
mockModule('../config', configMock);
mockModule('@supabase/supabase-js', {
  createClient: vi.fn(() => ({
    rpc: vi.fn(async (functionName: string, args: Record<string, any>) => {
      if (functionName !== 'migrate_user_bot_settings_credentials') {
        return { data: null, error: { message: 'synthetic unknown RPC' } };
      }
      if (state.supabaseUpdateError) return { data: null, error: { message: 'synthetic update failure' } };

      const expected = args.p_expected_credentials || {};
      const credentialColumns = ['bitfinex_api_key', 'bitfinex_api_secret', 'telegram_bot_token'];
      const row = state.supabaseRows.find(candidate => candidate.user_id === args.p_user_id
        && credentialColumns.every(column => (candidate[column] ?? null) === (expected[column] ?? null)));
      if (!row) return { data: false, error: null };
      Object.assign(row, args.p_encrypted_credentials);
      return { data: true, error: null };
    }),
    from: () => {
      let updates: Record<string, unknown> | null = null;
      const filters: Array<[string, unknown]> = [];
      const matches = (row: Record<string, unknown>) => filters.every(([key, value]) => row[key] === value);
      const builder: any = {
        select: () => builder,
        update: (values: Record<string, unknown>) => { updates = values; return builder; },
        eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
        order: () => builder,
        range: (from: number, to: number) => { builder.page = [from, to + 1]; return builder; },
        single: async () => ({ data: state.supabaseRows.find(matches) ? { ...state.supabaseRows.find(matches)! } : null, error: null }),
        maybeSingle: async () => {
          if (!updates) {
            const row = state.supabaseRows.find(matches);
            return { data: row ? { ...row } : null, error: null };
          }
          if (state.supabaseUpdateError) return { data: null, error: { message: 'synthetic update failure' } };
          const row = state.supabaseRows.find(matches);
          if (!row) return { data: null, error: null };
          Object.assign(row, updates);
          return { data: { ...row }, error: null };
        },
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
          const result = Promise.resolve({
            data: state.supabaseRows.filter(matches).slice(...(builder.page || [0, undefined])).map((row: Record<string, unknown>) => ({ ...row })),
            error: null,
          });
          return result.then(resolve, reject);
        },
      };
      return builder;
    },
  })),
});
mockModule('pg', { Pool: MockPool });

const db = require('./database');
const userId = '00000000-0000-0000-0000-000000000001';
const originalRunDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS;

beforeEach(() => {
  vi.clearAllMocks();
  state.pgQueries.length = 0;
  state.supabaseRows = [];
  state.supabaseUpdateError = false;
  process.env.RUN_DB_INTEGRATION_TESTS = '1';
  configMock.database = { host: 'postgres', password: 'test-password' };
  configMock.supabase = { url: 'https://supabase.invalid', key: `synthetic-service-key-${++state.supabaseClientCounter}` };
});

afterEach(() => {
  delete configMock.database;
  if (originalRunDbIntegrationTests === undefined) delete process.env.RUN_DB_INTEGRATION_TESTS;
  else process.env.RUN_DB_INTEGRATION_TESTS = originalRunDbIntegrationTests;
});

describe('PostgreSQL user settings writes', () => {
  it('rejects untrusted SQL identifier keys before issuing a query', async () => {
    const settings = JSON.parse('{"status":"running","status) VALUES (1); DROP TABLE users; --":"x"}');

    await expect(db.saveUserSettings(userId, settings)).rejects.toMatchObject({ code: 'INVALID_USER_SETTINGS' });
    expect(state.pgQueries).toHaveLength(0);
  });

  it('uses only approved columns and parameterized values for a normal settings write', async () => {
    await db.saveUserSettings(userId, { status: 'running', strategy_config: { mode: 'simplified' } });

    const [sql, params] = state.pgQueries.find(([statement]) => statement.includes('INSERT INTO user_bot_settings'))!;
    expect(sql).toContain('user_id, status, strategy_config, updated_at');
    expect(sql).toContain('status = EXCLUDED.status');
    expect(sql).toContain('strategy_config = EXCLUDED.strategy_config');
    expect(params).toEqual([userId, 'running', { mode: 'simplified' }, expect.any(String)]);
    expect(sql).not.toContain('simplified');
  });

  it('maps the legacy paused flag to the persisted status column', async () => {
    await db.saveUserSettings(userId, { paused: true, pause_reason: 'operator pause' });

    const [sql, params] = state.pgQueries.find(([statement]) => statement.includes('INSERT INTO user_bot_settings'))!;
    expect(sql).toContain('pause_reason, status');
    expect(sql).toContain('status = EXCLUDED.status');
    expect(params).toEqual([userId, 'operator pause', 'paused', expect.any(String)]);
  });

  it('encrypts credentials centrally before writing to PostgreSQL', async () => {
    const { decrypt } = require('../utils/crypto');

    await db.saveUserSettings(userId, {
      bitfinex_api_key: 'synthetic-api-key',
      bitfinex_api_secret: 'synthetic-api-secret',
      telegram_bot_token: '123456789:synthetic-token',
    });

    const [sql, params] = state.pgQueries.find(([statement]) => statement.includes('INSERT INTO user_bot_settings'))!;
    expect(sql).toContain('bitfinex_api_key, bitfinex_api_secret, telegram_bot_token');
    expect(decrypt(params[1] as string)).toBe('synthetic-api-key');
    expect(decrypt(params[2] as string)).toBe('synthetic-api-secret');
    expect(decrypt(params[3] as string)).toBe('123456789:synthetic-token');
    expect(params).not.toContain('synthetic-api-key');
    expect(params).not.toContain('synthetic-api-secret');
    expect(params).not.toContain('123456789:synthetic-token');
  });
});

describe('legacy Supabase Telegram credential migration', () => {
  it('encrypts and persists a plaintext token before returning settings', async () => {
    delete process.env.RUN_DB_INTEGRATION_TESTS;
    state.supabaseRows = [{
      user_id: userId,
      bitfinex_api_key: 'synthetic-bitfinex-key',
      bitfinex_api_secret: 'synthetic-bitfinex-secret',
      telegram_bot_token: '123456789:synthetic-token',
      telegram_chat_id: '10001',
    }, {
      user_id: '00000000-0000-0000-0000-000000000002',
      bitfinex_api_key: 'synthetic-unrequested-key',
      bitfinex_api_secret: null,
      telegram_bot_token: null,
    }];
    const { decrypt } = require('../utils/crypto');

    const settings = await db.getUserSettings(userId);

    expect(decrypt(settings.bitfinex_api_key)).toBe('synthetic-bitfinex-key');
    expect(decrypt(settings.bitfinex_api_secret)).toBe('synthetic-bitfinex-secret');
    expect(settings.telegram_bot_token).not.toBe('123456789:synthetic-token');
    expect(decrypt(settings.telegram_bot_token)).toBe('123456789:synthetic-token');
    expect(state.supabaseRows[0]).toEqual(settings);
    expect(decrypt(state.supabaseRows[1].bitfinex_api_key as string)).toBe('synthetic-unrequested-key');
  });

  it('encrypts all legacy rows before resolving a Chat ID directly', async () => {
    delete process.env.RUN_DB_INTEGRATION_TESTS;
    state.supabaseRows = [
      { user_id: userId, telegram_chat_id: '10001', bitfinex_api_key: 'synthetic-api-key' },
      { user_id: '00000000-0000-0000-0000-000000000002', telegram_chat_id: '10002', telegram_bot_token: 'synthetic-bot-token' },
    ];
    const { decrypt } = require('../utils/crypto');

    await expect(db.getUserSettingsByTelegramChatId('10001')).resolves.toMatchObject({ user_id: userId });

    expect(decrypt(state.supabaseRows[0].bitfinex_api_key as string)).toBe('synthetic-api-key');
    expect(decrypt(state.supabaseRows[1].telegram_bot_token as string)).toBe('synthetic-bot-token');
  });

  it('continues the legacy credential scan beyond the first page', async () => {
    delete process.env.RUN_DB_INTEGRATION_TESTS;
    state.supabaseRows = Array.from({ length: 501 }, (_, index) => ({
      user_id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
      ...(index === 500 ? { bitfinex_api_key: 'synthetic-key-501' } : {}),
    }));
    const { decrypt } = require('../utils/crypto');

    await expect(db.getUserSettingsByTelegramChatId('10001')).resolves.toBeNull();

    expect(decrypt(state.supabaseRows[500].bitfinex_api_key as string)).toBe('synthetic-key-501');
  });

  it('fails closed when the database cannot persist the encrypted token', async () => {
    delete process.env.RUN_DB_INTEGRATION_TESTS;
    state.supabaseRows = [{ user_id: userId, telegram_bot_token: 'legacy-plaintext-token' }];
    state.supabaseUpdateError = true;

    await expect(db.getUserSettings(userId)).rejects.toMatchObject({ code: 'CREDENTIAL_MIGRATION_FAILED' });
    expect(state.supabaseRows[0].telegram_bot_token).toBe('legacy-plaintext-token');
  });
});
