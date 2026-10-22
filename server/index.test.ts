import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./utils/logger', () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const net = require('net');
const { randomBytes } = require('crypto');
const config = require('./config');
const { SINGLE_ACCOUNT_USER_ID } = require('./config/single-account');
const {
  app,
  server,
  WS_MAX_UNAUTHENTICATED_CLIENTS,
  WS_MAX_UNAUTHENTICATED_CLIENTS_PER_IP,
} = require('./index');
config.server.trustProxyHops = 1;
app.set('trust proxy', 1);

let serverPort: number;

function openUnauthenticatedRawWebSocket(port: number, forwardedFor?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.once('error', (error: Error) => {
      socket.destroy();
      reject(error);
    });
    socket.once('connect', () => {
      socket.write([
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        ...(forwardedFor ? [`X-Forwarded-For: ${forwardedFor}`] : []),
        '',
        '',
      ].join('\r\n'));
    });
    const onData = (chunk: Buffer) => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n\r\n')) return;
      socket.removeListener('data', onData);
      if (!response.startsWith('HTTP/1.1 101')) {
        socket.destroy();
        reject(new Error(`Unexpected WebSocket upgrade response: ${response.split('\r\n')[0]}`));
        return;
      }
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

function sendMaskedTextFrame(socket: any, message: string): void {
  const payload = Buffer.from(message);
  const mask = randomBytes(4);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const maskedPayload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % mask.length]));
  socket.write(Buffer.concat([header, mask, maskedPayload]));
}

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  serverPort = server.address().port;
});

afterAll(async () => {
  if (server.listening) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('authenticated WebSocket lifetime', () => {
  it('uses only the configured number of trusted reverse proxy hops', () => {
    expect(app.get('trust proxy')).toBe(config.server.trustProxyHops);
  });

  it('closes the connection and refuses protected messages after JWT exp', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 120;
    const token = jwt.sign({ id: SINGLE_ACCOUNT_USER_ID, role: 'admin', exp: expiresAt }, config.jwt.secret);
    const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    const authSucceeded = new Promise<void>((resolve, reject) => {
      socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token })));
      socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'auth' && message.status === 'ok') resolve();
        if (message.type === 'auth' && message.status === 'error') reject(new Error(message.message));
      });
    });
    const socketClosed = new Promise<{ code: number; reason: Buffer }>(resolve => {
      socket.once('close', (code: number, reason: Buffer) => resolve({ code, reason }));
    });

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      await authSucceeded;
      nowSpy.mockReturnValue(expiresAt * 1000 + 1);
      socket.send(JSON.stringify({ type: 'getDetailed' }));

      const closed = await socketClosed;
      expect(closed.code).toBe(1008);
      expect(closed.reason.toString()).toBe('Authentication token expired');
    } finally {
      nowSpy.mockRestore();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
  }, 10_000);

  it('closes a client that does not authenticate within the allowed window', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    const socketClosed = new Promise<{ code: number; reason: Buffer }>(resolve => {
      socket.once('close', (code: number, reason: Buffer) => resolve({ code, reason }));
    });

    try {
      const closed = await socketClosed;
      expect(closed.code).toBe(1008);
      expect(closed.reason.toString()).toBe('Authentication required');
    } finally {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
  }, 8_000);

  it('limits unauthenticated slots and releases them after authentication or close', async () => {
    const rawSockets: any[] = [];
    let authenticatedSocket: any;
    let availableSocket: any;
    try {
      rawSockets.push(...await Promise.all(Array.from(
        { length: WS_MAX_UNAUTHENTICATED_CLIENTS_PER_IP },
        () => openUnauthenticatedRawWebSocket(serverPort, '203.0.113.10'),
      )));
      await expect(openUnauthenticatedRawWebSocket(serverPort, '203.0.113.10'))
        .rejects.toThrow(/HTTP\/1\.1 503/);
      rawSockets.push(...await Promise.all(Array.from(
        { length: WS_MAX_UNAUTHENTICATED_CLIENTS - WS_MAX_UNAUTHENTICATED_CLIENTS_PER_IP - 1 },
        () => openUnauthenticatedRawWebSocket(serverPort, '203.0.113.11'),
      )));

      const expiresAt = Math.floor(Date.now() / 1000) + 120;
      const token = jwt.sign({ id: SINGLE_ACCOUNT_USER_ID, role: 'admin', exp: expiresAt }, config.jwt.secret);
      authenticatedSocket = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`, {
        headers: { 'X-Forwarded-For': '203.0.113.12' },
      });
      const authSucceeded = new Promise<void>((resolve, reject) => {
        authenticatedSocket.on('open', () => authenticatedSocket.send(JSON.stringify({ type: 'auth', token })));
        authenticatedSocket.on('message', (raw: Buffer) => {
          const message = JSON.parse(raw.toString());
          if (message.type === 'auth' && message.status === 'ok') resolve();
          if (message.type === 'auth' && message.status === 'error') reject(new Error(message.message));
        });
      });
      await authSucceeded;

      rawSockets.push(await openUnauthenticatedRawWebSocket(serverPort, '203.0.113.12'));
      await expect(openUnauthenticatedRawWebSocket(serverPort, '203.0.113.13'))
        .rejects.toThrow(/HTTP\/1\.1 503/);

      await new Promise(resolve => setTimeout(resolve, 6_000));
      const closedPromptly = await Promise.race([
        Promise.all(rawSockets.map(socket => socket.destroyed
          ? Promise.resolve()
          : new Promise(resolve => socket.once('close', resolve)))).then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(closedPromptly).toBe(true);

      availableSocket = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
      await new Promise<void>((resolve, reject) => {
        availableSocket.once('open', resolve);
        availableSocket.once('error', reject);
        availableSocket.once('unexpected-response', (_request: unknown, response: any) => {
          reject(new Error(`Unexpected HTTP ${response.statusCode}`));
        });
      });
    } finally {
      rawSockets.forEach(socket => socket.destroy());
      if (authenticatedSocket && authenticatedSocket.readyState !== WebSocket.CLOSED) authenticatedSocket.terminate();
      if (availableSocket && availableSocket.readyState !== WebSocket.CLOSED) availableSocket.terminate();
    }
  }, 12_000);

  it('forces immediate unauthenticated message clients off the socket when they ignore close frames', async () => {
    const socket = await openUnauthenticatedRawWebSocket(serverPort);
    const closed = new Promise<boolean>(resolve => {
      socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 1_000);
    });

    try {
      sendMaskedTextFrame(socket, JSON.stringify({ type: 'getDetailed' }));
      expect(await closed).toBe(true);
    } finally {
      socket.destroy();
    }
  }, 4_000);

  it('closes a previously authenticated client after rejected re-authentication', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 120;
    const token = jwt.sign({ id: SINGLE_ACCOUNT_USER_ID, role: 'admin', exp: expiresAt }, config.jwt.secret);
    const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    let resolveAuthSuccess!: () => void;
    let resolveAuthFailure!: () => void;
    const authSucceeded = new Promise<void>(resolve => { resolveAuthSuccess = resolve; });
    const authFailed = new Promise<void>(resolve => { resolveAuthFailure = resolve; });
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token })));
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'auth') return;
      if (message.status === 'ok') resolveAuthSuccess();
      if (message.status === 'error') resolveAuthFailure();
    });

    try {
      await authSucceeded;
      socket.send(JSON.stringify({ type: 'auth' }));
      await authFailed;

      const close = await new Promise<{ code: number; reason: Buffer } | null>(resolve => {
        const timer = setTimeout(() => resolve(null), 6_500);
        socket.once('close', (code: number, reason: Buffer) => {
          clearTimeout(timer);
          resolve({ code, reason });
        });
      });

      expect(close).not.toBeNull();
      expect(close?.code).toBe(1008);
      expect(close?.reason.toString()).toBe('Authentication required');
    } finally {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
  }, 9_000);

  it('rejects oversized WebSocket frames before JSON parsing', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    const socketClosed = new Promise<{ code: number }>(resolve => {
      socket.once('close', (code: number) => resolve({ code }));
    });
    socket.on('open', () => socket.send('x'.repeat(17 * 1024)));

    try {
      const closed = await socketClosed;
      expect(closed.code).toBe(1009);
    } finally {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
  }, 8_000);
});
