const rest = require('./bitfinex/rest');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CACHE_MS = 60 * 1000;
const HISTORY_CACHE_MS = 5 * 60 * 1000;
let cachedSummary = null;
let cachedAt = 0;
let cachePromise = null;
let cachedHistory = null;
let cachedHistoryAt = 0;
let cachedHistoryDb = null;
let historyPromise = null;

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
 * 市場成交資料來自 Bitfinex public API；30 日統計使用本機已收集的 rate_history。
 */
async function buildFundingMarketSummary({ publicWs, db, now = Date.now(), restClient = rest, historyData } = {}) {
    const marketData = publicWs?.getMarketData?.('USD') || {};
    const [tradesResult, historyResult] = await Promise.allSettled([
        restClient.getFundingTrades('USD', {
            start: now - DAY_MS,
            end: now,
            limit: 10000,
            sort: -1,
        }),
        historyData !== undefined
            ? Promise.resolve(historyData)
            : db?.getRateHistory
                ? db.getRateHistory('USD', 30 * 24, 'recorded_at,avg_rate,high_rate,low_rate')
                : Promise.resolve([]),
    ]);

    const trades = (tradesResult.status === 'fulfilled' && Array.isArray(tradesResult.value))
        ? tradesResult.value.map(parsePublicFundingTrade).filter(Boolean)
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

    cachePromise = buildFundingMarketSummary({
        ...options,
        historyData: getCachedRateHistory(options.db, now),
    })
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
};
