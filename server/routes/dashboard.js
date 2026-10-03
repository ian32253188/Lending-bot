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

        const engine = getBot(userId);
        let utilization = null;
        let utilizationDataAvailable = false;
        let utilizationDataSource = null;
        let utilizationError = null;
        if (engine?.state?.wallets && engine?.state?.activeCredits) {
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
        res.setHeader('X-Data-Source', db.isPostgresConfigured() ? 'Oracle PostgreSQL' : 'Supabase');
        res.setHeader('X-Record-Scope', 'Bot-tracked active offers');
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
        res.setHeader('X-Data-Source', db.isPostgresConfigured() ? 'Oracle PostgreSQL' : 'Supabase');
        res.setHeader('X-Record-Scope', 'Bot-tracked active loans');
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
        const { getBitfinexPublicWS, isPublicTickerFresh } = require('../services/bitfinex/ws');
        const publicWs = getBitfinexPublicWS();
        const usdData = publicWs.getMarketData('USD');
        const usdtData = publicWs.getMarketData('USDT');
        const usdRate = isPublicTickerFresh(usdData) ? Number(usdData.frr) : null;
        const usdtRate = isPublicTickerFresh(usdtData) ? Number(usdtData.frr) : null;
        const available = usdRate !== null && usdtRate !== null;
        const updatedAt = available
            ? new Date(Math.min(usdData.tickerLastUpdate, usdtData.tickerLastUpdate)).toISOString()
            : null;

        const suggestions = [];
        if (available) {
            const diff = usdRate - usdtRate;
            if (Math.abs(diff) > 0.00005) { // 利率相差超過萬分之 0.5 (0.005%)
                const better = diff > 0 ? 'USD' : 'USDT';
                const worse = diff > 0 ? 'USDT' : 'USD';
                const diffPct = (Math.abs(diff) * 100).toFixed(4);
                suggestions.push({
                    reason: `💡 當前 ${better} FRR 比 ${worse} 高出約 ${diffPct}%/天；這是公開市場參考值，不代表實際成交收益。`
                });
            }
        }

        res.json({
            available,
            source: 'Bitfinex 公開 Funding Ticker（FRR）',
            updatedAt,
            error: available ? null : 'USD 或 USDT 的公開行情尚未更新或已超過 5 分鐘，暫不能比較。',
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
