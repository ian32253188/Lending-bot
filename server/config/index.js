require('dotenv').config();

const isTestEnvironment = process.env.NODE_ENV !== 'production'
    && Boolean(process.env.VITEST || process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test');

const config = {
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',

    bitfinex: {
        apiKey: process.env.BITFINEX_API_KEY,
        apiSecret: process.env.BITFINEX_API_SECRET,
        wsUrl: 'wss://api.bitfinex.com/ws/2',
        restUrl: 'https://api.bitfinex.com/v2',
    },

    database: {
        url: process.env.DATABASE_URL,
        // Production runs beside the compose `postgres` service. Keep an
        // explicit fallback so an older remote compose file cannot silently
        // disable PostgreSQL-backed market storage.
        host: process.env.PGHOST || process.env.POSTGRES_HOST
            || (process.env.NODE_ENV === 'production' ? 'postgres' : 'localhost'),
        port: parseInt(process.env.PGPORT || process.env.POSTGRES_PORT, 10) || 5432,
        user: process.env.PGUSER || process.env.POSTGRES_USER || 'postgres',
        password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
        database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'lending_bot',
    },

    admin: {
        // Test-only credentials keep automated tests self-contained. Real
        // instances must provide their own credentials through the environment.
        password: process.env.ADMIN_PASSWORD || (isTestEnvironment ? 'test-only-admin-password' : undefined),
    },

    supabase: {
        url: process.env.SUPABASE_URL,
        key: process.env.SUPABASE_KEY,
        anonKey: process.env.SUPABASE_ANON_KEY,
    },

    jwt: {
        secret: process.env.JWT_SECRET || (isTestEnvironment ? 'test-only-jwt-secret-not-for-runtime-32chars' : undefined),
        expiresIn: '24h',
    },

    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
    },

    // 每日摘要使用的 USD/TWD 公開匯率。主來源每日更新，程式會快取避免頻繁呼叫。
    exchangeRate: {
        primaryUrl: process.env.EXCHANGE_RATE_URL || 'https://open.er-api.com/v6/latest/USD',
        fallbackUrl: process.env.EXCHANGE_RATE_FALLBACK_URL || 'https://api.frankfurter.dev/v2/rate/USD/TWD',
        cacheTtlMs: parseInt(process.env.EXCHANGE_RATE_CACHE_TTL_MS, 10) || 24 * 60 * 60 * 1000,
        timeoutMs: parseInt(process.env.EXCHANGE_RATE_TIMEOUT_MS, 10) || 5000,
    },

    lending: {
        currencies: ['USD'],
        minOfferAmount: 150,
        decisionIntervalMs: 10000, // 10 秒決策週期
        maxRetries: 3,
        retryBaseDelayMs: 1000,
        // Bitfinex Funding 市場幣種代碼映射
        // 部分幣種在 Funding 市場的 symbol 與常見名稱不同
        currencyMap: {
            'USD': 'USD',
        },
        // 反向映射（Bitfinex symbol → 內部代碼）
        symbolToCurrency: {
            'USD': 'USD',
        },
    },

    strategy: {
        defaultMode: 'simplified',
        modes: {
            simplified: {
                frrMultiplier: 0.99, // FRR * 0.99 (加速成交)
                minRate: 0.0002,     // 日利率 0.02% (基於原 balanced 模式)
                maxRate: 0.008,
                reserveRatio: 0,
                orderUnit: 500,
                defaultPeriod: 7,
                pauseOnVolatility: true,
            },
        },
    },
};

// 驗證必要設定
function validateConfig() {
    if (isTestEnvironment) return;

    const missingSettings = [];
    if (!config.admin.password || config.admin.password.length < 12 || /your_|change_me|default|example/i.test(config.admin.password)) {
        missingSettings.push('ADMIN_PASSWORD (至少 12 個字元)');
    }
    if (!config.jwt.secret || config.jwt.secret.length < 32 || /your_|change_me|default|example/i.test(config.jwt.secret)) {
        missingSettings.push('JWT_SECRET (至少 32 個隨機字元，且不可使用範本值)');
    }
    const hasSupabase = Boolean(config.supabase.url && config.supabase.key);
    if (!config.database.url && !hasSupabase) {
        if (!config.database.password || config.database.password.length < 32 || /your_|change_me|default|example|lending_bot_db_password/i.test(config.database.password)) {
            missingSettings.push('POSTGRES_PASSWORD (至少 32 個隨機字元) 或 DATABASE_URL／Supabase 設定');
        }
    }
    if (missingSettings.length) {
        throw new Error(`缺少安全設定：${missingSettings.join('、')}。請更新 .env 後重新啟動。`);
    }

    const hasPostgres = Boolean(config.database.url || (config.database.host && config.database.user));

    if (!hasPostgres && !hasSupabase) {
        console.warn('⚠️ 缺少資料庫連線設定 (未提供 DATABASE_URL 或 SUPABASE_URL)');
        console.warn('請確認 .env 檔案已正確設定本機 PostgreSQL 或資料庫連線');
    }
}

validateConfig();

module.exports = config;
