import { describe, expect, it } from 'vitest';
import express from 'express';

const { getTrustedClientIp } = require('./trusted-client-ip');

describe('trusted client IP resolution', () => {
  it('uses the configured Express proxy hop to select the real WebSocket client address', () => {
    const app = express();
    app.set('trust proxy', 1);
    const socket = { remoteAddress: '127.0.0.1' };
    const request = {
      socket,
      connection: socket,
      headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.7' },
    };

    expect(getTrustedClientIp(request, app)).toBe('203.0.113.7');
  });

  it('ignores forwarded addresses when no proxy hop is trusted', () => {
    const app = express();
    app.set('trust proxy', 0);
    const socket = { remoteAddress: '203.0.113.20' };
    const request = {
      socket,
      connection: socket,
      headers: { 'x-forwarded-for': '198.51.100.99' },
    };

    expect(getTrustedClientIp(request, app)).toBe('203.0.113.20');
  });
});
