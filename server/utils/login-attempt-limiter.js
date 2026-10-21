const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 10_000;

function createLoginAttemptLimiter({
    maxFailedAttempts = MAX_FAILED_ATTEMPTS,
    windowMs = WINDOW_MS,
    maxTrackedClients = MAX_TRACKED_CLIENTS,
    now = Date.now,
} = {}) {
    if (!Number.isInteger(maxTrackedClients) || maxTrackedClients < 1) {
        throw new RangeError('maxTrackedClients must be a positive integer');
    }

    const attempts = new Map();

    function removeExpired(nowMs) {
        for (const [key, entry] of attempts.entries()) {
            if (entry.resetAt <= nowMs) attempts.delete(key);
        }
    }

    function getTrackedEntry(clientKey, nowMs) {
        const entry = attempts.get(clientKey);
        if (entry && entry.resetAt > nowMs) {
            // Refresh insertion order so a full map evicts the least recently used client.
            attempts.delete(clientKey);
            attempts.set(clientKey, entry);
            return entry;
        }
        if (entry) attempts.delete(clientKey);
        return null;
    }

    function createEntry(clientKey, nowMs) {
        removeExpired(nowMs);
        if (attempts.size >= maxTrackedClients) {
            const leastRecentlyUsed = attempts.keys().next().value;
            if (leastRecentlyUsed !== undefined) attempts.delete(leastRecentlyUsed);
        }

        const entry = { failures: 0, resetAt: nowMs + windowMs };
        attempts.set(clientKey, entry);
        return entry;
    }

    function statusFor(entry, nowMs) {
        if (!entry || entry.resetAt <= nowMs || entry.failures < maxFailedAttempts) {
            return { blocked: false, retryAfterSeconds: 0 };
        }
        return {
            blocked: true,
            retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)),
        };
    }

    return {
        check(clientKey) {
            const nowMs = now();
            const key = String(clientKey || 'unknown');
            const entry = getTrackedEntry(key, nowMs);
            return statusFor(entry, nowMs);
        },
        recordFailure(clientKey) {
            const nowMs = now();
            const key = String(clientKey || 'unknown');
            const entry = getTrackedEntry(key, nowMs) || createEntry(key, nowMs);
            entry.failures += 1;
            return statusFor(entry, nowMs);
        },
        clear(clientKey) {
            const key = String(clientKey || 'unknown');
            attempts.delete(key);
        },
    };
}

module.exports = { createLoginAttemptLimiter };
