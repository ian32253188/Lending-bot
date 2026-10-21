const express = require('express');
const { getBot, startBot, stopBot, restartBotPreservingState } = require('../services/engine/manager');
const { getStrategyEngine } = require('../services/engine/strategy');
const rest = require('../services/bitfinex/rest');
const db = require('../services/database');
const logger = require('../utils/logger');
const { DEFAULT_STRATEGY_CONFIG, normalizeStrategyConfig, validateStrategyConfig } = require('../services/strategy-config');
const config = require('../config');
const { normalizeTelegramChatId } = require('../services/telegram-routing');
const { getSharedTelegramBotToken, verifyTelegramChatId } = require('../services/telegram-binding');

const router = express.Router();
const CREDENTIAL_MASKS = Object.freeze({
    bitfinex_api_key: '********...',
    bitfinex_api_secret: '******',
    telegram_bot_token: '**********...',
});

// 1. 取得 / 儲存用戶自訂設定 (SaaS)
router.get('/settings', async (req, res) => {
    try {
        const userId = req.user.id;
        const settings = await db.getUserSettings(userId);
        if (!settings) {
            return res.json(null);
        }
        settings.lending_currencies = ['USD'];
        settings.compounding_enabled = true;
        settings.strategy_config = normalizeStrategyConfig(settings.strategy_config || DEFAULT_STRATEGY_CONFIG);
        delete settings.compounding_hold_amount;
        delete settings.min_offer_amount;
        delete settings.auto_transfer_enabled;
        delete settings.auto_transfer_threshold;
        // 安全處理：遮蔽 API 金鑰與 Secret 避免前台明文洩漏
        if (settings.bitfinex_api_key) {
            settings.bitfinex_api_key = '********...';
        }
        if (settings.bitfinex_api_secret) {
            settings.bitfinex_api_secret = '******';
        }
        if (settings.telegram_bot_token) {
            settings.telegram_bot_token = '**********...';
        }
        res.json(settings);
    } catch (err) {
        if (err?.code === '23505' || err?.constraint === 'user_bot_settings_telegram_chat_id_unique') {
            return res.status(409).json({ error: '此 Telegram Chat ID 已綁定其他使用者' });
        }
        res.status(500).json({ error: err.message });
    }
});

router.post('/settings', async (req, res) => {
    try {
        const userId = req.user.id;
        const newSettings = { ...(req.body || {}) };
        newSettings.lending_currencies = ['USD'];
        newSettings.compounding_enabled = true;
        newSettings.compounding_hold_amount = 0;
        newSettings.auto_transfer_enabled = false;
        delete newSettings.min_offer_amount;
        delete newSettings.auto_transfer_threshold;
        const { encryptImportedCredential } = require('../utils/credential-import');
        
        const existingSettings = await db.getUserSettings(userId);
        const preservedCredentials = new Set();
        for (const [field, mask] of Object.entries(CREDENTIAL_MASKS)) {
            if (newSettings[field] === mask && existingSettings?.[field]) {
                newSettings[field] = existingSettings[field];
                preservedCredentials.add(field);
            }
        }
        if (Object.prototype.hasOwnProperty.call(newSettings, 'strategy_config')) {
            newSettings.strategy_config = normalizeStrategyConfig(newSettings.strategy_config);
        }

        // Telegram is a shared Bot with one exact Chat ID per tenant. Validate
        // before persistence so a typo or duplicate cannot silently route to
        // another account.
        if (Object.prototype.hasOwnProperty.call(newSettings, 'telegram_chat_id')) {
            try {
                newSettings.telegram_chat_id = normalizeTelegramChatId(newSettings.telegram_chat_id);
            } catch (error) {
                return res.status(400).json({ error: error.message });
            }

            if (newSettings.telegram_chat_id) {
                const owner = await db.getUserSettingsByTelegramChatId(newSettings.telegram_chat_id);
                if (owner && owner.user_id !== userId) {
                    return res.status(409).json({ error: '此 Telegram Chat ID 已綁定其他使用者' });
                }

                const botToken = getSharedTelegramBotToken({
                    telegram_bot_token: newSettings.telegram_bot_token || existingSettings?.telegram_bot_token,
                });
                try {
                    await verifyTelegramChatId({ botToken, chatId: newSettings.telegram_chat_id });
                } catch (error) {
                    const status = error.code === 'TELEGRAM_BOT_TOKEN_MISSING' ? 400 : 422;
                    return res.status(status).json({ error: error.message });
                }
            }
        }

        if (config.telegram.botToken && newSettings.telegram_bot_token &&
            !preservedCredentials.has('telegram_bot_token') &&
            newSettings.telegram_bot_token !== config.telegram.botToken) {
            return res.status(400).json({ error: '目前系統使用共用 Telegram Bot，Bot Token 必須與伺服器設定一致' });
        }

        for (const field of Object.keys(CREDENTIAL_MASKS)) {
            if (newSettings[field] && !preservedCredentials.has(field)) {
                newSettings[field] = encryptImportedCredential(newSettings[field]);
            }
        }

        await db.saveUserSettings(userId, newSettings);

        // Register the route even while the lending engine is stopped, so the
        // same shared Bot can still start/control this tenant from Telegram.
        const { initUserTelegram, destroyUserTelegram } = require('../services/telegram');
        if (newSettings.telegram_chat_id) {
            initUserTelegram(
                userId,
                getSharedTelegramBotToken({ telegram_bot_token: newSettings.telegram_bot_token }),
                newSettings.telegram_chat_id,
            );
        } else {
            destroyUserTelegram(userId);
        }

        // 如果該使用者的 Bot 目前正在運行，重啟以套用新設定
        const runningBot = getBot(userId);
        if (runningBot) {
            logger.info('routes', `用戶 ${userId} 設定更新，重啟機器人以套用新設定`);
            await restartBotPreservingState(userId);
        }

        res.json({ message: '設定更新成功' });
    } catch (err) {
        if (err?.code === 'INVALID_USER_SETTINGS') {
            return res.status(400).json({ error: err.message });
        }
        if (err?.code === '23505' || err?.constraint === 'user_bot_settings_telegram_chat_id_unique') {
            return res.status(409).json({ error: '此 Telegram Chat ID 已綁定其他使用者' });
        }
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

// 取得本使用者的 fUSD 策略設定
router.get('/strategy-settings', async (req, res) => {
    try {
        const settings = await db.getUserSettings(req.user.id);
        const strategyConfig = normalizeStrategyConfig(settings?.strategy_config || DEFAULT_STRATEGY_CONFIG);
        const engine = getBot(req.user.id);
        res.json({
            ...strategyConfig,
            running: !!engine?.running,
            rateStrategy: strategyConfig.rateStrategy,
            periodDays: strategyConfig.periodDays,
            useAllAvailable: true,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 儲存本使用者的 fUSD 策略設定；運行中的引擎會重啟套用新設定
router.post('/strategy-settings', async (req, res) => {
    try {
        const userId = req.user.id;
        const existing = await db.getUserSettings(userId);
        const candidateConfig = {
            ...(existing?.strategy_config || {}),
            rateStrategy: req.body?.rateStrategy,
            periodDays: req.body?.periodDays,
            useAllAvailable: true,
        };
        const errors = validateStrategyConfig(candidateConfig);
        if (errors.length) return res.status(400).json({ error: errors.join('; ') });
        const strategyConfig = normalizeStrategyConfig(candidateConfig);

        const wasRunning = !!getBot(userId);
        await db.saveUserSettings(userId, { strategy_config: strategyConfig });
        if (wasRunning) {
            await restartBotPreservingState(userId);
        }
        res.json({
            message: wasRunning ? '策略設定已更新並重新啟動引擎' : '策略設定已更新，下次啟動時套用',
            ...strategyConfig,
            running: !!getBot(userId)?.running,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 複利模式開關
router.post('/compounding', async (req, res) => {
    try {
        const userId = req.user.id;
        const engine = getBot(userId);
        if (engine) {
            await engine.setCompounding(true);
        } else {
            await db.saveUserSettings(userId, {
                compounding_enabled: true,
                compounding_hold_amount: 0,
            });
        }
        res.json({ message: '複利固定開啟', compounding: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 自動轉帳設定
router.post('/auto-transfer', async (req, res) => {
    res.status(410).json({ error: '自動劃轉功能已移除。' });
});

// 手動提交 Funding Offer
router.post('/offer', async (req, res) => {
    try {
        const userId = req.user.id;
        const { currency, amount, rate, period } = req.body;

        if (!currency || amount === undefined || rate === undefined || period === undefined) {
            return res.status(400).json({ error: '缺少必要參數: currency, amount, rate, period' });
        }

        if (currency !== 'USD') {
            return res.status(400).json({ error: '目前僅支援 USD 放貸。' });
        }

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount < 150) {
            return res.status(400).json({ error: '最低掛單金額為 150 且必須為數字' });
        }

        const parsedRate = parseFloat(rate);
        if (isNaN(parsedRate) || parsedRate < 0 || parsedRate > 0.05) {
            return res.status(400).json({ error: '利率必須在 0 到 5% (0.05) 之間且必須為數字' });
        }

        const parsedPeriod = parseInt(period);
        if (isNaN(parsedPeriod) || parsedPeriod < 2 || parsedPeriod > 120) {
            return res.status(400).json({ error: '天數期限必須在 2 到 120 天之間且必須為整數' });
        }

        const userSettings = await db.getUserSettings(userId);
        if (!userSettings || !userSettings.bitfinex_api_key || !userSettings.bitfinex_api_secret) {
            return res.status(400).json({ error: '請先在設定中配置交易所 API 金鑰' });
        }
        
        const { decryptWithFallback } = require('../utils/crypto');
        const credentials = { 
            apiKey: decryptWithFallback(userSettings.bitfinex_api_key), 
            apiSecret: decryptWithFallback(userSettings.bitfinex_api_secret) 
        };

        const result = await rest.submitFundingOffer(currency, parsedAmount, parsedRate, parsedPeriod, credentials);
        logger.info('lending', `用戶 ${userId} 手動掛單: ${currency} ${parsedAmount} @ ${(parsedRate * 100).toFixed(4)}%`);
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
        if (isNaN(offerId)) {
            return res.status(400).json({ error: '無效的掛單 ID' });
        }

        const userSettings = await db.getUserSettings(userId);
        if (!userSettings || !userSettings.bitfinex_api_key || !userSettings.bitfinex_api_secret) {
            return res.status(400).json({ error: '請先在設定中配置交易所 API 金鑰' });
        }
        
        const { decryptWithFallback } = require('../utils/crypto');
        const credentials = { 
            apiKey: decryptWithFallback(userSettings.bitfinex_api_key), 
            apiSecret: decryptWithFallback(userSettings.bitfinex_api_secret) 
        };

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

        if (currency !== 'USD') {
            return res.status(400).json({ error: '目前僅支援 USD 放貸。' });
        }

        const userSettings = await db.getUserSettings(userId);
        if (!userSettings || !userSettings.bitfinex_api_key || !userSettings.bitfinex_api_secret) {
            return res.status(400).json({ error: '請先在設定中配置交易所 API 金鑰' });
        }
        
        const { decryptWithFallback } = require('../utils/crypto');
        const credentials = { 
            apiKey: decryptWithFallback(userSettings.bitfinex_api_key), 
            apiSecret: decryptWithFallback(userSettings.bitfinex_api_secret) 
        };

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
        if (!from || !to || !currency || amount === undefined) {
            return res.status(400).json({ error: '缺少必要參數: from, to, currency, amount' });
        }

        const allowedWallets = ['exchange', 'margin', 'funding'];
        if (!allowedWallets.includes(from) || !allowedWallets.includes(to)) {
            return res.status(400).json({ error: '無效的錢包類型，僅限 exchange, margin 或 funding' });
        }
        if (from === to) {
            return res.status(400).json({ error: '來源錢包與目標錢包不能相同' });
        }

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({ error: '金額必須為大於 0 的數字' });
        }

        if (currency !== 'USD') {
            return res.status(400).json({ error: '目前僅支援 USD 轉帳。' });
        }

        const userSettings = await db.getUserSettings(userId);
        if (!userSettings || !userSettings.bitfinex_api_key || !userSettings.bitfinex_api_secret) {
            return res.status(400).json({ error: '請先在設定中配置交易所 API 金鑰' });
        }
        
        const { decryptWithFallback } = require('../utils/crypto');
        const credentials = { 
            apiKey: decryptWithFallback(userSettings.bitfinex_api_key), 
            apiSecret: decryptWithFallback(userSettings.bitfinex_api_secret) 
        };

        const result = await rest.transfer(from, to, currency, parsedAmount, credentials);
        logger.info('lending', `用戶 ${userId} 手動轉帳: ${parsedAmount} ${currency} (${from} → ${to})`);
        res.json({ message: '轉帳成功', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
