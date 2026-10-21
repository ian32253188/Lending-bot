import { afterEach, describe, expect, it, vi } from 'vitest';

const { createTokenExpiryGuard, getTokenExpiresAt } = require('./jwt-expiry');
const jwt = require('jsonwebtoken');

describe('JWT expiry controls', () => {
  afterEach(() => vi.useRealTimers());

  it('returns only a finite JWT exp timestamp', () => {
    const expirySeconds = Math.floor(Date.now() / 1000) + 60;
    const token = jwt.sign({ id: 'user', exp: expirySeconds }, 'test-secret');
    const tokenWithoutExpiry = jwt.sign({ id: 'user' }, 'test-secret');

    expect(getTokenExpiresAt(token)).toBe(expirySeconds * 1000);
    expect(getTokenExpiresAt(tokenWithoutExpiry)).toBeNull();
    expect(getTokenExpiresAt('not-a-jwt')).toBeNull();
  });

  it('closes an authenticated socket at token expiry and rejects later access checks', () => {
    vi.useFakeTimers();
    const socket = { readyState: 1, close: vi.fn() };
    const expiry = Date.now() + 5_000;
    const guard = createTokenExpiryGuard(socket, expiry);

    vi.advanceTimersByTime(5_000);

    expect(socket.close).toHaveBeenCalledWith(1008, 'Authentication token expired');
    expect(guard.isValid()).toBe(false);
    guard.dispose();
  });
});
