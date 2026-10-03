const express = require('express');
const { getBot } = require('../services/engine/manager');
const db = require('../services/database');
const { getCachedFundingMarketSummary } = require('../services/market-summary');
const { getInactiveDashboardStatusForUser } = require('../services/dashboard-status');

const router = express.Router();

// 取得儀表板總覽
router.get('/overview', async (req, res) => {
    try {
        const userId = req.user.id;
        const engine = getBot(userId);
        if (!engine) {
            return res.json(await getInactiveDashboardStatusForUser(userId));
        }
        res.json(engine.getStatus());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 取得詳細狀態（含掛單和貸款明細）
router.get('/detailed', async (req, res) => {
    try {
        const userId = req.user.id;
        const engine = getBot(userId);
        if (!engine) {
            return res.json(await getInactiveDashboardStatusForUser(userId, { detailed: true }));
        }
        res.json(engine.getDetailedStatus());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// fUSD 公開融資市場儀錶板（公開市場資料，不包含其他用戶私有資料）
router.get('/funding-market', async (req, res) => {
    try {
        const { getBitfinexPublicWS } = require('../services/bitfinex/ws');
        const summary = await getCachedFundingMarketSummary({
            publicWs: getBitfinexPublicWS(),
            db,
        });
        res.json(summary);
    } catch (err) {
        res.status(502).json({ error: `無法取得 fUSD 市場資料: ${err.message}` });
    }
});

// 取得利率歷史（FRR 走勢圖資料 - 全域共享）
router.get('/rate-history/:currency', async (req, res) => {
    try {
        const { currency } = req.params;
        const hours = parseInt(req.query.hours) || 24;
        const data = await db.getRateHistory(currency, hours, 'recorded_at,frr');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 收益統計（日/週/月/年化）
router.get('/earnings/stats', async (req, res) => {
    try {
        const userId = req.user.id;
        
        // 自動同步最新利息收益 (有 10 分鐘冷卻保護)
        const { syncUserEarnings } = require('../services/engine/sync');
        await syncUserEarnings(userId);
        
        // 為了防範伺服器時區差異，採用亞洲/台北時區 (UTC+8) 作為結算基準
        const taipeiOffset = 8 * 60 * 60 * 1000;
        const nowTaipei = new Date(Date.now() + taipeiOffset);

        // 今日起始
        const todayStart = new Date(Date.UTC(nowTaipei.getUTCFullYear(), nowTaipei.getUTCMonth(), nowTaipei.getUTCDate()));
        todayStart.setTime(todayStart.getTime() - taipeiOffset);

        // 本週起始（週一）
        const weekStart = new Date(Date.UTC(nowTaipei.getUTCFullYear(), nowTaipei.getUTCMonth(), nowTaipei.getUTCDate()));
        const day = nowTaipei.getUTCDay();
        const diff = nowTaipei.getUTCDate() - day + (day === 0 ? -6 : 1);
        weekStart.setUTCDate(diff);
        weekStart.setTime(weekStart.getTime() - taipeiOffset);

        // 本月起始
        const monthStart = new Date(Date.UTC(nowTaipei.getUTCFullYear(), nowTaipei.getUTCMonth(), 1));
        monthStart.setTime(monthStart.getTime() - taipeiOffset);

        // 今年起始
        const yearStart = new Date(Date.UTC(nowTaipei.getUTCFullYear(), 0, 1));
        yearStart.setTime(yearStart.getTime() - taipeiOffset);

        const [today, week, month, year, all] = await Promise.all([
            db.getEarnings(null, todayStart.toISOString(), null, userId),
            db.getEarnings(null, weekStart.toISOString(), null, userId),
            db.getEarnings(null, monthStart.toISOString(), null, userId),
            db.getEarnings(null, yearStart.toISOString(), null, userId),
            db.getEarnings(null, null, null, userId),
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
            // 資金利用率
            utilization: (() => {
                try {
                    const engine = getBot(userId);
                    if (!engine) return {};
                    const util = {};
                    for (const [cur, wallet] of Object.entries(engine.state.wallets)) {
                        const total = wallet.balance || 0;
                        const activeCredits = engine.state.activeCredits?.[cur] || [];
                        const activeAmount = activeCredits.reduce((sum, c) => sum + Math.abs(c.amount || 0), 0);
                        util[cur] = total > 0 ? Math.min(1, activeAmount / total) : 0;
                    }
                    return util;
                } catch { return {}; }
            })(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 收益原始紀錄
router.get('/earnings', async (req, res) => {
    try {
        const userId = req.user.id;
        
        // 自動同步最新利息收益 (有 10 分鐘冷卻保護)
        const { syncUserEarnings } = require('../services/engine/sync');
        await syncUserEarnings(userId);
        const { currency, from, to } = req.query;
        const data = await db.getEarnings(currency || null, from || null, to || null, userId);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 清除收益紀錄
router.post('/earnings/reset', async (req, res) => {
    try {
        const userId = req.user.id;
        const { currency } = req.body;
        const success = await db.deleteEarnings(currency || null, userId);
        if (success) {
            const engine = getBot(userId);
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

// 熱力圖數據
router.get('/earnings/heatmap', async (req, res) => {
    try {
        const userId = req.user.id;
        const days = parseInt(req.query.days) || 365;
        const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const rows = await db.getEarnings(null, fromDate, null, userId);

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

// 歷史掛單紀錄
router.get('/history/offers', async (req, res) => {
    try {
        const userId = req.user.id;
        const { currency } = req.query;
        const data = await db.getActiveOffers(currency || null, userId);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 歷史貸款紀錄
router.get('/history/loans', async (req, res) => {
    try {
        const userId = req.user.id;
        const { currency } = req.query;
        const data = await db.getActiveLoans(currency || null, userId);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 操作日誌
router.get('/logs', async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 100;
        const category = req.query.category || null;
        const level = req.query.level || null;
        const keyword = req.query.keyword || null;

        let logs = await db.getLogs(limit * 3, category, userId);

        if (level) {
            logs = logs.filter(l => l.level === level);
        }

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

// 取得幣種輪動建議
router.get('/suggestions', async (req, res) => {
    try {
        const { getBitfinexPublicWS } = require('../services/bitfinex/ws');
        const publicWs = getBitfinexPublicWS();
        const usdData = publicWs.getMarketData('USD');
        const usdtData = publicWs.getMarketData('USDT');

        const usdRate = usdData?.frr || 0.00038;  // fallback 0.038%
        const usdtRate = usdtData?.frr || 0.00024; // fallback 0.024%

        const suggestions = [];
        const diff = usdRate - usdtRate;
        if (Math.abs(diff) > 0.00005) { // 利率相差超過萬分之 0.5 (0.005%)
            const better = diff > 0 ? 'USD' : 'USDT';
            const worse = diff > 0 ? 'USDT' : 'USD';
            const diffPct = (Math.abs(diff) * 100).toFixed(4);
            suggestions.push({
                reason: `💡 當前 ${better} 利率比 ${worse} 高出約 ${diffPct}%/天，建議增加 ${better} 的放貸權重以獲得更高年化收益。`
            });
        }

        res.json({
            rates: {
                USD: usdRate,
                USDT: usdtRate
            },
            suggestions
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
