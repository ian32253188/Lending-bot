import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const { closeWebSocketAndTerminate } = require('./websocket-close');

describe('WebSocket forced close', () => {
  afterEach(() => vi.useRealTimers());

  it('terminates a socket that does not complete its close handshake', () => {
    vi.useFakeTimers();
    const socket: any = new EventEmitter();
    socket.readyState = 1;
    socket.close = vi.fn(() => { socket.readyState = 2; });
    socket.terminate = vi.fn(() => { socket.readyState = 3; });

    closeWebSocketAndTerminate(socket, 1008, 'Authentication required', 250);

    expect(socket.close).toHaveBeenCalledWith(1008, 'Authentication required');
    vi.advanceTimersByTime(249);
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('cancels forced termination when the socket closes gracefully', () => {
    vi.useFakeTimers();
    const socket: any = new EventEmitter();
    socket.readyState = 1;
    socket.close = vi.fn(() => { socket.readyState = 2; });
    socket.terminate = vi.fn();

    closeWebSocketAndTerminate(socket, 1008, 'Authentication required', 250);
    socket.readyState = 3;
    socket.emit('close');
    vi.advanceTimersByTime(250);

    expect(socket.terminate).not.toHaveBeenCalled();
  });
});
