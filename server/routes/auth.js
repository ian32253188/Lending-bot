const express = require('express');
const { getSupabase } = require('../services/database');

const router = express.Router();

// 取得 Supabase 設定
router.get('/config', (req, res) => {
    const config = require('../config');
    res.json({
        supabaseUrl: config.supabase.url,
        supabaseAnonKey: config.supabase.anonKey,
    });
});

// 驗證 Token
router.get('/verify', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }

    const token = authHeader.split(' ')[1];
    const supabase = getSupabase();
    if (!supabase) {
        return res.status(500).json({ error: '資料庫模組未初始化', valid: false });
    }

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ valid: false });
        }
        res.json({ 
            valid: true, 
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                created_at: user.created_at
            }
        });
    } catch {
        res.status(401).json({ valid: false });
    }
});

module.exports = router;
