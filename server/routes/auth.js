const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getSupabase } = require('../services/database');
const { SINGLE_ACCOUNT_USER_ID, isSingleAccount } = require('../config/single-account');

const router = express.Router();

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
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: '請輸入密碼' });
        }

        const adminPassword = config.admin?.password || 'admin';
        if (password !== adminPassword) {
            return res.status(401).json({ error: '密碼錯誤' });
        }

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
        try {
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (!error && user) {
                if (!isSingleAccount(user.id)) {
                    return res.status(403).json({ valid: false, error: '此系統僅開放單一管理帳戶' });
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
        } catch {}
    }

    return res.status(401).json({ valid: false });
});

module.exports = router;
