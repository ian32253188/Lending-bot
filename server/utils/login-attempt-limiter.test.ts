import { describe, expect, it } from 'vitest';

const { createLoginAttemptLimiter } = require('./login-attempt-limiter');

describe('login attempt limiter', () => {
  it('blocks a client after repeated failures and releases the block at the window boundary', () => {
    let now = 1_000;
    const limiter = createLoginAttemptLimiter({ maxFailedAttempts: 3, windowMs: 60_000, now: () => now });

    expect(limiter.recordFailure('client-a').blocked).toBe(false);
    expect(limiter.recordFailure('client-a').blocked).toBe(false);
    expect(limiter.recordFailure('client-a')).toMatchObject({ blocked: true, retryAfterSeconds: 60 });
    expect(limiter.check('client-a').blocked).toBe(true);

    now += 60_000;
    expect(limiter.check('client-a').blocked).toBe(false);
  });

  it('tracks clients separately and clears attempts after a successful login', () => {
    const limiter = createLoginAttemptLimiter({ maxFailedAttempts: 2, now: () => 1_000 });

    limiter.recordFailure('client-a');
    expect(limiter.check('client-b').blocked).toBe(false);
    limiter.clear('client-a');
    expect(limiter.recordFailure('client-a').blocked).toBe(false);
  });

  it('keeps unknown clients isolated and evicts the least recently used entry at capacity', () => {
    const limiter = createLoginAttemptLimiter({
      maxFailedAttempts: 2,
      maxTrackedClients: 2,
      now: () => 1_000,
    });

    limiter.recordFailure('client-a');
    expect(limiter.recordFailure('client-a').blocked).toBe(true);
    limiter.recordFailure('client-b');

    expect(limiter.check('untracked-client').blocked).toBe(false);
    expect(limiter.check('client-a').blocked).toBe(true);

    expect(limiter.recordFailure('client-c').blocked).toBe(false);
    expect(limiter.check('client-a').blocked).toBe(true);
    expect(limiter.check('client-b').blocked).toBe(false);
    expect(limiter.check('client-c').blocked).toBe(false);
  });

  it('rejects a zero-sized tracking map instead of creating an unbounded entry', () => {
    expect(() => createLoginAttemptLimiter({ maxTrackedClients: 0 }))
      .toThrow('maxTrackedClients must be a positive integer');
  });
});
