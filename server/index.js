require('dotenv').config();

const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');
const authMiddleware = require('./middleware/auth');
const { getLendingEngine } = require('./services/engine/lending');
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
    try {
        res.set('Content-Type', metrics.registry.contentType);
        res.end(await metrics.registry.metrics());
    } catch (err) {
        res.status(500).end(err.message);
    }
});

// 健康檢查（不需認證）
app.get('/api/health', (req, res) => {
    const engine = getLendingEngine();
    const status = engine.getStatus();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        running: status.running,
        connected: status.connected,
        timestamp: new Date().toISOString(),
    });
});

// SPA fallback
app.get('/{*splat}', (req, res) => {
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

                const { getSupabase } = require('./services/database');
                const { getBot } = require('./services/engine/manager');
                const supabase = getSupabase();
                if (!supabase) {
                    ws.send(JSON.stringify({ type: 'auth', status: 'error', message: '資料庫模組未初始化' }));
                    return;
                }

                supabase.auth.getUser(msg.token).then(({ data: { user }, error }) => {
                    if (error || !user) {
                        ws.send(JSON.stringify({ type: 'auth', status: 'error', message: 'Token 無效或已過期' }));
                        return;
                    }

                    authenticated = true;
                    userId = user.id;
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
                                ws.send(JSON.stringify({
                                    type: 'status',
                                    data: {
                                        running: false,
                                        connected: false,
                                        wallets: { USD: { balance: 0, available: 0 }, USDT: { balance: 0, available: 0 } },
                                        activeOffers: { USD: 0, USDT: 0 },
                                        activeCredits: { USD: 0, USDT: 0 }
                                    }
                                }));
                            }
                        }
                    }, 2000); // 每 2 秒推送
                }).catch(err => {
                    ws.send(JSON.stringify({ type: 'auth', status: 'error', message: err.message }));
                });
                return;
            }

            if (!authenticated || !userId) {
                ws.send(JSON.stringify({ type: 'error', message: '未認證' }));
                return;
            }

            // 處理其他指令
            switch (msg.type) {
                case 'getDetailed':
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

    // 初始化 Telegram
    initTelegram();

    // 啟動自動恢復程序
    const { autoResumeAll } = require('./services/engine/manager');
    const { startDailyCleanup } = require('./services/analysis/cleanup');

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

    // 啟動 HTTP 伺服器
    server.listen(config.port, () => {
        logger.info('server', `✅ 伺服器已啟動，埠號: ${config.port}`);
        logger.info('server', `📊 儀表板: http://localhost:${config.port}`);
    });
}

// 優雅關閉
process.on('SIGTERM', async () => {
    logger.info('server', '收到 SIGTERM，正在優雅關閉所有放貸機器人...');
    const { shutdownAll } = require('./services/engine/manager');
    await shutdownAll();
    server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
    logger.info('server', '收到 SIGINT，正在優雅關閉所有放貸機器人...');
    const { shutdownAll } = require('./services/engine/manager');
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
