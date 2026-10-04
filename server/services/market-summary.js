const rest = require('./bitfinex/rest');
const { isPublicTickerFresh } = require('./bitfinex/ws');
const { withRetry } = require('../utils/retry');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CACHE_MS = 60 * 1000;
const HISTORY_CACHE_MS = 60 * 60 * 1000; // 1 小時快取
const PUBLIC_FUNDING_TRADES_LIMIT = 10000;
const PUBLIC_FUNDING_CANDLES_LIMIT = 1000;
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
let cachedFundingCandles = null;
let cachedFundingCandlesAt = 0;
let cachedFundingCandlesClient = null;
let fundingCandlesPromise = null;
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
        .then(() => db.getRateHistory('USD', 30 * 24, 'recorded_at,avg_rate,high_rate,low_rate'))
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
    if (value === null || value === undefined || value === '') return null;
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
    return withRetry(
        () => restClient.getFundingTrades('USD', {
            start,
            end,
            limit: PUBLIC_FUNDING_TRADES_LIMIT,
            sort: -1,
        }),
        {
            maxRetries: 4,
            baseDelay: 5000,
            label: 'Bitfinex funding trades history',
            shouldRetry: error => /429|ratelimit/i.test(error?.message || ''),
        },
    );
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
    const rows = await withRetry(
        () => restClient.getFundingTrades('USD', {
            limit: PUBLIC_FUNDING_TRADES_LIMIT,
            sort: -1,
        }),
        {
            maxRetries: 4,
            baseDelay: 5000,
            label: 'Bitfinex recent funding trades',
            shouldRetry: error => /429|ratelimit/i.test(error?.message || ''),
        },
    );
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
    const storedRows = db.getFundingTrades
        ? await db.getFundingTrades('USD', new Date(targetStart), new Date(now))
        : [];
    const coveredHours = new Set(
        storedRows
            .map(trade => Number(trade?.timestamp ?? trade?.executed_at))
            .filter(Number.isFinite)
            .map(timestamp => Math.floor(timestamp / HOUR_MS) * HOUR_MS),
    );
    const firstHour = Math.floor(targetStart / HOUR_MS) * HOUR_MS;
    const lastHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const missingHours = [];
    for (let hour = firstHour; hour <= lastHour; hour += HOUR_MS) {
        if (!coveredHours.has(hour)) missingHours.push(hour);
    }
    if (!missingHours.length) return { fetched: 0, stored: 0, skipped: false };

    const requestState = { requestCount: 0, lastRequestAt: 0 };
    let fetched = 0;
    let storedCount = 0;
    for (const hour of missingHours) {
        const start = Math.max(targetStart, hour);
        const end = Math.min(now, hour + HOUR_MS - 1);
        const rows = await fetchFundingTradesRange(restClient, start, end, requestState);
        const trades = rows.map(parseFundingTrade).filter(Boolean);
        if (trades.length) {
            storedCount += await db.upsertFundingTrades(trades, 'USD');
            fetched += trades.length;
        }
    }
    return { fetched, stored: storedCount, skipped: false };
}

function startFundingTradeBackfill(db, restClient = rest) {
    if (fundingTradeBackfillPromise || !db?.upsertFundingTrades) return;
    if (fundingTradeCollectorPromise) {
        void fundingTradeCollectorPromise.finally(() => {
            startFundingTradeBackfill(db, restClient);
        });
        return;
    }
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

    let storageReadFailed = false;
    if (db?.getFundingTrades) {
        try {
            stored = await db.getFundingTrades('USD', from, to);
            if (db.getLatestFundingTradeTimestamp) {
                latestTimestamp = await db.getLatestFundingTradeTimestamp('USD');
            }
        } catch (error) {
            storageReadFailed = true;
            console.error('Funding trade Oracle read failed; trying Bitfinex public REST:', error.message);
        }
    }

    const needsRepair = storageReadFailed
        || !stored.length
        || !Number.isFinite(Number(latestTimestamp))
        || Number(latestTimestamp) < now - FUNDING_TRADES_STALE_AFTER_MS;
    // 即使最新一頁已存在，也要確保較早的 24 小時分段補抓任務有啟動。
    startFundingTradeBackfill(db, restClient);
    if (!needsRepair) return stored;

    try {
        const rows = await fetchRecentFundingTrades(restClient);
        const fresh = rows.map(parseFundingTrade).filter(Boolean);
        if (fresh.length && db?.upsertFundingTrades) {
            try {
                await db.upsertFundingTrades(fresh, 'USD');
            } catch (error) {
                console.error('Funding trade Oracle write failed; showing verified public REST rows:', error.message);
            }
        }
        return mergeFundingTrades(stored, fresh);
    } catch (error) {
        // Collector/API repair must not take down the dashboard; retain any Oracle data.
        console.error('Funding trade self-heal error:', error.message);
        if (stored.length) return stored;
        throw error;
    }
}

/**
 * 啟動公開撮合資料收集器。資料寫入失敗只記錄，不阻斷 API 或放貸引擎。
 */
function startFundingTradeCollector(db, restClient = rest) {
    if (fundingTradeCollectorTimer || !db?.upsertFundingTrades) return;

    const collect = async () => {
        if (fundingTradeCollectorPromise) return fundingTradeCollectorPromise;
        if (fundingTradeBackfillPromise) return fundingTradeBackfillPromise;
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

function aggregateDailyFundingCandles(candles, now = Date.now(), days = 30) {
    const currentDate = taipeiDateKey(new Date(now).toISOString());
    if (!currentDate) return [];
    const currentDayStart = Date.parse(`${currentDate}T00:00:00+08:00`);
    const firstDate = taipeiDateKey(new Date(currentDayStart - (days - 1) * DAY_MS).toISOString());
    const buckets = new Map();

    for (const candle of candles || []) {
        if (!Array.isArray(candle) || candle.length < 6) continue;
        const timestamp = numberOrNull(candle[0]);
        const closeRate = numberOrNull(candle[2]);
        const highRate = numberOrNull(candle[3]);
        const lowRate = numberOrNull(candle[4]);
        if (timestamp === null || timestamp > now) continue;
        const date = taipeiDateKey(new Date(timestamp).toISOString());
        if (!date || date < firstDate || date > currentDate) continue;

        const bucket = buckets.get(date) || { date, closeSum: 0, closeCount: 0, highRate: null, lowRate: null };
        if (closeRate !== null) {
            bucket.closeSum += closeRate;
            bucket.closeCount += 1;
        }
        if (highRate !== null) bucket.highRate = bucket.highRate === null ? highRate : Math.max(bucket.highRate, highRate);
        if (lowRate !== null) bucket.lowRate = bucket.lowRate === null ? lowRate : Math.min(bucket.lowRate, lowRate);
        buckets.set(date, bucket);
    }

    return [...buckets.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(bucket => ({
            recorded_at: `${bucket.date}T00:00:00+08:00`,
            avg_rate: bucket.closeCount ? bucket.closeSum / bucket.closeCount : null,
            high_rate: bucket.highRate,
            low_rate: bucket.lowRate,
        }));
}

function mergeMissingRateHistory(history, candleHistory) {
    const byDate = new Map(history.map(row => [row.recorded_at.slice(0, 10), row]));
    let fallbackDays = 0;
    for (const row of candleHistory) {
        const date = row.recorded_at.slice(0, 10);
        if (byDate.has(date)) continue;
        byDate.set(date, row);
        fallbackDays += 1;
    }
    return {
        history: [...byDate.values()].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at)),
        fallbackDays,
    };
}

async function getCachedFundingCandles(restClient, now = Date.now()) {
    if (typeof restClient?.getFundingCandles !== 'function') return [];
    if (
        cachedFundingCandles !== null &&
        cachedFundingCandlesClient === restClient &&
        now - cachedFundingCandlesAt < HISTORY_CACHE_MS
    ) {
        return cachedFundingCandles;
    }
    if (fundingCandlesPromise) return fundingCandlesPromise;

    fundingCandlesPromise = Promise.resolve()
        .then(() => restClient.getFundingCandles('USD', { limit: PUBLIC_FUNDING_CANDLES_LIMIT, sort: -1 }))
        .then(rows => Array.isArray(rows) ? rows : [])
        .catch(error => {
            console.error('Bitfinex public funding candle fallback failed:', error.message);
            return [];
        })
        .then(rows => {
            cachedFundingCandles = rows;
            cachedFundingCandlesAt = now;
            cachedFundingCandlesClient = restClient;
            return rows;
        })
        .finally(() => { fundingCandlesPromise = null; });
    return fundingCandlesPromise;
}

/**
 * 取得每日摘要所需的 fUSD 公開市場資料。
 * 市場成交資料優先來自 OCI VM 本機 PostgreSQL；沒有本機資料庫時才直接查 Bitfinex。
 * 30 日統計使用本機已收集的 rate_history。
 */
async function buildFundingMarketSummary({ publicWs, db, now = Date.now(), restClient = rest, historyData, historyCandleData, tradeData } = {}) {
    const marketData = publicWs?.getMarketData?.('USD') || {};
    const tickerUpdatedAt = numberOrNull(marketData.tickerLastUpdate);
    const tickerFresh = isPublicTickerFresh(marketData, now);
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

    const tradeDataAvailable = tradesResult.status === 'fulfilled' && Array.isArray(tradesResult.value);
    const historyDataAvailable = historyResult.status === 'fulfilled' && Array.isArray(historyResult.value);
    const candleResult = await Promise.allSettled([Promise.resolve(historyCandleData ?? [])]);
    const historyCandleDataAvailable = candleResult[0].status === 'fulfilled' && Array.isArray(candleResult[0].value);
    const trades = tradeDataAvailable
        ? tradesResult.value.map(parseFundingTrade).filter(Boolean)
        : [];
    const rawHistory = historyDataAvailable
        ? historyResult.value
        : [];
    const oracleHistory = aggregateDailyRateHistory(rawHistory, now, 30);
    const candleHistory = aggregateDailyFundingCandles(
        historyCandleDataAvailable ? candleResult[0].value : [],
        now,
        30,
    );
    const mergedHistory = mergeMissingRateHistory(oracleHistory, candleHistory);
    const history = mergedHistory.history;
    const historyAvailable = historyDataAvailable || candleHistory.length > 0;

    const tradeVolume = trades.reduce((sum, trade) => sum + trade.amount, 0);
    const weightedRate = tradeVolume > 0
        ? trades.reduce((sum, trade) => sum + trade.rate * trade.amount, 0) / tradeVolume
        : null;
    const tradeRates = trades.map(trade => trade.rate);
    const tickerLastPrice = tickerFresh ? numberOrNull(marketData.lastPrice) : null;
    const tickerFrr = tickerFresh ? numberOrNull(marketData.frr) : null;
    const tickerHigh = tickerFresh ? numberOrNull(marketData.high) : null;
    const tickerLow = tickerFresh ? numberOrNull(marketData.low) : null;
    const tickerVolume = tickerFresh ? numberOrNull(marketData.volume) : null;
    const currentRate = weightedRate ?? tickerLastPrice ?? tickerFrr;
    const currentRateSource = weightedRate !== null
        ? 'funding_trades_24h_vwap'
        : tickerLastPrice !== null
            ? 'bitfinex_public_ticker_last_price'
            : tickerFrr !== null
                ? 'bitfinex_public_ticker_frr'
                : null;
    const lastTradeTimestamp = trades.reduce((latest, trade) => Math.max(latest, trade.timestamp), 0) || null;
    const currentRateObservedAt = weightedRate !== null ? lastTradeTimestamp : tickerUpdatedAt;
    const high24h = tickerHigh ?? (tradeRates.length ? Math.max(...tradeRates) : null);
    const low24h = tickerLow ?? (tradeRates.length ? Math.min(...tradeRates) : null);

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
        volume24h: tickerVolume ?? (tradeDataAvailable ? tradeVolume : null),
        volume24hSource: tickerVolume !== null
            ? 'bitfinex_public_ticker'
            : tradeDataAvailable ? 'funding_trades_24h_sum' : 'unavailable',
        high24hSource: tickerHigh !== null ? 'bitfinex_public_ticker' : tradeRates.length ? 'funding_trades_24h' : 'unavailable',
        low24hSource: tickerLow !== null ? 'bitfinex_public_ticker' : tradeRates.length ? 'funding_trades_24h' : 'unavailable',
        currentRateSource,
        currentRateObservedAt: currentRateObservedAt ? new Date(currentRateObservedAt).toISOString() : null,
        tickerFresh,
        tickerUpdatedAt: tickerUpdatedAt ? new Date(tickerUpdatedAt).toISOString() : null,
        tradeDataAvailable,
        historyDataAvailable: historyAvailable,
        marketDataSources: {
            trades: db?.getFundingTrades
                ? 'Oracle PostgreSQL primary; Bitfinex public REST self-healing fallback'
                : 'Bitfinex public REST API',
            rateHistory: mergedHistory.fallbackDays
                ? `${db?.getRateHistory && historyDataAvailable ? 'Oracle PostgreSQL' : 'No local history'} + Bitfinex public hourly candles for ${mergedHistory.fallbackDays} missing day(s); daily mean of hourly closes`
                : db?.getRateHistory
                    ? historyDataAvailable ? 'Oracle PostgreSQL rate history' : 'Oracle PostgreSQL rate history unavailable'
                    : history.length ? 'Bitfinex public hourly candles; daily mean of hourly closes' : 'unavailable',
            ticker: tickerFresh ? 'Bitfinex public Funding Ticker' : 'stale or unavailable',
        },
        average30dApy: averageRates.length
            ? annualizedPercent(averageRates.reduce((sum, rate) => sum + rate, 0) / averageRates.length)
            : null,
        high30dApy: highRates.length ? annualizedPercent(Math.max(...highRates)) : null,
        low30dApy: lowRates.length ? annualizedPercent(Math.min(...lowRates)) : null,
        hourlyMatches: tradeDataAvailable ? buildHourlyFundingMatches(trades, now) : [],
        hourlyMatches24: tradeDataAvailable ? buildHourlyFundingMatches(trades, now, 24, true) : [],
        collectedTradeCount: tradeDataAvailable ? trades.length : null,
        historyPointCount: historyAvailable ? history.length : null,
        historyCoverageDays: historyAvailable ? history.length : null,
        historyCandleFallbackDays: mergedHistory.fallbackDays,
        historyWindowDays: 30,
        historyCoverageStartDate: historyAvailable ? history[0]?.recorded_at?.slice(0, 10) || null : null,
        historyCoverageEndDate: historyAvailable ? history[history.length - 1]?.recorded_at?.slice(0, 10) || null : null,
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

    const historyDataPromise = options.historyData !== undefined
        ? Promise.resolve(options.historyData)
        : getCachedRateHistory(options.db, now);

    const historyCandleDataPromise = options.historyCandleData !== undefined
        ? Promise.resolve(options.historyCandleData)
        : historyDataPromise
            .then(history => {
                const dailyHistory = aggregateDailyRateHistory(Array.isArray(history) ? history : [], now, 30);
                return dailyHistory.length >= 30 ? [] : getCachedFundingCandles(options.restClient || rest, now);
            })
            .catch(() => getCachedFundingCandles(options.restClient || rest, now));

    cachePromise = Promise.all([
        tradeDataPromise.then(value => ({ available: Array.isArray(value), value }))
            .catch(error => ({ available: false, error })),
        historyDataPromise.then(value => ({ available: Array.isArray(value), value }))
            .catch(error => ({ available: false, error })),
        historyCandleDataPromise.then(value => ({ available: Array.isArray(value), value }))
            .catch(error => ({ available: false, error })),
    ])
    .then(([tradeResult, historyResult, candleResult]) => buildFundingMarketSummary({
        ...options,
        tradeData: tradeResult.available ? tradeResult.value : Promise.reject(tradeResult.error),
        historyData: historyResult.available ? historyResult.value : Promise.reject(historyResult.error),
        historyCandleData: candleResult.available ? candleResult.value : Promise.reject(candleResult.error),
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
    aggregateDailyFundingCandles,
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
