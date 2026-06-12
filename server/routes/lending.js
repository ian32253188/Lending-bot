const express = require('express');
const { getBot, startBot, stopBot } = require('../services/engine/manager');
const { getStrategyEngine } = require('../services/engine/strategy');
const rest = require('../services/bitfinex/rest');
const db = require('../services/database');
const logger = require('../utils/logger');

const router = express.Router();

// 1. 取得 / 儲存用戶自訂設定 (SaaS)
router.get('/settings', async (req, res) => {
    try {
        const userId = req.user.id;
        const settings = await db.getUserSettings(userId);
        if (!settings) {
            return res.json(null);
        }
        // 安全處理：遮蔽 API 金鑰與 Secret 避免前台明文洩漏
        if (settings.bitfinex_api_key) {
            settings.bitfinex_api_key = settings.bitfinex_api_key.substring(0, 8) + '...';
        }
        if (settings.bitfinex_api_secret) {
            settings.bitfinex_api_secret = '******';
        }
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/settings', async (req, res) => {
    try {
        const userId = req.user.id;
        const newSettings = req.body;
        
        // 如果使用者沒有輸入新金鑰（傳入遮蔽的值），則保留原本的舊金鑰
        const existingSettings = await db.getUserSettings(userId);
        if (existingSettings) {
            if (newSettings.bitfinex_api_key && newSettings.bitfinex_api_key.includes('...')) {
                newSettings.bitfinex_api_key = existingSettings.bitfinex_api_key;
            }
            if (newSettings.bitfinex_api_secret === '******') {
                newSettings.bitfinex_api_secret = existingSettings.bitfinex_api_secret;
            }
        }

        await db.saveUserSettings(userId, newSettings);

        // 如果該使用者的 Bot 目前正在運行，重啟以套用新設定
        const runningBot = getBot(userId);
        if (runningBot) {
            logger.info('routes', `用戶 ${userId} 設定更新，重啟機器人以套用新設定`);
            await stopBot(userId);
            await startBot(userId);
        }

        res.json({ message: '設定更新成功' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. 啟動/停止/暫停/恢復/緊急停止 引擎
router.post('/engine/:action', async (req, res) => {
    try {
        const userId = req.user.id;
        const { action } = req.params;
        const engine = getBot(userId);

        switch (action) {
            case 'start':
                await startBot(userId);
                res.json({ message: '放貸機器人已啟動' });
                break;
            case 'stop':
                await stopBot(userId);
                res.json({ message: '機器人已停止' });
                break;
            case 'pause':
                if (!engine) return res.status(400).json({ error: '機器人尚未啟動' });
                engine.pause(req.body?.reason || '手動暫停');
                res.json({ message: '放貸已暫停' });
                break;
            case 'resume':
                if (!engine) return res.status(400).json({ error: '機器人尚未啟動' });
                engine.resume();
                res.json({ message: '放貸已恢復' });
                break;
            case 'emergency-stop':
                if (!engine) return res.status(400).json({ error: '機器人尚未啟動' });
                await engine.emergencyStop();
                res.json({ message: '緊急停止已執行，所有掛單已取消' });
                break;
            default:
                res.status(400).json({ error: `未知操作: ${action}` });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 取得策略狀態
router.get('/strategy', (req, res) => {
    const strategy = getStrategyEngine();
    res.json(strategy.getStatus());
});

// 複利模式開關
router.post('/compounding', async (req, res) => {
    try {
        const userId = req.user.id;
        const { enabled } = req.body;
        
        await db.saveUserSettings(userId, { compounding_enabled: !!enabled });
        
        const engine = getBot(userId);
        if (engine) {
            engine.setCompounding(!!enabled);
        }
        res.json({ message: `複利模式已${enabled ? '開啟' : '關閉'}`, compounding: !!enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 自動轉帳設定
router.post('/auto-transfer', async (req, res) => {
    try {
        const userId = req.user.id;
        const { enabled, threshold } = req.body;
        
        await db.saveUserSettings(userId, {
            auto_transfer_enabled: !!enabled,
            auto_transfer_threshold: threshold || 500
        });

        const engine = getBot(userId);
        if (engine) {
            engine.setAutoTransfer(!!enabled, threshold || 500);
        }
        res.json({
            message: `自動轉帳已${enabled ? '開啟' : '關閉'}`,
            autoTransfer: !!enabled,
            threshold: threshold || 500,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 手動提交 Funding Offer
router.post('/offer', async (req, res) => {
    try {
        const userId = req.user.id;
        const { currency, amount, rate, period } = req.body;

        if (!currency || !amount || !rate || !period) {
            return res.status(400).json({ error: '缺少必要參數: currency, amount, rate, period' });
        }

        if (amount < 150) {
            return res.status(400).json({ error: '最低掛單金額為 150' });
        }

        const userSettings = await db.getUserSettings(userId);
        if (!userSettings || !userSettings.bitfinex_api_key || !userSettings.bitfinex_api_secret) {
            return res.status(400).json({ error: '請先在設定中配置交易所 API 金鑰' });
        }
        const credentials = { apiKey: userSettings.bitfinex_api_key, apiSecret: userSettings.bitfinex_api_secret };

        const result = await rest.submitFundingOffer(currency, amount, rate, period, credentials);
        logger.info('lending', `用戶 ${userId} 手動掛單: ${currency} ${amount} @ ${(rate * 100).toFixed(4)}%`);
        res.json({ message: '掛單已提交', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 取消指定 Funding Offer
router.delete('/offer/:offerId', async (req, res) => {
    try {
        const userId = req.user.id;
        const offerId = parseInt(req.params.offerId);

        const userSettings = await db.getUserSettings(userId);
        if (!userSettings || !userSettings.bitfinex_api_key || !userSettings.bitfinex_api_secret) {
            return res.status(400).json({ error: '請先在設定中配置交易所 API 金鑰' });
        }
        const credentials = { apiKey: userSettings.bitfinex_api_key, apiSecret: userSettings.bitfinex_api_secret };

        const result = await rest.cancelFundingOffer(offerId, credentials);
        logger.info('lending', `用戶 ${userId} 手動取消掛單: #${offerId}`);
        res.json({ message: '掛單已取消', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 取消所有掛單
router.delete('/offers/:currency', async (req, res) => {
    try {
        const userId = req.user.id;
        const { currency } = req.params;

        const userSettings = await db.getUserSettings(userId);
        if (!userSettings || !userSettings.bitfinex_api_key || !userSettings.bitfinex_api_secret) {
            return res.status(400).json({ error: '請先在設定中配置交易所 API 金鑰' });
        }
        const credentials = { apiKey: userSettings.bitfinex_api_key, apiSecret: userSettings.bitfinex_api_secret };

        const result = await rest.cancelAllFundingOffers(currency, credentials);
        logger.info('lending', `用戶 ${userId} 手動取消所有 ${currency} 掛單`);
        res.json({ message: `已取消所有 ${currency} 掛單`, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 手動錢包轉帳
router.post('/transfer', async (req, res) => {
    try {
        const userId = req.user.id;
        const { from, to, currency, amount } = req.body;
        if (!from || !to || !currency || !amount) {
            return res.status(400).json({ error: '缺少必要參數: from, to, currency, amount' });
        }

        const userSettings = await db.getUserSettings(userId);
        if (!userSettings || !userSettings.bitfinex_api_key || !userSettings.bitfinex_api_secret) {
            return res.status(400).json({ error: '請先在設定中配置交易所 API 金鑰' });
        }
        const credentials = { apiKey: userSettings.bitfinex_api_key, apiSecret: userSettings.bitfinex_api_secret };

        const result = await rest.transfer(from, to, currency, amount, credentials);
        logger.info('lending', `用戶 ${userId} 手動轉帳: ${amount} ${currency} (${from} → ${to})`);
        db.saveLog('info', 'lending', `手動轉帳 ${amount} ${currency} (${from} → ${to})`, null, userId);
        res.json({ message: '轉帳成功', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
