const { getTokenExpiresAt } = require('../utils/jwt-expiry');

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_CLIENT = 60;
const MAX_REQUESTS_PER_INSTANCE = 600;
const MAX_TRACKED_CLIENTS = 10_000;

function createFixedWindowLimiter({ maxRequests, windowMs = WINDOW_MS, maxTrackedClients = 1, now = Date.now }) {
    if (!Number.isInteger(maxTrackedClients) || maxTrackedClients < 1) {
        throw new RangeError('maxTrackedClients must be a positive integer');
    }

    const requests = new Map();

    function removeExpired(nowMs) {
        for (const [key, entry] of requests.entries()) {
            if (entry.resetAt <= nowMs) requests.delete(key);
        }
    }

    function keyFor(clientKey, nowMs) {
        const key = String(clientKey || 'unknown');
        const current = requests.get(key);
        if (current && current.resetAt > nowMs) {
            // Keep recently active clients in the bounded tracking map.
            requests.delete(key);
            requests.set(key, current);
            return key;
        }
        if (current) requests.delete(key);

        removeExpired(nowMs);
        if (requests.size >= maxTrackedClients) {
            const leastRecentlyUsed = requests.keys().next().value;
            if (leastRecentlyUsed !== undefined) requests.delete(leastRecentlyUsed);
        }
        return key;
    }

    return {
        consume(clientKey) {
            const nowMs = now();
            const key = keyFor(clientKey, nowMs);
            let entry = requests.get(key);
            if (!entry || entry.resetAt <= nowMs) {
                entry = { count: 0, resetAt: nowMs + windowMs };
            }

            if (entry.count >= maxRequests) {
                return {
                    allowed: false,
                    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)),
                };
            }

            entry.count += 1;
            requests.set(key, entry);
            return { allowed: true, retryAfterSeconds: 0 };
        },
    };
}

function getRequestClientKey(request) {
    return request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress || 'unknown';
}

function createSupabaseAuthFallback({
    maxRequestsPerClient = MAX_REQUESTS_PER_CLIENT,
    maxRequestsPerInstance = MAX_REQUESTS_PER_INSTANCE,
    windowMs = WINDOW_MS,
    maxTrackedClients = MAX_TRACKED_CLIENTS,
    now = Date.now,
} = {}) {
    const clientLimiter = createFixedWindowLimiter({ maxRequests: maxRequestsPerClient, windowMs, maxTrackedClients, now });
    const instanceLimiter = createFixedWindowLimiter({ maxRequests: maxRequestsPerInstance, windowMs, now });

    return {
        async verify({ supabase, token, request }) {
            // These tokens would be rejected after the remote lookup anyway. Check their
            // structure and expiry first so malformed and expired input never leaves the app.
            const expiresAt = getTokenExpiresAt(token);
            if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
                return { user: null, error: null, rateLimited: false, expiresAt };
            }

            const clientLimit = clientLimiter.consume(getRequestClientKey(request));
            if (!clientLimit.allowed) {
                return { user: null, error: null, rateLimited: true, retryAfterSeconds: clientLimit.retryAfterSeconds };
            }

            const instanceLimit = instanceLimiter.consume('all');
            if (!instanceLimit.allowed) {
                return { user: null, error: null, rateLimited: true, retryAfterSeconds: instanceLimit.retryAfterSeconds };
            }

            try {
                const result = await supabase.auth.getUser(token);
                return {
                    user: result?.data?.user || null,
                    error: result?.error || null,
                    rateLimited: false,
                    expiresAt,
                };
            } catch (error) {
                return { user: null, error, rateLimited: false, expiresAt };
            }
        },
    };
}

const supabaseAuthFallback = createSupabaseAuthFallback();

module.exports = {
    createSupabaseAuthFallback,
    verifySupabaseToken: (args) => supabaseAuthFallback.verify(args),
};
