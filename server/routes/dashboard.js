const express = require('express');
const { getLendingEngine } = require('../services/engine/lending');
const { getBitfinexWS } = require('../services/bitfinex/ws');
const db = require('../services/database');
const config = require('../config');

const router = express.Router();

// 取得儀表板總覽
router.get('/overview', async (req, res) => {
    try {
        const engine = getLendingEngine();
        const status = engine.getStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 取得詳細狀態（含掛單和貸款明細）
router.get('/detailed', async (req, res) => {
    try {
        const engine = getLendingEngine();
        const detailed = engine.getDetailedStatus();
        res.json(detailed);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 取得利率歷史（FRR 走勢圖資料）
router.get('/rate-history/:currency', async (req, res) => {
    try {
        const { currency } = req.params;
        const hours = parseInt(req.query.hours) || 24;
        const data = await db.getRateHistory(currency, hours);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phase 3: 收益統計（日/週/月/年化）
router.get('/earnings/stats', async (req, res) => {
    try {
        const now = new Date();

        // 今日起始
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);

        // 本週起始（週一）
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay() + 1);
        weekStart.setHours(0, 0, 0, 0);

        // 本月起始
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        // 今年起始
        const yearStart = new Date(now.getFullYear(), 0, 1);

        const [today, week, month, year, all] = await Promise.all([
            db.getEarnings(null, todayStart.toISOString(), null),
            db.getEarnings(null, weekStart.toISOString(), null),
            db.getEarnings(null, monthStart.toISOString(), null),
            db.getEarnings(null, yearStart.toISOString(), null),
            db.getEarnings(null, null, null),
        ]);

        function sumByCurrency(rows) {
            const result = {};
            for (const row of rows) {
                result[row.currency] = (result[row.currency] || 0) + (row.amount || 0);
            }
            return result;
        }

        function totalSum(rows) {
            return rows.reduce((s, r) => s + (r.amount || 0), 0);
        }

        res.json({
            today: { byCurrency: sumByCurrency(today), total: totalSum(today) },
            week: { byCurrency: sumByCurrency(week), total: totalSum(week) },
            month: { byCurrency: sumByCurrency(month), total: totalSum(month) },
            year: { byCurrency: sumByCurrency(year), total: totalSum(year) },
            allTime: { byCurrency: sumByCurrency(all), total: totalSum(all) },
            // 資金利用率（from engine）
            utilization: (() => {
                try {
                    const engine = getLendingEngine();
                    const status = engine.getStatus();
                    const util = {};
                    for (const [cur, wallet] of Object.entries(status.wallets)) {
                        const total = wallet.balance || 0;
                        const activeCredits = status.activeCredits?.[cur] || 0;
                        util[cur] = total > 0 ? Math.min(1, activeCredits / total) : 0;
                    }
                    return util;
                } catch { return {}; }
            })(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phase 3: 收益原始紀錄（含分頁）
router.get('/earnings', async (req, res) => {
    try {
        const { currency, from, to } = req.query;
        const data = await db.getEarnings(currency || null, from || null, to || null);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 新增：清除所有收益紀錄
router.post('/earnings/reset', async (req, res) => {
    try {
        const { currency } = req.body;
        const success = await db.deleteEarnings(currency || null);
        if (success) {

            // 重置暫存的 totalEarned
            const engine = getLendingEngine();
            if (engine && engine.state && engine.state.stats && engine.state.stats.totalEarned) {
                if (currency) {
                    engine.state.stats.totalEarned[currency] = 0;
                } else {
                    for (const cur of Object.keys(engine.state.stats.totalEarned)) {
                        engine.state.stats.totalEarned[cur] = 0;
                    }
                }
            }

            res.json({ message: '收益紀錄已清除' });
        } else {
            res.status(500).json({ error: '清除失敗' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phase 3: 熱力圖數據（每日收益彙總）
router.get('/earnings/heatmap', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 365;
        const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const rows = await db.getEarnings(null, fromDate, null);

        // 按日期彙總
        const byDate = {};
        for (const row of rows) {
            const date = row.earned_at?.slice(0, 10) || new Date().toISOString().slice(0, 10);
            byDate[date] = (byDate[date] || 0) + (row.amount || 0);
        }

        const result = Object.entries(byDate)
            .map(([date, amount]) => ({ date, amount }))
            .sort((a, b) => a.date.localeCompare(b.date));

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phase 3: 歷史掛單紀錄
router.get('/history/offers', async (req, res) => {
    try {
        const { currency } = req.query;
        const data = await db.getActiveOffers(currency || null);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phase 3: 歷史貸款紀錄
router.get('/history/loans', async (req, res) => {
    try {
        const { currency } = req.query;
        const data = await db.getActiveLoans(currency || null);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phase 4: 操作日誌（加強版：支援 level 篩選、關鍵字搜尋）
router.get('/logs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const category = req.query.category || null;
        const level = req.query.level || null;
        const keyword = req.query.keyword || null;

        let logs = await db.getLogs(limit * 3, category); // 多取以便篩選

        // 等級篩選
        if (level) {
            logs = logs.filter(l => l.level === level);
        }

        // 關鍵字篩選
        if (keyword) {
            const kw = keyword.toLowerCase();
            logs = logs.filter(l =>
                l.message?.toLowerCase().includes(kw) ||
                l.category?.toLowerCase().includes(kw)
            );
        }

        res.json(logs.slice(0, limit));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phase 2: 幣種輪動建議（也放在 dashboard 方便前端統一呼叫）
router.get('/suggestions', (req, res) => {
    try {
        const engine = getLendingEngine();
        res.json(engine.getCurrencySuggestion());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
