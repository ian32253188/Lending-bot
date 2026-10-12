const RATE_STRATEGIES = Object.freeze({
    CURRENT_AVG: 'current_avg',
    HIGH_24H: 'high_24h',
    HIGH_30D: 'high_30d',
});

const RATE_STRATEGY_LABELS = Object.freeze({
    current_avg: '目前成交均值',
    high_24h: '24 小時最高',
    high_30d: '30 日最高',
});

const PERIOD_DAYS = Object.freeze([2, 10, 30, 60, 90, 120]);

const DEFAULT_STRATEGY_CONFIG = Object.freeze({
    rateStrategy: RATE_STRATEGIES.CURRENT_AVG,
    periodDays: 2,
    useAllAvailable: true,
});

function normalizeStrategyConfig(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const { minRate, maxRate, frrMultiplier, ...savedOptions } = source;
    const rateStrategy = Object.prototype.hasOwnProperty.call(RATE_STRATEGY_LABELS, source.rateStrategy)
        ? source.rateStrategy
        : DEFAULT_STRATEGY_CONFIG.rateStrategy;
    const periodDays = Number(source.periodDays);
    const normalizedPeriod = PERIOD_DAYS.includes(periodDays)
        ? periodDays
        : DEFAULT_STRATEGY_CONFIG.periodDays;

    return {
        ...savedOptions,
        rateStrategy,
        periodDays: normalizedPeriod,
        useAllAvailable: true,
    };
}

function validateStrategyConfig(input = {}) {
    const errors = [];
    if (!Object.prototype.hasOwnProperty.call(RATE_STRATEGY_LABELS, input.rateStrategy)) {
        errors.push(`rateStrategy 必須是 ${Object.keys(RATE_STRATEGY_LABELS).join(', ')}`);
    }
    if (!PERIOD_DAYS.includes(Number(input.periodDays))) {
        errors.push(`periodDays 必須是 ${PERIOD_DAYS.join(', ')}`);
    }
    return errors;
}

module.exports = {
    RATE_STRATEGIES,
    RATE_STRATEGY_LABELS,
    PERIOD_DAYS,
    DEFAULT_STRATEGY_CONFIG,
    normalizeStrategyConfig,
    validateStrategyConfig,
};
