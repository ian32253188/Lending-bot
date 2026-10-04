import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: { bitfinex_api_key: 'encrypted-key', bitfinex_api_secret: 'encrypted-secret' } as any,
  getUserSettings: vi.fn(),
  getWallets: vi.fn(),
  getActiveFundingOffers: vi.fn(),
  getActiveFundingCredits: vi.fn(),
  getActiveFundingLoans: vi.fn(),
  decryptWithFallback: vi.fn((value: string) => `decrypted:${value}`),
  parseWallet: vi.fn((row: any) => row),
  parseFundingOffer: vi.fn((row: any) => row),
  parseFundingCredit: vi.fn((row: any) => row),
  logger: { warn: vi.fn() },
}));

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};

mockModule('../config', { bitfinex: { apiKey: 'server-key', apiSecret: 'server-secret' } });
mockModule('../utils/logger', mocks.logger);
mockModule('../utils/crypto', { decryptWithFallback: mocks.decryptWithFallback });
mockModule('./database', { getUserSettings: mocks.getUserSettings });
mockModule('./bitfinex/rest', {
  getWallets: mocks.getWallets,
  getActiveFundingOffers: mocks.getActiveFundingOffers,
  getActiveFundingCredits: mocks.getActiveFundingCredits,
  getActiveFundingLoans: mocks.getActiveFundingLoans,
  parseWallet: mocks.parseWallet,
  parseFundingOffer: mocks.parseFundingOffer,
  parseFundingCredit: mocks.parseFundingCredit,
});

const { getReadOnlyAccountSnapshot, clearReadOnlyAccountSnapshotCache } = require('./private-account-status');

describe('read-only private Bitfinex account snapshot', () => {
  beforeEach(() => {
    clearReadOnlyAccountSnapshotCache();
    vi.clearAllMocks();
    mocks.getUserSettings.mockResolvedValue(mocks.settings);
    mocks.getWallets.mockResolvedValue([
      { type: 'funding', currency: 'USD', balance: 1000, available: 200 },
      { type: 'funding', currency: 'USDT', balance: 50, available: 50 },
    ]);
    mocks.getActiveFundingOffers.mockImplementation(async currency => currency === 'USD' ? [{ id: 1 }] : []);
    mocks.getActiveFundingCredits.mockImplementation(async currency => currency === 'USD'
      ? [{ id: 10, side: 1, amount: 600 }, { id: 11, side: -1, amount: 900 }]
      : []);
    mocks.getActiveFundingLoans.mockImplementation(async currency => currency === 'USD'
      ? [{ id: 10, side: 1, amount: 600 }, { id: 12, side: 1, amount: 200 }]
      : []);
  });

  it('loads wallet, offers, and lender positions without starting an engine', async () => {
    const snapshot = await getReadOnlyAccountSnapshot('user-a');

    expect(snapshot.accountDataAvailable).toBe(true);
    expect(snapshot.accountDataComplete).toBe(true);
    expect(snapshot.accountDataSource).toBe('Bitfinex private REST API');
    expect(snapshot.wallets.USD).toEqual({ balance: 1000, available: 200 });
    expect(snapshot.activeOffers.USD).toEqual([{ id: 1 }]);
    expect(snapshot.activeCredits.USD.map((row: any) => row.id)).toEqual([10, 12]);
    expect(mocks.getWallets).toHaveBeenCalledWith({
      apiKey: 'decrypted:encrypted-key',
      apiSecret: 'decrypted:encrypted-secret',
    });
    expect(mocks.getActiveFundingCredits).toHaveBeenCalledTimes(2);
  });

  it('caches the private reads briefly for the dashboard websocket refresh loop', async () => {
    await getReadOnlyAccountSnapshot('user-a');
    await getReadOnlyAccountSnapshot('user-a');

    expect(mocks.getWallets).toHaveBeenCalledTimes(1);
    expect(mocks.getActiveFundingCredits).toHaveBeenCalledTimes(2);
  });

  it('does not return fake zero positions when credentials are unavailable', async () => {
    mocks.getUserSettings.mockResolvedValue(null);

    const snapshot = await getReadOnlyAccountSnapshot('user-b');

    expect(snapshot.accountDataAvailable).toBe(false);
    expect(snapshot.accountDataComplete).toBe(false);
    expect(snapshot.activeCredits.USD).toBeNull();
    expect(snapshot.accountDataError).toMatch(/尚未設定/);
    expect(mocks.getActiveFundingCredits).not.toHaveBeenCalled();
  });

  it('uses server credentials only for the local admin account', async () => {
    mocks.getUserSettings.mockResolvedValue(null);

    const snapshot = await getReadOnlyAccountSnapshot('00000000-0000-0000-0000-000000000001');

    expect(snapshot.accountDataAvailable).toBe(true);
    expect(mocks.getWallets).toHaveBeenCalledWith({ apiKey: 'server-key', apiSecret: 'server-secret' });
  });

  it('reports private API errors as unavailable instead of empty positions', async () => {
    mocks.getActiveFundingCredits.mockRejectedValue(new Error('private request failed'));

    const snapshot = await getReadOnlyAccountSnapshot('user-a');

    expect(snapshot.accountDataAvailable).toBe(false);
    expect(snapshot.activeCredits.USD).toBeNull();
    expect(snapshot.accountDataError).toMatch(/讀取失敗/);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it('classifies a rejected Bitfinex signature without exposing response details', async () => {
    mocks.getActiveFundingCredits.mockRejectedValue(new Error(
      'Bitfinex API 錯誤 (500): ["error",10100,"apikey: digest invalid"]',
    ));

    const snapshot = await getReadOnlyAccountSnapshot('user-a');

    expect(snapshot.accountDataErrorCode).toBe('BITFINEX_SIGNATURE_INVALID');
    expect(snapshot.accountDataError).toMatch(/核對 API Key 與 Secret/);
    expect(snapshot.accountDataError).not.toContain('digest invalid');
    expect(mocks.logger.warn).toHaveBeenCalledWith('dashboard', expect.any(String), expect.objectContaining({
      errorCode: 'BITFINEX_SIGNATURE_INVALID',
      httpStatus: 500,
    }));
  });

  it('reports a saved credential decryption failure without contacting Bitfinex', async () => {
    const error = Object.assign(new Error('stored encrypted credential cannot be decrypted'), {
      code: 'CREDENTIAL_DECRYPTION_FAILED',
    });
    mocks.decryptWithFallback.mockImplementationOnce(() => { throw error; });

    const snapshot = await getReadOnlyAccountSnapshot('user-a');

    expect(snapshot.accountDataErrorCode).toBe('BITFINEX_CREDENTIAL_DECRYPTION_FAILED');
    expect(snapshot.accountDataError).toContain('重新輸入並儲存 API Key 與 Secret');
    expect(mocks.getWallets).not.toHaveBeenCalled();
  });

  it('classifies an out-of-order Bitfinex nonce as a retryable account sync error', async () => {
    mocks.getActiveFundingCredits.mockRejectedValue(new Error(
      'Bitfinex API 錯誤 (500): ["error",10114,"nonce: small"]',
    ));

    const snapshot = await getReadOnlyAccountSnapshot('user-a');

    expect(snapshot.accountDataErrorCode).toBe('BITFINEX_NONCE_OUT_OF_ORDER');
    expect(snapshot.accountDataError).toContain('請求順序衝突');
    expect(snapshot.accountDataError).not.toContain('nonce: small');
  });

  it('preserves the last successful snapshot when a refresh temporarily fails', async () => {
    const first = await getReadOnlyAccountSnapshot('user-a');
    mocks.getWallets.mockRejectedValue(new Error('temporary network failure'));

    const stale = await getReadOnlyAccountSnapshot('user-a', Date.now() + 31 * 1000);

    expect(first.accountDataAvailable).toBe(true);
    expect(stale.accountDataAvailable).toBe(true);
    expect(stale.accountDataStale).toBe(true);
    expect(stale.wallets.USD).toEqual(first.wallets.USD);
  });
});
