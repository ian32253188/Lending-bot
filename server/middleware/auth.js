const jwt = require('jsonwebtoken');
const config = require('../config');
const { getSupabase } = require('../services/database');
const { isSingleAccount } = require('../config/single-account');
const { getTokenExpiresAt } = require('../utils/jwt-expiry');
const { verifySupabaseToken, isDefinitiveAuthRejection } = require('../services/supabase-auth-fallback');
const sessionState = require('../utils/session-state');

const tokenCache = new Map(); // token -> { user, expiresAt }
const CACHE_TTL_MS = 60 * 1000; // 60 seconds TTL

// 定期清理過期的快取 Token
setInterval(() => {
    const now = Date.now();
    for (const [token, cache] of tokenCache.entries()) {
        if (now > cache.expiresAt) {
            tokenCache.delete(token);
        }
    }
}, 5 * 60 * 1000).unref();

async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未提供認證 Token' });
    }

    const token = authHeader.split(' ')[1];

    let currentState;
    try {
        currentState = await sessionState.getState();
    } catch (err) {
        return res.status(503).json({ error: '認證服務暫時無法使用' });
    }

    // 檢查快取
    const now = Date.now();
    const cached = tokenCache.get(token);
    if (cached && now < cached.expiresAt
        && cached.sessionVersion === currentState.version
        && (!cached.supabase || currentState.revokedAtMs === null || cached.tokenIssuedAtMs > currentState.revokedAtMs)) {
        if (!isSingleAccount(cached.user.id)) {
            tokenCache.delete(token);
            return res.status(403).json({ error: '此系統僅開放單一管理帳戶' });
        }
        req.user = cached.user;
        return next();
    }
    if (cached) tokenCache.delete(token);

    // 1. 原生 JWT 驗證
    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        if (decoded && decoded.id) {
            if (!isSingleAccount(decoded.id)) {
                return res.status(403).json({ error: '此系統僅開放單一管理帳戶' });
            }
            const tokenExpiresAt = getTokenExpiresAt(token);
            if (tokenExpiresAt === null || tokenExpiresAt <= now) {
                return res.status(401).json({ error: 'Token 無效或已過期' });
            }
            if (!sessionState.isLocalTokenCurrent(decoded, currentState)) {
                return res.status(401).json({ error: 'Token 無效或已過期' });
            }
            const user = {
                id: decoded.id,
                email: decoded.email,
                role: decoded.role || 'user',
            };
            tokenCache.set(token, {
                user,
                expiresAt: Math.min(now + CACHE_TTL_MS, tokenExpiresAt),
                sessionVersion: currentState.version,
            });
            req.user = user;
            return next();
        }
    } catch (jwtErr) {
        // 本地驗證失敗，繼續嘗試 Supabase (若有)
    }

    // 2. 備用：若有 Supabase，嘗試驗證舊 Supabase Token
    const supabase = getSupabase();
    if (supabase) {
        const result = await verifySupabaseToken({ supabase, token, request: req });
        if (result.rateLimited) {
            res.set('Retry-After', String(result.retryAfterSeconds));
            return res.status(429).json({ error: '認證請求過多，請稍後再試' });
        }
        const { user, error } = result;
        if (error && !isDefinitiveAuthRejection(error)) {
            return res.status(503).json({ error: '外部認證服務暫時無法使用' });
        }
        if (!error && user) {
            const tokenExpiresAt = getTokenExpiresAt(token);
            if (!isSingleAccount(user.id)) {
                return res.status(403).json({ error: '此系統僅開放單一管理帳戶' });
            }
            if (tokenExpiresAt === null || tokenExpiresAt <= Date.now()) {
                return res.status(401).json({ error: 'Token 無效或已過期' });
            }
            if (!sessionState.isSupabaseTokenCurrent(token, currentState)) {
                return res.status(401).json({ error: 'Token 無效或已過期' });
            }
            tokenCache.set(token, {
                user,
                expiresAt: Math.min(Date.now() + CACHE_TTL_MS, tokenExpiresAt),
                sessionVersion: currentState.version,
                supabase: true,
                tokenIssuedAtMs: Number(jwt.decode(token)?.iat) * 1000,
            });
            req.user = user;
            return next();
        }
    }

    return res.status(401).json({ error: 'Token 無效或已過期' });
}

module.exports = authMiddleware;
