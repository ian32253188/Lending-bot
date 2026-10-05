const express = require('express');
const { getBot } = require('../services/engine/manager');
const db = require('../services/database');
const { getCachedFundingMarketSummary } = require('../services/market-summary');
const { getInactiveDashboardStatusForUser } = require('../services/dashboard-status');

const router = express.Router();

function normalizeEarningAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
}

function normalizeEarningDate(value) {
    if (value === null || value === undefined || value === '') {
        return new Date().toISOString().slice(0, 10);
    }
    if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
        return null;
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

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
        if (currency !== 'USD') {
            return res.status(400).json({ error: '僅提供 USD FRR 歷史資料。' });
        }
        const data = typeof db.getDailyFRRHistory === 'function'
            ? await db.getDailyFRRHistory('USD', 30 * 24)
            : await db.getRateHistory('USD', 30 * 24, 'recorded_at,frr');
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
            db.getEarnings('USD', todayStart.toISOString(), null, userId),
            db.getEarnings('USD', weekStart.toISOString(), null, userId),
            db.getEarnings('USD', monthStart.toISOString(), null, userId),
            db.getEarnings('USD', yearStart.toISOString(), null, userId),
            db.getEarnings('USD', null, null, userId),
        ]);

        const engine = getBot(userId);
        let utilization = null;
        let utilizationDataAvailable = false;
        let utilizationDataSource = null;
        let utilizationError = null;
        const engineAccountDataComplete = engine?.state?.accountDataComplete
            ?? Boolean(engine?.state?.wallets && engine?.state?.activeCredits);
        if (engineAccountDataComplete && engine?.state?.wallets && engine?.state?.activeCredits) {
            utilization = {};
            for (const [currency, wallet] of Object.entries(engine.state.wallets)) {
                const balance = Number(wallet?.balance);
                const activeAmount = (engine.state.activeCredits[currency] || [])
                    .reduce((sum, credit) => sum + Math.abs(Number(credit.amount) || 0), 0);
                utilization[currency] = Number.isFinite(balance) && balance > 0
                    ? Math.min(1, activeAmount / balance)
                    : 0;
            }
            utilizationDataAvailable = true;
            utilizationDataSource = 'Bitfinex 私有 WebSocket（運行中引擎）';
        } else {
            const { getReadOnlyAccountSnapshot } = require('../services/private-account-status');
            const account = await getReadOnlyAccountSnapshot(userId);
            if (account.accountDataAvailable) {
                utilization = {};
                for (const [currency, wallet] of Object.entries(account.wallets || {})) {
                    const balance = Number(wallet?.balance);
                    const activeAmount = (account.activeCredits?.[currency] || [])
                        .reduce((sum, credit) => sum + Math.abs(Number(credit.amount) || 0), 0);
                    utilization[currency] = Number.isFinite(balance) && balance > 0
                        ? Math.min(1, activeAmount / balance)
                        : 0;
                }
                utilizationDataAvailable = true;
                utilizationDataSource = account.accountDataSource;
            } else {
                utilizationError = account.accountDataError || 'Bitfinex 個人帳戶資料不可用。';
            }
        }

        function sumByCurrency(rows) {
            const result = {};
            for (const row of rows) {
                result[row.currency] = (result[row.currency] || 0) + normalizeEarningAmount(row.amount);
            }
            return result;
        }

        function totalSum(rows) {
            return rows.reduce((sum, row) => sum + normalizeEarningAmount(row.amount), 0);
        }

        res.json({
            today: { byCurrency: sumByCurrency(today), total: totalSum(today) },
            week: { byCurrency: sumByCurrency(week), total: totalSum(week) },
            month: { byCurrency: sumByCurrency(month), total: totalSum(month) },
            year: { byCurrency: sumByCurrency(year), total: totalSum(year) },
            allTime: { byCurrency: sumByCurrency(all), total: totalSum(all) },
            dataSource: `${db.isPostgresConfigured() ? 'Oracle PostgreSQL' : 'Supabase'} 已存收益紀錄（可用時同步 Bitfinex Ledger）`,
            utilization,
            utilizationDataAvailable,
            utilizationDataSource,
            utilizationError,
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
        if (currency && currency !== 'USD') {
            return res.status(400).json({ error: '僅提供 USD 收益紀錄。' });
        }
        const data = await db.getEarnings('USD', from || null, to || null, userId);
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
        if (currency && currency !== 'USD') {
            return res.status(400).json({ error: '僅提供 USD 收益紀錄。' });
        }
        const success = await db.deleteEarnings('USD', userId);
        if (success) {
            const engine = getBot(userId);
            if (engine && engine.state && engine.state.stats && engine.state.stats.totalEarned) {
                engine.state.stats.totalEarned.USD = 0;
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
        const rows = await db.getEarnings('USD', fromDate, null, userId);

        const byDate = {};
        for (const row of rows) {
            const date = normalizeEarningDate(row.earned_at);
            if (!date) continue;
            byDate[date] = (byDate[date] || 0) + normalizeEarningAmount(row.amount);
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
        if (req.query.currency && req.query.currency !== 'USD') {
            return res.status(400).json({ error: '僅提供 USD 掛單紀錄。' });
        }
        res.setHeader('X-Data-Source', db.isPostgresConfigured() ? 'Oracle PostgreSQL' : 'Supabase');
        res.setHeader('X-Record-Scope', 'Bot-tracked active offers');
        const data = await db.getActiveOffers('USD', userId);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 歷史貸款紀錄
router.get('/history/loans', async (req, res) => {
    try {
        const userId = req.user.id;
        if (req.query.currency && req.query.currency !== 'USD') {
            return res.status(400).json({ error: '僅提供 USD 放貸紀錄。' });
        }
        res.setHeader('X-Data-Source', db.isPostgresConfigured() ? 'Oracle PostgreSQL' : 'Supabase');
        res.setHeader('X-Record-Scope', 'Bot-tracked active loans');
        const data = await db.getActiveLoans('USD', userId);
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

module.exports = router;
