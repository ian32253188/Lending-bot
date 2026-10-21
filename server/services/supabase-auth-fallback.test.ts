import { describe, expect, it, vi } from 'vitest';

const jwt = require('jsonwebtoken');
const { SINGLE_ACCOUNT_USER_ID } = require('../config/single-account');
const { createSupabaseAuthFallback } = require('./supabase-auth-fallback');

function futureToken(secret = 'legacy-supabase-signing-key') {
  return jwt.sign({ sub: SINGLE_ACCOUNT_USER_ID }, secret, { expiresIn: '1h' });
}

describe('Supabase auth fallback boundary', () => {
  it('rejects malformed and expired tokens before calling the remote auth service', async () => {
    const supabase = { auth: { getUser: vi.fn() } };
    const fallback = createSupabaseAuthFallback({ now: () => 1_000 });
    const expiredToken = jwt.sign({ sub: SINGLE_ACCOUNT_USER_ID, exp: Math.floor(Date.now() / 1000) - 60 }, 'legacy-key');
    const tokenWithoutExpiry = jwt.sign({ sub: SINGLE_ACCOUNT_USER_ID }, 'legacy-key');

    for (const token of ['not-a-jwt', expiredToken, tokenWithoutExpiry]) {
      const result = await fallback.verify({ supabase, token, request: { ip: '203.0.113.10' } });
      expect(result).toMatchObject({ user: null, error: null, rateLimited: false });
    }

    expect(supabase.auth.getUser).not.toHaveBeenCalled();
  });

  it('bounds failed fallback calls per client and across the application instance', async () => {
    let now = 1_000;
    const supabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('invalid token') }) },
    };
    const fallback = createSupabaseAuthFallback({
      maxRequestsPerClient: 2,
      maxRequestsPerInstance: 3,
      windowMs: 60_000,
      maxTrackedClients: 10,
      now: () => now,
    });
    const token = futureToken('untrusted-key');

    await fallback.verify({ supabase, token, request: { ip: '203.0.113.10' } });
    await fallback.verify({ supabase, token, request: { ip: '203.0.113.10' } });
    const clientLimited = await fallback.verify({ supabase, token, request: { ip: '203.0.113.10' } });
    expect(clientLimited).toMatchObject({ rateLimited: true, retryAfterSeconds: 60 });

    await fallback.verify({ supabase, token, request: { socket: { remoteAddress: '203.0.113.11' } } });
    const instanceLimited = await fallback.verify({ supabase, token, request: { socket: { remoteAddress: '203.0.113.12' } } });
    expect(instanceLimited).toMatchObject({ rateLimited: true, retryAfterSeconds: 60 });
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(3);

    now += 60_000;
    const afterWindow = await fallback.verify({ supabase, token, request: { ip: '203.0.113.12' } });
    expect(afterWindow.rateLimited).toBe(false);
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(4);
  });

  it('keeps overflow clients isolated instead of sharing one fallback rate-limit bucket', async () => {
    const supabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('invalid token') }) },
    };
    const fallback = createSupabaseAuthFallback({
      maxRequestsPerClient: 1,
      maxRequestsPerInstance: 10,
      windowMs: 60_000,
      maxTrackedClients: 1,
    });
    const token = futureToken('overflow-key-test');

    const first = await fallback.verify({ supabase, token, request: { ip: '203.0.113.20' } });
    const second = await fallback.verify({ supabase, token, request: { ip: '203.0.113.21' } });
    const third = await fallback.verify({ supabase, token, request: { ip: '203.0.113.22' } });

    expect(first.rateLimited).toBe(false);
    expect(second.rateLimited).toBe(false);
    expect(third.rateLimited).toBe(false);
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(3);
  });

  it('preserves valid legacy Supabase sessions within the configured limits', async () => {
    const user = { id: SINGLE_ACCOUNT_USER_ID, email: 'legacy@example.invalid', role: 'authenticated' };
    const supabase = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) } };
    const fallback = createSupabaseAuthFallback({ maxRequestsPerClient: 1, maxRequestsPerInstance: 1 });
    const token = futureToken();

    const result = await fallback.verify({
      supabase,
      token,
      request: { socket: { remoteAddress: '127.0.0.1' } },
    });

    expect(result).toMatchObject({ user, error: null, rateLimited: false });
    expect(Number.isFinite(result.expiresAt)).toBe(true);
    expect(supabase.auth.getUser).toHaveBeenCalledWith(token);
  });
});
