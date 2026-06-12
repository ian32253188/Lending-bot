require('dotenv').config();

const config = {
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',

    bitfinex: {
        apiKey: process.env.BITFINEX_API_KEY,
        apiSecret: process.env.BITFINEX_API_SECRET,
        wsUrl: 'wss://api.bitfinex.com/ws/2',
        restUrl: 'https://api.bitfinex.com/v2',
    },

    supabase: {
        url: process.env.SUPABASE_URL,
        key: process.env.SUPABASE_KEY,
        anonKey: process.env.SUPABASE_ANON_KEY,
    },

    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: '24h',
    },

    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
    },

    lending: {
        currencies: ['USD', 'USDT'],
        minOfferAmount: 150,
        decisionIntervalMs: 10000, // 10 秒決策週期
        maxRetries: 3,
        retryBaseDelayMs: 1000,
        // Bitfinex Funding 市場幣種代碼映射
        // 部分幣種在 Funding 市場的 symbol 與常見名稱不同
        currencyMap: {
            'USD': 'USD',    // fUSD
            'USDT': 'UST',   // fUST（不是 fUSDT！）
        },
        // 反向映射（Bitfinex symbol → 內部代碼）
        symbolToCurrency: {
            'USD': 'USD',
            'UST': 'USDT',
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
    // SaaS 模式：Bitfinex API 金鑰已改為 per-user (存於 DB)，不再從 .env 必要載入
    const required = [
        'supabase.url',
        'supabase.key',
        'supabase.anonKey',
    ];

    // JWT Secret 缺失是安全漏洞，必須強制停止
    if (!config.jwt.secret) {
        console.error('❌ 致命錯誤：JWT_SECRET 環境變數未設定！請在 .env 中設定一個強隨機字串。');
        if (config.nodeEnv === 'production') {
            process.exit(1);
        }
    }

    const missing = required.filter((key) => {
        const keys = key.split('.');
        let val = config;
        for (const k of keys) {
            val = val?.[k];
        }
        return !val;
    });

    if (missing.length > 0) {
        console.warn(`⚠️ 缺少必要設定: ${missing.join(', ')}`);
        console.warn('請確認 .env 檔案已正確設定');
    }
}

validateConfig();

module.exports = config;
