const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config');

const router = express.Router();

// 登入
router.post('/login', async (req, res) => {
    try {
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: '請輸入密碼' });
        }

        // 比較密碼（支援明文比對或 bcrypt）
        const adminPassword = config.admin.password;
        let isValid = password === adminPassword;

        if (!isValid && adminPassword.startsWith('$2')) {
            isValid = await bcrypt.compare(password, adminPassword);
        }

        if (!isValid) {
            return res.status(401).json({ error: '密碼錯誤' });
        }

        const token = jwt.sign(
            { role: 'admin', ts: Date.now() },
            config.jwt.secret,
            { expiresIn: config.jwt.expiresIn }
        );

        res.json({ token, expiresIn: config.jwt.expiresIn });
    } catch (err) {
        res.status(500).json({ error: '登入失敗', details: err.message });
    }
});

// 驗證 Token
router.get('/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }

    try {
        const token = authHeader.split(' ')[1];
        jwt.verify(token, config.jwt.secret);
        res.json({ valid: true });
    } catch {
        res.status(401).json({ valid: false });
    }
});

module.exports = router;
