const rest = require('./bitfinex/rest');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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

function buildHourlyFundingMatches(trades, now = Date.now(), limit = 6) {
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
        };
        bucket.amount += trade.amount;
        bucket.minRate = Math.min(bucket.minRate, trade.rate);
        bucket.maxRate = Math.max(bucket.maxRate, trade.rate);
        bucket.count += 1;
        buckets.set(timestamp, bucket);
    }

    return [...buckets.values()]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit)
        .map(bucket => ({
            ...bucket,
            minApy: annualizedPercent(bucket.minRate),
            maxApy: annualizedPercent(bucket.maxRate),
        }));
}

function numericHistory(history, field) {
    return history
        .map(row => numberOrNull(row?.[field]))
        .filter(value => value !== null);
}

/**
 * 取得每日摘要所需的 fUSD 公開市場資料。
 * 市場成交資料來自 Bitfinex public API；30 日統計使用本機已收集的 rate_history。
 */
async function buildFundingMarketSummary({ publicWs, db, now = Date.now() } = {}) {
    const marketData = publicWs?.getMarketData?.('USD') || {};
    const [tradesResult, historyResult] = await Promise.allSettled([
        rest.getFundingTrades('USD', {
            start: now - DAY_MS,
            end: now,
            limit: 10000,
            sort: -1,
        }),
        db?.getRateHistory ? db.getRateHistory('USD', 30 * 24) : Promise.resolve([]),
    ]);

    const trades = (tradesResult.status === 'fulfilled' && Array.isArray(tradesResult.value))
        ? tradesResult.value.map(parsePublicFundingTrade).filter(Boolean)
        : [];
    const history = (historyResult.status === 'fulfilled' && Array.isArray(historyResult.value))
        ? historyResult.value
        : [];

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
        collectedTradeCount: trades.length,
        historyPointCount: history.length,
    };
}

module.exports = {
    annualizedPercent,
    buildHourlyFundingMatches,
    buildFundingMarketSummary,
};
