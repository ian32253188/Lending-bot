'use strict';

const FORCE_CLOSE_GRACE_MS = 250;

function closeWebSocketAndTerminate(socket, code, reason, graceMs = FORCE_CLOSE_GRACE_MS) {
    if (!socket || (socket.readyState !== 1 && socket.readyState !== 2)) return;

    let timer = null;
    const cleanup = () => {
        if (timer) clearTimeout(timer);
    };
    socket.once?.('close', cleanup);

    if (socket.readyState === 1) socket.close(code, reason);
    timer = setTimeout(() => {
        if (socket.readyState === 2) socket.terminate();
    }, graceMs);
    timer.unref?.();
}

module.exports = { closeWebSocketAndTerminate, FORCE_CLOSE_GRACE_MS };
