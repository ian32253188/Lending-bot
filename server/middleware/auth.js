const { getSupabase } = require('../services/database');

async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未提供認證 Token' });
    }

    const token = authHeader.split(' ')[1];
    const supabase = getSupabase();
    if (!supabase) {
        return res.status(500).json({ error: '資料庫模組未初始化' });
    }

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ error: 'Token 無效或已過期' });
        }
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: '認證失敗', details: err.message });
    }
}

module.exports = authMiddleware;
