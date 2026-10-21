const jwt = require('jsonwebtoken');
const { closeWebSocketAndTerminate } = require('./websocket-close');

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const TOKEN_EXPIRED_CLOSE_CODE = 1008;
const TOKEN_EXPIRED_CLOSE_REASON = 'Authentication token expired';

function getTokenExpiresAt(token) {
    try {
        const payload = jwt.decode(token);
        if (!payload || typeof payload !== 'object' || !Number.isFinite(payload.exp)) return null;
        return payload.exp * 1000;
    } catch {
        return null;
    }
}

function createTokenExpiryGuard(socket, expiresAt, now = Date.now) {
    let timer = null;
    let disposed = false;
    let expired = false;

    function closeExpiredSocket() {
        if (expired || disposed) return;
        expired = true;
        if (socket.readyState === 1) {
            closeWebSocketAndTerminate(socket, TOKEN_EXPIRED_CLOSE_CODE, TOKEN_EXPIRED_CLOSE_REASON);
        }
    }

    function isValid() {
        if (disposed || expired) return false;
        if (!Number.isFinite(expiresAt) || now() >= expiresAt) {
            closeExpiredSocket();
            return false;
        }
        return true;
    }

    function scheduleExpiry() {
        const remainingMs = expiresAt - now();
        if (remainingMs <= 0) {
            closeExpiredSocket();
            return;
        }
        timer = setTimeout(() => {
            if (isValid()) scheduleExpiry();
        }, Math.min(remainingMs, MAX_TIMEOUT_MS));
        timer.unref?.();
    }

    scheduleExpiry();

    return {
        isValid,
        dispose() {
            disposed = true;
            if (timer) clearTimeout(timer);
        },
    };
}

module.exports = { createTokenExpiryGuard, getTokenExpiresAt };
