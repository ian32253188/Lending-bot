const FEATURE_NAMES = [
    'frr', 'fundingVwap', 'frrChange5m', 'frrChange15m', 'frrChange1h', 'frrChange6h',
    'frrVolatility5m', 'frrVolatility15m', 'frrVolatility1h', 'frrVolatility6h',
    'vwapChange5m', 'vwapChange15m', 'vwapChange1h', 'vwapChange6h',
    'vwapVolatility5m', 'vwapVolatility15m', 'vwapVolatility1h', 'vwapVolatility6h',
    'bestBid', 'bestAsk', 'spread', 'spreadRelative', 'bidDepth5', 'askDepth5', 'bookImbalance5',
    'tradeVolume', 'tradeCount', 'tenorMean', 'tenorShortShare', 'tenorMediumShare', 'tenorLongShare',
    'hourSin', 'hourCos', 'weekdaySin', 'weekdayCos',
];

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function average(values) {
    const clean = values.map(finite).filter(value => value !== null);
    return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function volatility(values) {
    const clean = values.map(finite).filter(value => value !== null);
    if (clean.length < 2) return 0;
    const mean = average(clean);
    return Math.sqrt(clean.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / clean.length);
}

function bucketStats(history, current, field, minutes) {
    const from = current.timestamp - minutes * 60_000;
    const values = history.filter(row => row.timestamp >= from && row.timestamp <= current.timestamp)
        .map(row => finite(row[field])).filter(value => value !== null);
    return values;
}

function weightedVwap(history, from, to) {
    const rows = history.filter(row => row.timestamp >= from && row.timestamp <= to)
        .filter(row => finite(row.fundingVwap) !== null && Number(row.tradeVolume) > 0);
    const volume = rows.reduce((sum, row) => sum + Number(row.tradeVolume), 0);
    return volume ? rows.reduce((sum, row) => sum + Number(row.fundingVwap) * Number(row.tradeVolume), 0) / volume : null;
}

function buildFeatureVector(history, timestamp = Date.now()) {
    const rows = (history || []).map(row => {
        const data = row.features || row;
        const rawTimestamp = row.minute_at ?? row.minuteAt ?? row.timestamp;
        return { ...data, timestamp: new Date(rawTimestamp).getTime() };
    }).filter(row => Number.isFinite(row.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
    const current = rows.at(-1);
    if (!current) return null;
    const ts = Number.isFinite(timestamp) ? timestamp : current.timestamp;
    const f = {};
    f.frr = finite(current.frr);
    f.fundingVwap = finite(current.fundingVwap);

    for (const [label, minutes] of [['5m', 5], ['15m', 15], ['1h', 60], ['6h', 360]]) {
        const frrValues = bucketStats(rows, current, 'frr', minutes);
        const tradeRows = rows.filter(row => row.timestamp >= current.timestamp - minutes * 60_000 && row.timestamp <= current.timestamp);
        const latestVwap = weightedVwap(rows, current.timestamp - 60_000, current.timestamp);
        const previousVwap = weightedVwap(rows, current.timestamp - (minutes + 1) * 60_000, current.timestamp - minutes * 60_000);
        f[`frrChange${label}`] = frrValues.length >= 2 ? frrValues.at(-1) - frrValues[0] : 0;
        f[`frrVolatility${label}`] = volatility(frrValues);
        f[`vwapChange${label}`] = latestVwap !== null && previousVwap !== null ? latestVwap - previousVwap : 0;
        f[`vwapVolatility${label}`] = volatility(tradeRows.map(row => row.fundingVwap));
    }

    const bids = Array.isArray(current.bookBids) ? current.bookBids : [];
    const asks = Array.isArray(current.bookAsks) ? current.bookAsks : [];
    f.bestBid = finite(bids[0]?.rate);
    f.bestAsk = finite(asks[0]?.rate);
    f.spread = f.bestAsk !== null && f.bestBid !== null ? f.bestAsk - f.bestBid : null;
    f.spreadRelative = f.spread !== null && f.frr ? f.spread / Math.abs(f.frr) : null;
    f.bidDepth5 = bids.slice(0, 5).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    f.askDepth5 = asks.slice(0, 5).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const bookTotal = f.bidDepth5 + f.askDepth5;
    f.bookImbalance5 = bookTotal ? (f.bidDepth5 - f.askDepth5) / bookTotal : 0;
    f.tradeVolume = Number(current.tradeVolume) || 0;
    f.tradeCount = Number(current.tradeCount) || 0;
    const tenors = current.tenorDistribution && typeof current.tenorDistribution === 'object' ? current.tenorDistribution : {};
    const tenorEntries = Object.entries(tenors).map(([days, amount]) => [Number(days), Number(amount)])
        .filter(([days, amount]) => Number.isFinite(days) && Number.isFinite(amount) && amount > 0);
    const tenorVolume = tenorEntries.reduce((sum, [, amount]) => sum + amount, 0);
    f.tenorMean = tenorVolume ? tenorEntries.reduce((sum, [days, amount]) => sum + days * amount, 0) / tenorVolume : 0;
    f.tenorShortShare = tenorVolume ? tenorEntries.filter(([days]) => days <= 7).reduce((sum, [, amount]) => sum + amount, 0) / tenorVolume : 0;
    f.tenorMediumShare = tenorVolume ? tenorEntries.filter(([days]) => days > 7 && days <= 30).reduce((sum, [, amount]) => sum + amount, 0) / tenorVolume : 0;
    f.tenorLongShare = tenorVolume ? tenorEntries.filter(([days]) => days > 30).reduce((sum, [, amount]) => sum + amount, 0) / tenorVolume : 0;

    const date = new Date(ts);
    const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
    const weekday = date.getUTCDay();
    f.hourSin = Math.sin((2 * Math.PI * hour) / 24);
    f.hourCos = Math.cos((2 * Math.PI * hour) / 24);
    f.weekdaySin = Math.sin((2 * Math.PI * weekday) / 7);
    f.weekdayCos = Math.cos((2 * Math.PI * weekday) / 7);

    for (const name of FEATURE_NAMES) {
        if (!Number.isFinite(f[name])) f[name] = 0;
    }
    return f;
}

module.exports = { FEATURE_NAMES, buildFeatureVector };
