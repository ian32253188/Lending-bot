const jwt = require('jsonwebtoken');
const config = require('../config');
const { getSupabase } = require('../services/database');
const { isSingleAccount } = require('../config/single-account');

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

    // 檢查快取
    const now = Date.now();
    const cached = tokenCache.get(token);
    if (cached && now < cached.expiresAt) {
        if (!isSingleAccount(cached.user.id)) {
            tokenCache.delete(token);
            return res.status(403).json({ error: '此系統僅開放單一管理帳戶' });
        }
        req.user = cached.user;
        return next();
    }

    // 1. 原生 JWT 驗證
    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        if (decoded && decoded.id) {
            if (!isSingleAccount(decoded.id)) {
                return res.status(403).json({ error: '此系統僅開放單一管理帳戶' });
            }
            const user = {
                id: decoded.id,
                email: decoded.email,
                role: decoded.role || 'user',
            };
            tokenCache.set(token, {
                user,
                expiresAt: now + CACHE_TTL_MS
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
        try {
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (!error && user) {
                if (!isSingleAccount(user.id)) {
                    return res.status(403).json({ error: '此系統僅開放單一管理帳戶' });
                }
                tokenCache.set(token, {
                    user,
                    expiresAt: now + CACHE_TTL_MS
                });
                req.user = user;
                return next();
            }
        } catch (err) {}
    }

    return res.status(401).json({ error: 'Token 無效或已過期' });
}

module.exports = authMiddleware;
