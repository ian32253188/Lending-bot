import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserSettings: vi.fn(),
  getEarnings: vi.fn(),
  saveEarnings: vi.fn(),
  authRequest: vi.fn(),
  sendActualFundingInterestNotification: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockModule = (modulePath: string, exports: unknown) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any;
};

mockModule('../../config', { lending: { symbolToCurrency: { USD: 'USD' } } });
mockModule('../../utils/logger', mocks.logger);
mockModule('../../utils/crypto', { decryptWithFallback: (value: string) => value });
mockModule('../database', {
  getUserSettings: mocks.getUserSettings,
  getEarnings: mocks.getEarnings,
  saveEarnings: mocks.saveEarnings,
});
mockModule('../bitfinex/rest', { authRequest: mocks.authRequest });
mockModule('../telegram', { sendActualFundingInterestNotification: mocks.sendActualFundingInterestNotification });

const { parseLedgerEntry, syncUserEarnings } = require('./sync');
const userId = 'user-a';

describe('actual funding interest ledger sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserSettings.mockResolvedValue({
      bitfinex_api_key: 'key',
      bitfinex_api_secret: 'secret',
    });
    mocks.getEarnings.mockResolvedValue([{
      ledger_id: 100,
      amount: '0.1',
      earned_at: '2026-10-01T00:00:00.000Z',
    }]);
    mocks.authRequest.mockResolvedValue([]);
    mocks.saveEarnings.mockImplementation(async (rows: any[]) => rows.map(row => ({
      ledger_id: row.ledgerId,
      amount: row.amount,
      earned_at: row.earnedAt,
    })));
    mocks.sendActualFundingInterestNotification.mockResolvedValue(undefined);
  });

  it('reads the changed amount, timestamp, and description from the current Bitfinex ledger shape', () => {
    const row = [101, 'USD', 'funding', Date.parse('2026-10-12T01:02:03Z'), null, 0.12345678, 500.12345678, null, 'Funding Payment'];

    expect(parseLedgerEntry(row)).toEqual({
      id: 101,
      currency: 'USD',
      wallet: 'funding',
      amount: 0.12345678,
      earnedAt: '2026-10-12T01:02:03.000Z',
      description: 'Funding Payment',
    });
  });

  it('stores and notifies the actual positive USD funding-wallet ledger amount once', async () => {
    const earnedAt = Date.parse('2026-10-12T01:02:03Z');
    mocks.authRequest.mockResolvedValue([
      [101, 'USD', 'funding', earnedAt, null, 0.12345678, 500.12345678, null, 'Funding Payment'],
      [102, 'USD', 'funding', earnedAt + 1000, null, -0.25, 499.87345678, null, 'Funding Payment'],
      [103, 'USD', 'exchange', earnedAt + 2000, null, 0.5, 100.5, null, 'Funding Payment'],
    ]);

    const result = await syncUserEarnings(userId, true, true);

    expect(mocks.authRequest).toHaveBeenCalledWith('/auth/r/ledgers/hist', {
      limit: 2500,
      category: 28,
      wallet: 'funding',
    }, { apiKey: 'key', apiSecret: 'secret' });
    expect(mocks.saveEarnings).toHaveBeenCalledWith([expect.objectContaining({
      currency: 'USD',
      amount: 0.12345678,
      rate: 0,
      period: 0,
      earnedAt: '2026-10-12T01:02:03.000Z',
      ledgerId: 101,
    })], userId);
    expect(mocks.sendActualFundingInterestNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendActualFundingInterestNotification).toHaveBeenCalledWith(expect.objectContaining({
      currency: 'USD',
      amount: 0.12345678,
      earnedAt: '2026-10-12T01:02:03.000Z',
      id: 101,
      wallet: 'funding',
    }), userId);
    expect(result).toEqual([{
      currency: 'USD',
      amount: 0.12345678,
      earnedAt: '2026-10-12T01:02:03.000Z',
      ledgerId: 101,
    }]);
  });
});
