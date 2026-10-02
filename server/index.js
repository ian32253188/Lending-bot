require('dotenv').config();

const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');
const authMiddleware = require('./middleware/auth');
const { getBitfinexPublicWS } = require('./services/bitfinex/ws');
const { initTelegram } = require('./services/telegram');
const metrics = require('./services/metrics');

// 路由
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const lendingRoutes = require('./routes/lending');

const app = express();
const server = http.createServer(app);

// 中間件
app.use(express.json());

// 靜態檔案（前端 build）
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', authMiddleware, dashboardRoutes);
app.use('/api/lending', authMiddleware, lendingRoutes);

// Prometheus 監控指標
app.get('/metrics', async (req, res) => {
    const authHeader = req.headers.authorization;
    const expectedUser = process.env.METRICS_USERNAME;
    const expectedPass = process.env.METRICS_PASSWORD;

    // 如果配置了 Basic Auth 環境變數，強制作出密碼校驗
    if (expectedUser && expectedPass) {
        if (!authHeader || !authHeader.startsWith('Basic ')) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Metrics"');
            return res.status(401).send('Authentication required');
        }
        
        const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('ascii').split(':');
        const username = credentials[0];
        const password = credentials[1];

        if (username !== expectedUser || password !== expectedPass) {
            return res.status(403).send('Forbidden');
        }
    } else {
        // 預設防禦：無配置密碼時拒絕任何外部 IP 存取
        const ip = req.ip || req.socket.remoteAddress;
        const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.includes('localhost');
        if (!isLocal) {
            return res.status(403).send('Forbidden: External access to /metrics is disabled by default.');
        }
    }

    try {
        res.set('Content-Type', metrics.registry.contentType);
        res.end(await metrics.registry.metrics());
    } catch (err) {
        res.status(500).end(err.message);
    }
});

// 健康檢查（不需認證）
app.get('/api/health', (req, res) => {
    const { getActiveEngineCount } = require('./services/engine/manager');
    const { getTelegramRoutingStats } = require('./services/telegram');
    const { getFundingTradeBackfillStatus } = require('./services/market-summary');
    const publicWs = getBitfinexPublicWS();
    const memory = process.memoryUsage();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        publicWsConnected: publicWs.isConnected(),
        activeEngineCount: typeof getActiveEngineCount === 'function' ? getActiveEngineCount() : 0,
        telegram: typeof getTelegramRoutingStats === 'function'
            ? getTelegramRoutingStats()
            : { sharedBotActive: false, registeredUsers: 0 },
        fundingTradeBackfill: typeof getFundingTradeBackfillStatus === 'function'
            ? getFundingTradeBackfillStatus()
            : { state: 'unknown' },
        memory: {
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
        },
        timestamp: new Date().toISOString(),
    });
});

// SPA fallback
app.get('*splat', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
});

// ============== WebSocket 伺服器（前端即時更新）==============

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
    logger.info('ws-server', '前端 WebSocket 已連接');

    let authenticated = false;
    let userId = null;
    let statusInterval = null;

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());

            // 認證
            if (msg.type === 'auth') {
                if (!msg.token) {
                    ws.send(JSON.stringify({ type: 'auth', status: 'error', message: '缺少認證 Token' }));
                    return;
                }

                const jwt = require('jsonwebtoken');
                const { getBot } = require('./services/engine/manager');
                let verifiedUser = null;

                try {
                    const decoded = jwt.verify(msg.token, config.jwt.secret);
                    if (decoded && decoded.id) {
                        verifiedUser = decoded;
                    }
                } catch (jwtErr) {}

                const handleAuthSuccess = (userObj) => {
                    authenticated = true;
                    userId = userObj.id;
                    ws.send(JSON.stringify({ type: 'auth', status: 'ok' }));

                    // 開始定期推送該用戶的狀態
                    if (statusInterval) clearInterval(statusInterval);
                    statusInterval = setInterval(() => {
                        if (ws.readyState === 1) {
                            const engine = getBot(userId);
                            if (engine) {
                                ws.send(JSON.stringify({
                                    type: 'status',
                                    data: engine.getStatus(),
                                }));
                            } else {
                                const { getInactiveDashboardStatus } = require('./services/dashboard-status');
                                ws.send(JSON.stringify({ type: 'status', data: getInactiveDashboardStatus() }));
                            }
                        }
                    }, 2000); // 每 2 秒推送
                };

                if (verifiedUser) {
                    handleAuthSuccess(verifiedUser);
                    return;
                }

                // 備用：若有 Supabase，嘗試驗證 Supabase Token
                const { getSupabase } = require('./services/database');
                const supabase = getSupabase();
                if (supabase) {
                    supabase.auth.getUser(msg.token).then(({ data: { user }, error }) => {
                        if (error || !user) {
                            ws.send(JSON.stringify({ type: 'auth', status: 'error', message: 'Token 無效或已過期' }));
                            return;
                        }
                        handleAuthSuccess(user);
                    }).catch(err => {
                        ws.send(JSON.stringify({ type: 'auth', status: 'error', message: err.message }));
                    });
                    return;
                }

                ws.send(JSON.stringify({ type: 'auth', status: 'error', message: 'Token 無效或已過期' }));
                return;
            }

            if (!authenticated || !userId) {
                ws.send(JSON.stringify({ type: 'error', message: '未認證' }));
                return;
            }

            switch (msg.type) {
                case 'getDetailed': {
                    const { getBot } = require('./services/engine/manager');
                    const engine = getBot(userId);
                    if (engine) {
                        ws.send(JSON.stringify({
                            type: 'detailed',
                            data: engine.getDetailedStatus(),
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'detailed',
                            data: {
                                activeOffers: [],
                                activeLoans: [],
                                rateHistory: [],
                                logs: []
                            }
                        }));
                    }
                    break;
                }
            }
        } catch (err) {
            logger.error('ws-server', '處理 WebSocket 訊息錯誤', { error: err.message });
        }
    });

    ws.on('close', () => {
        if (statusInterval) clearInterval(statusInterval);
        logger.debug('ws-server', '前端 WebSocket 已斷開');
    });
});

// ============== 啟動伺服器 ==============

async function startup() {
    logger.info('server', '🚀 Bitfinex 多用戶 SaaS 放貸平台啟動中...');

    // 初始化管理員全域 Telegram Bot (SaaS 模式下為選配，用戶各自的 Bot 在 manager.startBot 中初始化)
    initTelegram();

    // 啟動自動恢復程序
    const { autoResumeAll } = require('./services/engine/manager');
    const { startDailyCleanup } = require('./services/analysis/cleanup');
    const { startFundingTradeCollector } = require('./services/market-summary');
    const db = require('./services/database');

    try {
        await autoResumeAll();
    } catch (err) {
        logger.error('server', '放貸引擎自動恢復失敗', { error: err.message });
    }

    try {
        startDailyCleanup();
    } catch (err) {
        logger.error('server', '啟動每日日誌清理排程失敗', { error: err.message });
    }

    try {
        startFundingTradeCollector(db);
    } catch (err) {
        logger.error('server', '啟動公開撮合資料收集器失敗', { error: err.message });
    }

    // 啟動 HTTP 伺服器
    server.listen(config.port, () => {
        logger.info('server', `✅ 伺服器已啟動，埠號: ${config.port}`);
        logger.info('server', `📊 儀表板: http://localhost:${config.port}`);
    });
}

// 優雅關閉：保留資料庫中的 running／paused，讓下一次啟動自動恢復上次狀態。
process.on('SIGTERM', async () => {
    logger.info('server', '收到 SIGTERM，正在優雅關閉所有放貸機器人...');
    const { shutdownAll } = require('./services/engine/manager');
    const { stopDailyCleanup } = require('./services/analysis/cleanup');
    const { stopFundingTradeCollector } = require('./services/market-summary');
    try {
        stopDailyCleanup();
        stopFundingTradeCollector();
    } catch (err) {}
    await shutdownAll();
    server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
    logger.info('server', '收到 SIGINT，正在優雅關閉所有放貸機器人...');
    const { shutdownAll } = require('./services/engine/manager');
    const { stopDailyCleanup } = require('./services/analysis/cleanup');
    const { stopFundingTradeCollector } = require('./services/market-summary');
    try {
        stopDailyCleanup();
        stopFundingTradeCollector();
    } catch (err) {}
    await shutdownAll();
    server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
    logger.error('server', '未捕獲異常', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
    logger.error('server', '未處理的 Promise 拒絕', { reason: reason?.message || reason });
});

module.exports = { app, server };

if (process.env.NODE_ENV !== 'test') {
    startup();
}
