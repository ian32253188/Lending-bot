const rest = require('./bitfinex/rest');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CACHE_MS = 60 * 1000;
const HISTORY_CACHE_MS = 60 * 60 * 1000; // 1 小時快取
const PUBLIC_FUNDING_TRADES_LIMIT = 10000;
const FUNDING_TRADES_REQUEST_INTERVAL_MS = 4100;
const FUNDING_TRADES_COLLECT_INTERVAL_MS = 60 * 1000;
const FUNDING_TRADES_STALE_AFTER_MS = 5 * 60 * 1000;
let cachedSummary = null;
let cachedAt = 0;
let cachePromise = null;
let cachedHistory = null;
let cachedHistoryAt = 0;
let cachedHistoryDb = null;
let historyPromise = null;
let fundingTradeCollectorTimer = null;
let fundingTradeCollectorPromise = null;
let fundingTradeBackfillPromise = null;
let fundingTradeBackfillStatus = {
    state: 'idle',
    fetched: 0,
    stored: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
};

function getCachedRateHistory(db, now = Date.now()) {
    if (!db?.getRateHistory) return Promise.resolve([]);

    if (
        cachedHistory !== null &&
        cachedHistoryDb === db &&
        now - cachedHistoryAt < HISTORY_CACHE_MS
    ) {
        return Promise.resolve(cachedHistory);
    }

    if (historyPromise) return historyPromise;

    historyPromise = Promise.resolve()
        .then(() => db.getRateHistory('USD', 7 * 24, 'recorded_at,avg_rate,high_rate,low_rate'))
        .then(history => {
            cachedHistory = Array.isArray(history) ? history : [];
            cachedHistoryAt = now;
            cachedHistoryDb = db;
            return cachedHistory;
        })
        .catch(error => {
            // 若短暫讀取失敗，沿用上一份歷史資料，避免每個請求反覆打滿資料庫。
            if (cachedHistory !== null) return cachedHistory;
            throw error;
        })
        .finally(() => {
            historyPromise = null;
        });

    return historyPromise;
}

function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function annualizedPercent(rate) {
    const value = numberOrNull(rate);
    return value === null ? null : value * 365 * 100;
}

function parsePublicFundingTrade(row) {
    if (!Array.isArray(row) || row.length < 5) return null;
    const timestamp = numberOrNull(row[1]);
    const amount = numberOrNull(row[2]);
    const rate = numberOrNull(row[3]);
    const period = numberOrNull(row[4]);
    if (timestamp === null || amount === null || rate === null || period === null) return null;
    return { id: row[0], timestamp, amount: Math.abs(amount), rate, period };
}

function parseFundingTrade(row) {
    if (Array.isArray(row)) return parsePublicFundingTrade(row);
    if (!row || typeof row !== 'object') return null;
    const id = numberOrNull(row.id ?? row.trade_id);
    const timestamp = numberOrNull(row.timestamp ?? row.executed_at);
    const amount = numberOrNull(row.amount);
    const rate = numberOrNull(row.rate);
    const period = numberOrNull(row.period);
    if (id === null || timestamp === null || amount === null || rate === null || period === null) return null;
    return { id, timestamp, amount: Math.abs(amount), rate, period };
}

function dedupePublicFundingTrades(rows) {
    const uniqueRows = new Map();
    for (const row of rows) {
        if (!Array.isArray(row) || row.length < 5) continue;
        const key = row[0] !== null && row[0] !== undefined
            ? `id:${row[0]}`
            : `trade:${row[1]}:${row[2]}:${row[3]}:${row[4]}`;
        if (!uniqueRows.has(key)) uniqueRows.set(key, row);
    }
    return [...uniqueRows.values()];
}

async function requestFundingTrades(restClient, start, end, requestState) {
    if (requestState.requestCount > 0) {
        const delay = FUNDING_TRADES_REQUEST_INTERVAL_MS - (Date.now() - requestState.lastRequestAt);
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
    requestState.requestCount += 1;
    requestState.lastRequestAt = Date.now();
    return restClient.getFundingTrades('USD', {
        start,
        end,
        limit: PUBLIC_FUNDING_TRADES_LIMIT,
        sort: -1,
    });
}

async function fetchFundingTradesRange(restClient, start, end, requestState = { requestCount: 0, lastRequestAt: 0 }) {
    const rows = await requestFundingTrades(restClient, start, end, requestState);
    if (!Array.isArray(rows)) return [];

    // A full response may be capped at 10,000 rows, so split the time range
    // until every returned slice is known to fit below the endpoint limit.
    if (rows.length < PUBLIC_FUNDING_TRADES_LIMIT) return rows;
    if (start >= end) {
        throw new Error(`Bitfinex returned ${PUBLIC_FUNDING_TRADES_LIMIT} funding trades for a 1 ms range; the range cannot be split further.`);
    }

    const midpoint = Math.floor(start + (end - start) / 2);
    if (midpoint < start || midpoint >= end) {
        throw new Error('Unable to split a capped Bitfinex funding trade range further.');
    }

    // Bitfinex start/end bounds are inclusive. Split at integer millisecond
    // boundaries so the two requests cover the full range without a gap.
    const olderRows = await fetchFundingTradesRange(restClient, start, midpoint, requestState);
    const newerRows = await fetchFundingTradesRange(restClient, midpoint + 1, end, requestState);
    return dedupePublicFundingTrades([...olderRows, ...newerRows]);
}

// 儀表板需要先快速顯示最近成交；若切割完整 24 小時範圍，當市場成交量
// 超過 Bitfinex 單次 10,000 筆上限時，會觸發多次限流等待，反而讓請求逾時。
// 先取最新一頁即可恢復最近數小時的資料，之後由背景 collector 增量補齊。
async function fetchRecentFundingTrades(restClient) {
    const rows = await restClient.getFundingTrades('USD', {
        limit: PUBLIC_FUNDING_TRADES_LIMIT,
        sort: -1,
    });
    return Array.isArray(rows) ? rows : [];
}

/**
 * 將 Bitfinex 公開撮合資料增量寫入 OCI VM 的 PostgreSQL。
 * 首次執行補齊近 24 小時，之後只抓取最後一筆之後的新成交。
 */
async function refreshFundingTrades({ db, restClient = rest, now = Date.now() } = {}) {
    if (!db?.upsertFundingTrades || !db?.getLatestFundingTradeTimestamp) {
        return { fetched: 0, stored: 0, skipped: true };
    }

    const latestTimestamp = await db.getLatestFundingTradeTimestamp('USD');
    const start = latestTimestamp === null
        ? now - DAY_MS
        : Math.max(latestTimestamp + 1, now - DAY_MS);
    if (start > now) return { fetched: 0, stored: 0, skipped: false };

    const rows = latestTimestamp === null
        ? await fetchRecentFundingTrades(restClient)
        : await fetchFundingTradesRange(restClient, start, now);
    const trades = rows.map(parseFundingTrade).filter(Boolean);
    const stored = await db.upsertFundingTrades(trades, 'USD');
    return { fetched: trades.length, stored, skipped: false };
}

/**
 * 背景補齊近 24 小時較早的成交。Bitfinex 單次最多 10,000 筆，按小時分段
 * 可避免在 API 請求內等待整段歷史資料，也讓高成交量市場能逐步落地到 Oracle。
 */
async function backfillFundingTrades({ db, restClient = rest, now = Date.now() } = {}) {
    if (!db?.upsertFundingTrades) {
        return { fetched: 0, stored: 0, skipped: true };
    }

    const targetStart = now - DAY_MS;
    let oldestTimestamp = db.getOldestFundingTradeTimestamp
        ? await db.getOldestFundingTradeTimestamp('USD')
        : null;
    if (!Number.isFinite(Number(oldestTimestamp)) && db.getFundingTrades) {
        const stored = await db.getFundingTrades('USD', new Date(targetStart), new Date(now));
        oldestTimestamp = stored.reduce((oldest, trade) => {
            const timestamp = Number(trade?.timestamp ?? trade?.executed_at);
            return Number.isFinite(timestamp) ? Math.min(oldest, timestamp) : oldest;
        }, Infinity);
        if (!Number.isFinite(oldestTimestamp)) oldestTimestamp = null;
    }
    let end = Number.isFinite(Number(oldestTimestamp))
        ? Math.min(Number(oldestTimestamp) - 1, now)
        : now;
    if (end <= targetStart) return { fetched: 0, stored: 0, skipped: false };

    const requestState = { requestCount: 0, lastRequestAt: 0 };
    let fetched = 0;
    let stored = 0;
    while (end > targetStart) {
        const start = Math.max(targetStart, end - HOUR_MS + 1);
        const rows = await fetchFundingTradesRange(restClient, start, end, requestState);
        const trades = rows.map(parseFundingTrade).filter(Boolean);
        if (trades.length) {
            stored += await db.upsertFundingTrades(trades, 'USD');
            fetched += trades.length;
        }
        end = start - 1;
    }
    return { fetched, stored, skipped: false };
}

function startFundingTradeBackfill(db, restClient = rest) {
    if (fundingTradeBackfillPromise || !db?.upsertFundingTrades) return;
    fundingTradeBackfillStatus = {
        state: 'running',
        fetched: 0,
        stored: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
    };
    fundingTradeBackfillPromise = backfillFundingTrades({ db, restClient })
        .then(result => {
            fundingTradeBackfillStatus = {
                ...fundingTradeBackfillStatus,
                state: result.error ? 'error' : 'completed',
                fetched: result.fetched || 0,
                stored: result.stored || 0,
                finishedAt: new Date().toISOString(),
                error: result.error || null,
            };
            return result;
        })
        .catch(error => {
            fundingTradeBackfillStatus = {
                ...fundingTradeBackfillStatus,
                state: 'error',
                finishedAt: new Date().toISOString(),
                error: error.message,
            };
            console.error('Funding trade backfill error:', error.message);
            return { fetched: 0, stored: 0, error: error.message };
        })
        .finally(() => {
            fundingTradeBackfillPromise = null;
        });
}

function getFundingTradeBackfillStatus() {
    return { ...fundingTradeBackfillStatus };
}

function mergeFundingTrades(...groups) {
    const byId = new Map();
    for (const group of groups) {
        for (const trade of group) {
            const parsed = parseFundingTrade(trade);
            if (parsed) byId.set(String(parsed.id), parsed);
        }
    }
    return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 讀取近 24 小時公開成交明細。
 * Oracle PostgreSQL 是正常路徑；若 collector 暫停、資料表剛建立或最後寫入
 * 已超過 5 分鐘，API 會用 Bitfinex 公開端點自我修復，避免畫面只有空的小時桶。
 */
async function loadRecentFundingTrades({ db, restClient = rest, now = Date.now() } = {}) {
    const from = new Date(now - DAY_MS);
    const to = new Date(now);
    let stored = [];
    let latestTimestamp = null;

    if (db?.getFundingTrades) {
        stored = await db.getFundingTrades('USD', from, to);
        if (db.getLatestFundingTradeTimestamp) {
            latestTimestamp = await db.getLatestFundingTradeTimestamp('USD');
        }
    }

    const needsRepair = !stored.length
        || !Number.isFinite(Number(latestTimestamp))
        || Number(latestTimestamp) < now - FUNDING_TRADES_STALE_AFTER_MS;
    // 即使最新一頁已存在，也要確保較早的 24 小時分段補抓任務有啟動。
    startFundingTradeBackfill(db, restClient);
    if (!needsRepair) return stored;

    try {
        const rows = await fetchRecentFundingTrades(restClient);
        const fresh = rows.map(parseFundingTrade).filter(Boolean);
        if (fresh.length && db?.upsertFundingTrades) {
            await db.upsertFundingTrades(fresh, 'USD');
        }
        return mergeFundingTrades(stored, fresh);
    } catch (error) {
        // Collector/API repair must not take down the dashboard; retain any Oracle data.
        console.error('Funding trade self-heal error:', error.message);
        return stored;
    }
}

/**
 * 啟動公開撮合資料收集器。資料寫入失敗只記錄，不阻斷 API 或放貸引擎。
 */
function startFundingTradeCollector(db, restClient = rest) {
    if (fundingTradeCollectorTimer || !db?.upsertFundingTrades) return;

    const collect = async () => {
        if (fundingTradeCollectorPromise) return fundingTradeCollectorPromise;
        fundingTradeCollectorPromise = refreshFundingTrades({ db, restClient })
            .catch(error => {
                console.error('Funding trade collector error:', error.message);
                return { fetched: 0, stored: 0, error: error.message };
            })
            .finally(() => {
                fundingTradeCollectorPromise = null;
            });
        return fundingTradeCollectorPromise;
    };

    void collect();
    startFundingTradeBackfill(db, restClient);
    fundingTradeCollectorTimer = setInterval(() => { void collect(); }, FUNDING_TRADES_COLLECT_INTERVAL_MS);
}

function stopFundingTradeCollector() {
    if (fundingTradeCollectorTimer) {
        clearInterval(fundingTradeCollectorTimer);
        fundingTradeCollectorTimer = null;
    }
}

function buildHourlyFundingMatches(trades, now = Date.now(), limit = 6, includeEmpty = false) {
    const buckets = new Map();
    for (const trade of trades) {
        if (trade.timestamp < now - DAY_MS || trade.timestamp > now) continue;
        const timestamp = Math.floor(trade.timestamp / HOUR_MS) * HOUR_MS;
        const bucket = buckets.get(timestamp) || {
            timestamp,
            amount: 0,
            minRate: Infinity,
            maxRate: -Infinity,
            count: 0,
            details: [],
        };
        bucket.amount += trade.amount;
        bucket.minRate = Math.min(bucket.minRate, trade.rate);
        bucket.maxRate = Math.max(bucket.maxRate, trade.rate);
        bucket.count += 1;
        bucket.details.push({
            id: trade.id,
            timestamp: trade.timestamp,
            amount: trade.amount,
            period: trade.period,
            apy: annualizedPercent(trade.rate),
        });
        buckets.set(timestamp, bucket);
    }

    if (includeEmpty) {
        const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
        for (let index = 0; index < limit; index += 1) {
            const timestamp = currentHour - index * HOUR_MS;
            if (!buckets.has(timestamp)) {
                buckets.set(timestamp, {
                    timestamp,
                    amount: 0,
                    minRate: null,
                    maxRate: null,
                    count: 0,
                    details: [],
                });
            }
        }
    }

    return [...buckets.values()]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit)
        .map(bucket => ({
            ...bucket,
            minApy: bucket.minRate === null || bucket.minRate === Infinity ? null : annualizedPercent(bucket.minRate),
            maxApy: bucket.maxRate === null || bucket.maxRate === -Infinity ? null : annualizedPercent(bucket.maxRate),
            details: bucket.details.sort((a, b) => b.timestamp - a.timestamp),
        }));
}

function numericHistory(history, field) {
    return history
        .map(row => numberOrNull(row?.[field]))
        .filter(value => value !== null);
}

function taipeiDateKey(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(timestamp));
}

function aggregateDailyRateHistory(history, now = Date.now(), days = 30) {
    const currentDate = taipeiDateKey(new Date(now).toISOString());
    if (!currentDate) return [];

    // Taiwan has no DST, so its local midnight can be represented with +08:00.
    const currentDayStart = Date.parse(`${currentDate}T00:00:00+08:00`);
    const firstDayStart = currentDayStart - (days - 1) * DAY_MS;
    const firstDate = taipeiDateKey(new Date(firstDayStart).toISOString());
    const buckets = new Map();

    for (const row of history) {
        const date = taipeiDateKey(row?.recorded_at);
        if (!date || date < firstDate || date > currentDate) continue;

        const bucket = buckets.get(date) || {
            date,
            avgSum: 0,
            avgCount: 0,
            highRate: null,
            lowRate: null,
        };
        const avgRate = numberOrNull(row?.avg_rate);
        const highRate = numberOrNull(row?.high_rate);
        const lowRate = numberOrNull(row?.low_rate);
        if (avgRate !== null) {
            bucket.avgSum += avgRate;
            bucket.avgCount += 1;
        }
        if (highRate !== null) bucket.highRate = bucket.highRate === null ? highRate : Math.max(bucket.highRate, highRate);
        if (lowRate !== null) bucket.lowRate = bucket.lowRate === null ? lowRate : Math.min(bucket.lowRate, lowRate);
        buckets.set(date, bucket);
    }

    return [...buckets.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(bucket => ({
            recorded_at: `${bucket.date}T00:00:00+08:00`,
            avg_rate: bucket.avgCount ? bucket.avgSum / bucket.avgCount : null,
            high_rate: bucket.highRate,
            low_rate: bucket.lowRate,
        }));
}

/**
 * 取得每日摘要所需的 fUSD 公開市場資料。
 * 市場成交資料優先來自 OCI VM 本機 PostgreSQL；沒有本機資料庫時才直接查 Bitfinex。
 * 30 日統計使用本機已收集的 rate_history。
 */
async function buildFundingMarketSummary({ publicWs, db, now = Date.now(), restClient = rest, historyData, tradeData } = {}) {
    const marketData = publicWs?.getMarketData?.('USD') || {};
    const [tradesResult, historyResult] = await Promise.allSettled([
        tradeData !== undefined
            ? Promise.resolve(tradeData)
            : db?.getFundingTrades
                ? db.getFundingTrades('USD', new Date(now - DAY_MS), new Date(now))
                : fetchFundingTradesRange(restClient, now - DAY_MS, now),
        historyData !== undefined
            ? Promise.resolve(historyData)
            : db?.getRateHistory
                ? db.getRateHistory('USD', 30 * 24, 'recorded_at,avg_rate,high_rate,low_rate')
                : Promise.resolve([]),
    ]);

    const trades = (tradesResult.status === 'fulfilled' && Array.isArray(tradesResult.value))
        ? tradesResult.value.map(parseFundingTrade).filter(Boolean)
        : [];
    const rawHistory = (historyResult.status === 'fulfilled' && Array.isArray(historyResult.value))
        ? historyResult.value
        : [];
    const history = aggregateDailyRateHistory(rawHistory, now, 30);

    const tradeVolume = trades.reduce((sum, trade) => sum + trade.amount, 0);
    const weightedRate = tradeVolume > 0
        ? trades.reduce((sum, trade) => sum + trade.rate * trade.amount, 0) / tradeVolume
        : null;
    const tradeRates = trades.map(trade => trade.rate);
    const currentRate = weightedRate ?? numberOrNull(marketData.lastPrice) ?? numberOrNull(marketData.frr);
    const high24h = numberOrNull(marketData.high) ?? (tradeRates.length ? Math.max(...tradeRates) : null);
    const low24h = numberOrNull(marketData.low) ?? (tradeRates.length ? Math.min(...tradeRates) : null);

    const averageRates = numericHistory(history, 'avg_rate');
    const highRates = numericHistory(history, 'high_rate');
    const lowRates = numericHistory(history, 'low_rate');

    return {
        currency: 'USD',
        currentRate,
        high24h: high24h,
        low24h: low24h,
        high30d: highRates.length ? Math.max(...highRates) : null,
        low30d: lowRates.length ? Math.min(...lowRates) : null,
        history: history.map(row => ({
            timestamp: row.recorded_at,
            avgRate: numberOrNull(row.avg_rate),
            highRate: numberOrNull(row.high_rate),
            lowRate: numberOrNull(row.low_rate),
        })).filter(row => row.avgRate !== null || row.highRate !== null || row.lowRate !== null),
        currentApy: annualizedPercent(currentRate),
        high24hApy: annualizedPercent(high24h),
        low24hApy: annualizedPercent(low24h),
        volume24h: numberOrNull(marketData.volume) ?? tradeVolume,
        average30dApy: averageRates.length
            ? annualizedPercent(averageRates.reduce((sum, rate) => sum + rate, 0) / averageRates.length)
            : null,
        high30dApy: highRates.length ? annualizedPercent(Math.max(...highRates)) : null,
        low30dApy: lowRates.length ? annualizedPercent(Math.min(...lowRates)) : null,
        hourlyMatches: buildHourlyFundingMatches(trades, now),
        hourlyMatches24: buildHourlyFundingMatches(trades, now, 24, true),
        collectedTradeCount: trades.length,
        historyPointCount: history.length,
    };
}

async function getCachedFundingMarketSummary(options = {}) {
    const now = options.now || Date.now();
    if (!options.force && cachedSummary && now - cachedAt < CACHE_MS) {
        return cachedSummary;
    }
    if (cachePromise) return cachePromise;

    const tradeDataPromise = options.tradeData !== undefined
        ? Promise.resolve(options.tradeData)
        : loadRecentFundingTrades({
            db: options.db,
            restClient: options.restClient,
            now,
        });

    cachePromise = Promise.all([
        tradeDataPromise.catch(() => undefined),
        getCachedRateHistory(options.db, now).catch(() => []),
    ])
    .then(([tradeData, historyData]) => buildFundingMarketSummary({
        ...options,
        tradeData,
        historyData,
    }))
        .then(summary => {
            cachedSummary = summary;
            cachedAt = now;
            return summary;
        })
        .finally(() => {
            cachePromise = null;
        });
    return cachePromise;
}

module.exports = {
    annualizedPercent,
    aggregateDailyRateHistory,
    buildHourlyFundingMatches,
    buildFundingMarketSummary,
    getCachedFundingMarketSummary,
    loadRecentFundingTrades,
    refreshFundingTrades,
    backfillFundingTrades,
    getFundingTradeBackfillStatus,
    startFundingTradeCollector,
    startFundingTradeBackfill,
    stopFundingTradeCollector,
};
