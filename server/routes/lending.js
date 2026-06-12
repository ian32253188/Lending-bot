const express = require('express');
const { getLendingEngine } = require('../services/engine/lending');
const { getStrategyEngine } = require('../services/engine/strategy');
const rest = require('../services/bitfinex/rest');
const db = require('../services/database');
const logger = require('../utils/logger');

const router = express.Router();

// 啟動/停止/暫停/恢復/緊急停止 引擎
router.post('/engine/:action', async (req, res) => {
    try {
        const engine = getLendingEngine();
        const { action } = req.params;

        switch (action) {
            case 'start':
                engine.monitorOnly = false;
                await engine.start();
                res.json({ message: '放貸引擎已啟動（放貸模式）' });
                break;
            case 'monitor-start':
                await engine.startMonitorOnly();
                res.json({ message: '引擎已啟動（純監控模式 — 只記錄不掛單）' });
                break;
            case 'stop':
                await engine.stop();
                engine.monitorOnly = false;
                res.json({ message: '引擎已停止' });
                break;
            case 'pause':
                engine.pause(req.body?.reason || '手動暫停');
                res.json({ message: '放貸已暫停' });
                break;
            case 'resume':
                engine.resume();
                res.json({ message: '放貸已恢復' });
                break;
            case 'emergency-stop':
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

// 切換策略模式
router.post('/strategy/:mode', (req, res) => {
    try {
        const strategy = getStrategyEngine();
        const { mode } = req.params;
        strategy.setMode(mode);
        res.json({ message: `策略已切換為: ${mode}`, status: strategy.getStatus() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 取得策略狀態
router.get('/strategy', (req, res) => {
    const strategy = getStrategyEngine();
    res.json(strategy.getStatus());
});

// Phase 2: 複利模式開關
router.post('/compounding', (req, res) => {
    try {
        const engine = getLendingEngine();
        const { enabled } = req.body;
        engine.setCompounding(!!enabled);
        res.json({ message: `複利模式已${enabled ? '開啟' : '關閉'}`, compounding: !!enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phase 2: 自動轉帳設定
router.post('/auto-transfer', (req, res) => {
    try {
        const engine = getLendingEngine();
        const { enabled, threshold } = req.body;
        engine.setAutoTransfer(!!enabled, threshold || 500);
        res.json({
            message: `自動轉帳已${enabled ? '開啟' : '關閉'}`,
            autoTransfer: !!enabled,
            threshold: threshold || 500,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phase 2: 幣種輪動建議
router.get('/suggestions', (req, res) => {
    try {
        const engine = getLendingEngine();
        const suggestion = engine.getCurrencySuggestion();
        res.json(suggestion);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 手動提交 Funding Offer
router.post('/offer', async (req, res) => {
    try {
        const { currency, amount, rate, period } = req.body;

        if (!currency || !amount || !rate || !period) {
            return res.status(400).json({ error: '缺少必要參數: currency, amount, rate, period' });
        }

        if (amount < 150) {
            return res.status(400).json({ error: '最低掛單金額為 150' });
        }

        const result = await rest.submitFundingOffer(currency, amount, rate, period);
        logger.info('lending', `手動掛單: ${currency} ${amount} @ ${(rate * 100).toFixed(4)}%`);
        res.json({ message: '掛單已提交', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 取消指定 Funding Offer
router.delete('/offer/:offerId', async (req, res) => {
    try {
        const offerId = parseInt(req.params.offerId);
        const result = await rest.cancelFundingOffer(offerId);
        logger.info('lending', `手動取消掛單: #${offerId}`);
        res.json({ message: '掛單已取消', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 取消所有掛單
router.delete('/offers/:currency', async (req, res) => {
    try {
        const { currency } = req.params;
        const result = await rest.cancelAllFundingOffers(currency);
        logger.info('lending', `手動取消所有 ${currency} 掛單`);
        res.json({ message: `已取消所有 ${currency} 掛單`, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 手動錢包轉帳
router.post('/transfer', async (req, res) => {
    try {
        const { from, to, currency, amount } = req.body;
        if (!from || !to || !currency || !amount) {
            return res.status(400).json({ error: '缺少必要參數: from, to, currency, amount' });
        }
        const result = await rest.transfer(from, to, currency, amount);
        logger.info('lending', `手動轉帳: ${amount} ${currency} (${from} → ${to})`);
        db.saveLog('info', 'lending', `手動轉帳 ${amount} ${currency} (${from} → ${to})`);
        res.json({ message: '轉帳成功', result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 更新設定
router.put('/settings/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;
        await db.saveSetting(key, value);
        res.json({ message: `設定 ${key} 已更新` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 取得設定
router.get('/settings/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const value = await db.getSetting(key);
        res.json({ key, value });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
