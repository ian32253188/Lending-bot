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
    let statusInterval = null;

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());

            // 認證
            if (msg.type === 'auth') {
                const jwt = require('jsonwebtoken');
                try {
                    jwt.verify(msg.token, config.jwt.secret);
                    authenticated = true;
                    ws.send(JSON.stringify({ type: 'auth', status: 'ok' }));

                    // 開始定期推送狀態
                    statusInterval = setInterval(() => {
                        if (ws.readyState === 1) {
                            const engine = getLendingEngine();
                            ws.send(JSON.stringify({
                                type: 'status',
                                data: engine.getStatus(),
                            }));
                        }
                    }, 2000); // 每 2 秒推送
                } catch {
                    ws.send(JSON.stringify({ type: 'auth', status: 'error' }));
                }
                return;
            }

            if (!authenticated) {
                ws.send(JSON.stringify({ type: 'error', message: '未認證' }));
                return;
            }

            // 處理其他指令
            switch (msg.type) {
                case 'getDetailed':
                    const engine = getLendingEngine();
                    ws.send(JSON.stringify({
                        type: 'detailed',
                        data: engine.getDetailedStatus(),
                    }));
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
    logger.info('server', '🚀 Bitfinex 放貸機器人啟動中...');

    // 初始化 Telegram
    initTelegram();

    // 啟動放貸引擎
    const engine = getLendingEngine();
    try {
        await engine.start();
    } catch (err) {
        logger.error('server', '放貸引擎啟動失敗', { error: err.message });
        logger.info('server', '伺服器將繼續運行，可透過 API 手動啟動引擎');
    }

    // 啟動 HTTP 伺服器
    server.listen(config.port, () => {
        logger.info('server', `✅ 伺服器已啟動，埠號: ${config.port}`);
        logger.info('server', `📊 儀表板: http://localhost:${config.port}`);
    });
}

// 優雅關閉
process.on('SIGTERM', async () => {
    logger.info('server', '收到 SIGTERM，正在優雅關閉...');
    const engine = getLendingEngine();
    await engine.stop();
    server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
    logger.info('server', '收到 SIGINT，正在優雅關閉...');
    const engine = getLendingEngine();
    await engine.stop();
    server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
    logger.error('server', '未捕獲異常', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
    logger.error('server', '未處理的 Promise 拒絕', { reason: reason?.message || reason });
});

startup();
