const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getSupabase } = require('../services/database');
const { SINGLE_ACCOUNT_USER_ID, isSingleAccount } = require('../config/single-account');
const { createLoginAttemptLimiter } = require('../utils/login-attempt-limiter');
const { getTokenExpiresAt } = require('../utils/jwt-expiry');
const { verifySupabaseToken } = require('../services/supabase-auth-fallback');

const router = express.Router();
const loginAttemptLimiter = createLoginAttemptLimiter();

// 本地管理員固定帳號 ID（與資料庫 01_init.sql 保持一致）
const ADMIN_USER = {
    id: SINGLE_ACCOUNT_USER_ID,
    email: 'admin@lending-bot.local',
    role: 'admin',
};

// 取得認證配置
router.get('/config', (req, res) => {
    res.json({
        authMode: 'local',
        supabaseUrl: config.supabase?.url || '',
        supabaseAnonKey: config.supabase?.anonKey || '',
    });
});

// 本地管理員密碼登入
router.post('/login', (req, res) => {
    try {
        // Do not trust X-Forwarded-For here. This single-account deployment
        // binds the application behind its reverse proxy, which enforces a
        // separate per-client limit at the edge.
        const clientKey = req.ip || req.socket?.remoteAddress || 'unknown';
        const attemptStatus = loginAttemptLimiter.check(clientKey);
        if (attemptStatus.blocked) {
            res.set('Retry-After', String(attemptStatus.retryAfterSeconds));
            return res.status(429).json({ error: '登入嘗試過多，請稍後再試' });
        }

        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: '請輸入密碼' });
        }

        const adminPassword = config.admin?.password;
        if (!adminPassword) {
            return res.status(503).json({ error: '管理員登入尚未設定，請聯絡系統管理員' });
        }
        if (password !== adminPassword) {
            const result = loginAttemptLimiter.recordFailure(clientKey);
            if (result.blocked) {
                res.set('Retry-After', String(result.retryAfterSeconds));
                return res.status(429).json({ error: '登入嘗試過多，請稍後再試' });
            }
            return res.status(401).json({ error: '密碼錯誤' });
        }

        loginAttemptLimiter.clear(clientKey);

        const token = jwt.sign(
            ADMIN_USER,
            config.jwt.secret,
            { expiresIn: config.jwt.expiresIn || '24h' }
        );

        res.json({
            token,
            user: ADMIN_USER,
            expiresIn: config.jwt.expiresIn || '24h'
        });
    } catch (err) {
        res.status(500).json({ error: '登入失敗', details: err.message });
    }
});

// 驗證 Token (優先本地 JWT 驗證)
router.get('/verify', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }

    const token = authHeader.split(' ')[1];

    // 1. 優先嘗試本地原生 JWT 驗證
    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        if (decoded && decoded.id) {
            if (!isSingleAccount(decoded.id)) {
                return res.status(403).json({ valid: false, error: '此系統僅開放單一管理帳戶' });
            }
            const expiresAt = getTokenExpiresAt(token);
            if (expiresAt === null || expiresAt <= Date.now()) {
                return res.status(401).json({ valid: false });
            }
            return res.json({
                valid: true,
                user: {
                    id: decoded.id,
                    email: decoded.email,
                    role: decoded.role || 'user',
                    created_at: decoded.created_at
                }
            });
        }
    } catch (jwtErr) {
        // 本地驗證未通過，若非過期錯誤且有 Supabase 則嘗試 fallback
    }

    // 2. 備用：若有 Supabase，嘗試驗證 Supabase JWT (相容舊 Session)
    const supabase = getSupabase();
    if (supabase) {
        const result = await verifySupabaseToken({ supabase, token, request: req });
        if (result.rateLimited) {
            res.set('Retry-After', String(result.retryAfterSeconds));
            return res.status(429).json({ valid: false, error: '認證請求過多，請稍後再試' });
        }
        const { user, error } = result;
        if (!error && user) {
            const expiresAt = getTokenExpiresAt(token);
            if (!isSingleAccount(user.id)) {
                return res.status(403).json({ valid: false, error: '此系統僅開放單一管理帳戶' });
            }
            if (expiresAt === null || expiresAt <= Date.now()) {
                return res.status(401).json({ valid: false });
            }
            return res.json({
                valid: true,
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    created_at: user.created_at
                }
            });
        }
    }

    return res.status(401).json({ valid: false });
});

module.exports = router;
