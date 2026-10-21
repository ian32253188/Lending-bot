function getTrustedClientIp(request, app) {
    if (typeof request?.ip === 'string' && request.ip) return request.ip;

    const remoteAddress = request?.socket?.remoteAddress || request?.connection?.remoteAddress || 'unknown';
    if (!request || !app?.request) return remoteAddress;

    // WebSocket upgrades use Node's IncomingMessage, which has no Express req.ip.
    // Reuse Express's public request prototype so X-Forwarded-For follows the same
    // configured trust-proxy policy as ordinary HTTP routes.
    const expressRequest = Object.create(app.request);
    expressRequest.headers = request.headers || {};
    expressRequest.socket = request.socket;
    expressRequest.connection = request.connection;
    return expressRequest.ip || remoteAddress;
}

module.exports = { getTrustedClientIp };
