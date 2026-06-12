const client = require('prom-client');

// 建立 Prometheus 預設 Registry
const registry = new client.Registry();

// 收集預設 Node.js 系統指標 (CPU, Memory, Event Loop 等)
client.collectDefaultMetrics({ register: registry });

// ==================== 宣告自訂監控指標 ====================

// 1. 帳戶餘額 Gauge
const balanceGauge = new client.Gauge({
    name: 'lending_bot_balance_usd',
    help: 'Bitfinex account balance in USD equivalent',
    labelNames: ['currency', 'type'], // type: 'available' | 'total' | 'exchange'
});
registry.registerMetric(balanceGauge);

// 2. 當前放貸中指標 Gauges
const activeLoansCountGauge = new client.Gauge({
    name: 'lending_bot_active_loans_count',
    help: 'Number of currently active funding loans',
    labelNames: ['currency'],
});
const activeLoansAmountGauge = new client.Gauge({
    name: 'lending_bot_active_loans_amount',
    help: 'Total value of active funding loans',
    labelNames: ['currency'],
});
registry.registerMetric(activeLoansCountGauge);
registry.registerMetric(activeLoansAmountGauge);

// 3. API 請求計數器 Counter
const apiRequestsCounter = new client.Counter({
    name: 'lending_bot_api_requests_total',
    help: 'Total number of API requests sent to Bitfinex',
    labelNames: ['method', 'endpoint', 'status'],
});
registry.registerMetric(apiRequestsCounter);

// 4. API 錯誤計數器 Counter
const apiErrorsCounter = new client.Counter({
    name: 'lending_bot_api_errors_total',
    help: 'Total number of failed API requests to Bitfinex',
    labelNames: ['method', 'endpoint', 'error_type'],
});
registry.registerMetric(apiErrorsCounter);

// 5. API 延遲分佈 Histogram (用於 Latency SLO)
const apiRequestDurationHistogram = new client.Histogram({
    name: 'lending_bot_request_duration_seconds',
    help: 'Duration of API requests in seconds',
    labelNames: ['method', 'endpoint'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], // 延遲區間分布桶
});
registry.registerMetric(apiRequestDurationHistogram);

// 6. 放貸引擎決策時間戳
const lastDecisionTimestampGauge = new client.Gauge({
    name: 'lending_bot_last_decision_timestamp_seconds',
    help: 'Epoch timestamp of the last lending decision cycle',
    labelNames: ['currency'],
});
registry.registerMetric(lastDecisionTimestampGauge);

function normalizeEndpoint(endpoint) {
    if (!endpoint) return 'unknown';
    // 移除查詢參數
    let path = endpoint.split('?')[0];
    
    // 將 Bitfinex 幣種代碼 (例如 /fUSD, /fUST) 替換為佔位符
    path = path.replace(/\/f[A-Z0-9]{3,4}\b/gi, '/:symbol');
    
    // 將訂單簿精度 (例如 /P0, /P1) 替換為佔位符
    path = path.replace(/\/P[0-4]\b/gi, '/:prec');
    
    // 將數字/ID (例如 /123456) 替換為佔位符
    path = path.replace(/\/\d+\b/g, '/:id');
    
    return path;
}

// ==================== 指標操作介面 ====================

module.exports = {
    registry,

    /**
     * 更新錢包餘額
     */
    updateBalance(currency, type, amount) {
        try {
            balanceGauge.labels(currency, type).set(Number(amount) || 0);
        } catch (err) {
            console.error('Metrics updateBalance error:', err.message);
        }
    },

    /**
     * 更新活躍貸款狀態
     */
    updateActiveLoans(currency, count, totalAmount) {
        try {
            activeLoansCountGauge.labels(currency).set(Number(count) || 0);
            activeLoansAmountGauge.labels(currency).set(Number(totalAmount) || 0);
        } catch (err) {
            console.error('Metrics updateActiveLoans error:', err.message);
        }
    },

    /**
     * 記錄 API 請求與耗時
     */
    recordApiRequest(method, endpoint, status, durationSeconds) {
        try {
            const normalized = normalizeEndpoint(endpoint);
            apiRequestsCounter.labels(method, normalized, status).inc();
            if (durationSeconds !== undefined) {
                apiRequestDurationHistogram.labels(method, normalized).observe(durationSeconds);
            }
        } catch (err) {
            console.error('Metrics recordApiRequest error:', err.message);
        }
    },

    /**
     * 記錄 API 錯誤
     */
    recordApiError(method, endpoint, errorType) {
        try {
            const normalized = normalizeEndpoint(endpoint);
            apiErrorsCounter.labels(method, normalized, errorType).inc();
        } catch (err) {
            console.error('Metrics recordApiError error:', err.message);
        }
    },

    /**
     * 記錄決策時間戳
     */
    recordDecision(currency) {
        try {
            lastDecisionTimestampGauge.labels(currency).setToCurrentTime();
        } catch (err) {
            console.error('Metrics recordDecision error:', err.message);
        }
    }
};
