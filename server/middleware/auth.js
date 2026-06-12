const { getSupabase } = require('../services/database');

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
        req.user = cached.user;
        return next();
    }

    const supabase = getSupabase();
    if (!supabase) {
        return res.status(500).json({ error: '資料庫模組未初始化' });
    }

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ error: 'Token 無效或已過期' });
        }

        // 寫入快取
        tokenCache.set(token, {
            user,
            expiresAt: now + CACHE_TTL_MS
        });

        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: '認證失敗', details: err.message });
    }
}

module.exports = authMiddleware;
