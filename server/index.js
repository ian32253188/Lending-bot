require('dotenv').config();

const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { isSingleAccount } = require('./config/single-account');
const { createTokenExpiryGuard, getTokenExpiresAt } = require('./utils/jwt-expiry');
const { getTrustedClientIp } = require('./utils/trusted-client-ip');
const { verifySupabaseToken } = require('./services/supabase-auth-fallback');
const logger = require('./utils/logger');
const authMiddleware = require('./middleware/auth');
const { getBitfinexPublicWS } = require('./services/bitfinex/ws');
const { initTelegram, initConfiguredUserTelegram } = require('./services/telegram');
const metrics = require('./services/metrics');

// 路由
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const lendingRoutes = require('./routes/lending');
const researchRoutes = require('./routes/research');

const app = express();
app.set('trust proxy', config.server.trustProxyHops);
const server = http.createServer(app);
const WS_MAX_CLIENTS = 100;
const WS_MAX_PAYLOAD_BYTES = 16 * 1024;
const WS_UNAUTHENTICATED_TIMEOUT_MS = 5_000;
const WS_UNAUTHENTICATED_CLOSE_GRACE_MS = 250;
const WS_MAX_AUTH_ATTEMPTS = 3;

// 中間件
app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});
app.use(express.json());
app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});

// 靜態檔案（前端 build）
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', authMiddleware, dashboardRoutes);
app.use('/api/lending', authMiddleware, lendingRoutes);
app.use('/api/research', authMiddleware, researchRoutes);

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

// 公開 liveness check：只確認程序有回應，不查詢資料庫或揭露帳戶／執行狀態。
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// SPA fallback
app.get('*splat', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
});

// ============== WebSocket 伺服器（前端即時更新）==============

const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    verifyClient: (_info, callback) => {
        if (wss.clients.size >= WS_MAX_CLIENTS) {
            callback(false, 503, 'WebSocket server at capacity');
            return;
        }
        callback(true);
    },
});

wss.on('connection', (ws, req) => {
    logger.info('ws-server', '前端 WebSocket 已連接');

    let authenticated = false;
    let userId = null;
    let statusInterval = null;
    let authExpiryGuard = null;
    let authenticationAttempts = 0;
    let unauthenticatedTimeout = null;
    let unauthenticatedForceClose = null;
    const resetUnauthenticatedTimeout = () => {
        clearTimeout(unauthenticatedTimeout);
        unauthenticatedTimeout = setTimeout(() => {
            if (!authenticated && ws.readyState === 1) {
                ws.close(1008, 'Authentication required');
                unauthenticatedForceClose = setTimeout(() => {
                    if (ws.readyState === 2) ws.terminate();
                }, WS_UNAUTHENTICATED_CLOSE_GRACE_MS);
                unauthenticatedForceClose.unref?.();
            }
        }, WS_UNAUTHENTICATED_TIMEOUT_MS);
    };
    resetUnauthenticatedTimeout();

    const clearAuthState = () => {
        if (statusInterval) clearInterval(statusInterval);
        statusInterval = null;
        if (authExpiryGuard) authExpiryGuard.dispose();
        authExpiryGuard = null;
        authenticated = false;
        userId = null;
    };

    const isSocketAuthorized = () => {
        if (!authenticated || !userId || !authExpiryGuard) return false;
        return authExpiryGuard.isValid();
    };

    ws.on('message', async (raw) => {
        if (ws.readyState !== 1) return;
        try {
            const msg = JSON.parse(raw.toString());

            // 認證
            if (msg.type === 'auth') {
                authenticationAttempts += 1;
                if (authenticationAttempts > WS_MAX_AUTH_ATTEMPTS) {
                    ws.close(1008, 'Too many authentication attempts');
                    return;
                }
                clearAuthState();
                resetUnauthenticatedTimeout();
                if (!msg.token) {
                    ws.send(JSON.stringify({ type: 'auth', status: 'error', message: '缺少認證 Token' }));
                    return;
                }

                const jwt = require('jsonwebtoken');
                const { getBot } = require('./services/engine/manager');
                let verifiedUser = null;
                let verifiedExpiresAt = null;

                try {
                    const decoded = jwt.verify(msg.token, config.jwt.secret);
                    if (decoded?.id) {
                        if (!isSingleAccount(decoded.id)) {
                            ws.send(JSON.stringify({ type: 'auth', status: 'error', message: '此系統僅開放單一管理帳戶' }));
                            return;
                        }
                        const expiresAt = getTokenExpiresAt(msg.token);
                        if (expiresAt === null || expiresAt <= Date.now()) {
                            ws.send(JSON.stringify({ type: 'auth', status: 'error', message: 'Token 無效或已過期' }));
                            return;
                        }
                        verifiedUser = decoded;
                        verifiedExpiresAt = expiresAt;
                    }
                } catch (jwtErr) {}

                const handleAuthSuccess = (userObj, expiresAt) => {
                    if (ws.readyState !== 1) return;
                    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
                        ws.send(JSON.stringify({ type: 'auth', status: 'error', message: 'Token 無效或已過期' }));
                        return;
                    }
                    authenticated = true;
                    userId = userObj.id;
                    clearTimeout(unauthenticatedTimeout);
                    authExpiryGuard = createTokenExpiryGuard(ws, expiresAt);
                    ws.send(JSON.stringify({ type: 'auth', status: 'ok' }));

                    // 開始定期推送該用戶的狀態
                    if (statusInterval) clearInterval(statusInterval);
                    statusInterval = setInterval(() => {
                        if (ws.readyState === 1 && isSocketAuthorized()) {
                            const engine = getBot(userId);
                            if (engine) {
                                ws.send(JSON.stringify({
                                    type: 'status',
                                    data: engine.getStatus(),
                                }));
                            } else {
                                const { getInactiveDashboardStatusForUser } = require('./services/dashboard-status');
                                getInactiveDashboardStatusForUser(userId).then(data => {
                                    if (ws.readyState === 1 && isSocketAuthorized()) {
                                        ws.send(JSON.stringify({ type: 'status', data }));
                                    }
                                }).catch(err => {
                                    logger.error('ws-server', '讀取停止引擎的帳戶狀態失敗', { error: err.message });
                                });
                            }
                        }
                    }, 2000); // 每 2 秒推送
                };

                if (verifiedUser) {
                    handleAuthSuccess(verifiedUser, verifiedExpiresAt);
                    return;
                }

                // 備用：若有 Supabase，嘗試驗證 Supabase Token
                const { getSupabase } = require('./services/database');
                const supabase = getSupabase();
                if (supabase) {
                    const result = await verifySupabaseToken({
                        supabase,
                        token: msg.token,
                        request: { ip: getTrustedClientIp(req, app) },
                    });
                    if (ws.readyState !== 1) return;
                    if (result.rateLimited) {
                        ws.send(JSON.stringify({ type: 'auth', status: 'error', message: '認證請求過多，請稍後再試' }));
                        return;
                    }
                    const { user, error } = result;
                    if (error || !user) {
                        ws.send(JSON.stringify({ type: 'auth', status: 'error', message: 'Token 無效或已過期' }));
                        return;
                    }
                    if (!isSingleAccount(user.id)) {
                        ws.send(JSON.stringify({ type: 'auth', status: 'error', message: '此系統僅開放單一管理帳戶' }));
                        return;
                    }
                    const expiresAt = getTokenExpiresAt(msg.token);
                    if (expiresAt === null || expiresAt <= Date.now()) {
                        ws.send(JSON.stringify({ type: 'auth', status: 'error', message: 'Token 無效或已過期' }));
                        return;
                    }
                    handleAuthSuccess(user, expiresAt);
                    return;
                }

                ws.send(JSON.stringify({ type: 'auth', status: 'error', message: 'Token 無效或已過期' }));
                return;
            }

            if (!authenticated || !userId) {
                ws.close(1008, 'Authentication required');
                return;
            }
            if (!isSocketAuthorized()) return;

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
                        const { getInactiveDashboardStatusForUser } = require('./services/dashboard-status');
                        const accountStatus = await getInactiveDashboardStatusForUser(userId, { detailed: true });
                        if (ws.readyState !== 1 || !isSocketAuthorized()) return;
                        ws.send(JSON.stringify({
                            type: 'detailed',
                            data: {
                                activeOffers: accountStatus.activeOffers,
                                activeCredits: accountStatus.activeCredits,
                                activeLoans: accountStatus.activeCredits,
                                rateHistory: [],
                                logs: [],
                                accountDataAvailable: accountStatus.accountDataAvailable,
                                accountDataUpdatedAt: accountStatus.accountDataUpdatedAt,
                                accountDataError: accountStatus.accountDataError,
                                accountDataErrorCode: accountStatus.accountDataErrorCode,
                            },
                        }));
                    }
                    break;
                }
            }
        } catch (err) {
            if (!authenticated && ws.readyState === 1) {
                ws.close(1007, 'Invalid message');
            }
            logger.error('ws-server', '處理 WebSocket 訊息錯誤', { error: err.message });
        }
    });

    ws.on('close', () => {
        clearTimeout(unauthenticatedTimeout);
        clearTimeout(unauthenticatedForceClose);
        clearAuthState();
        logger.debug('ws-server', '前端 WebSocket 已斷開');
    });
});

// ============== 啟動伺服器 ==============

async function startup() {
    logger.info('server', '🚀 Bitfinex 多用戶 SaaS 放貸平台啟動中...');

    const db = require('./services/database');
    let userSettingsReady = !db.isPostgresConfigured();
    let applicationDataTablesReady = !db.isPostgresConfigured();
    if (db.isPostgresConfigured()) {
        applicationDataTablesReady = await db.ensureApplicationDataTables();
        if (applicationDataTablesReady) {
            logger.info('server', '✅ operation_logs、earnings、funding_offers、funding_loans 資料表已就緒');
        } else {
            logger.error('server', '❌ operation_logs、earnings、funding_offers、funding_loans 初始化失敗');
        }
        userSettingsReady = await db.ensureUserBotSettingsTable();
        if (userSettingsReady) {
            logger.info('server', '✅ user_bot_settings 資料表已就緒');
        } else {
            logger.error('server', '❌ user_bot_settings 資料表初始化失敗；暫停自動恢復引擎');
        }
    }

    if (db.isPostgresConfigured()) {
        const researchReady = await db.ensureResearchTables();
        if (researchReady) logger.info('server', '✅ USD 影子研究資料表已就緒（180 天保留）');
        else logger.error('server', '❌ USD 影子研究資料表初始化失敗');
    }

    // 初始化管理員全域 Telegram Bot (SaaS 模式下為選配，用戶各自的 Bot 在 manager.startBot 中初始化)
    initTelegram();
    if (userSettingsReady) await initConfiguredUserTelegram();

    // 啟動自動恢復程序
    const { autoResumeAll } = require('./services/engine/manager');
    const { startDailyCleanup } = require('./services/analysis/cleanup');
    const { startFundingTradeCollector } = require('./services/market-summary');
    const { startShadowResearch } = require('./services/research/shadow');

    // Keep public USD market capture alive even when the lending account is stopped or unavailable.
    try {
        getBitfinexPublicWS().connect();
    } catch (err) {
        logger.error('server', '啟動公開 USD 行情 WebSocket 失敗', { error: err.message });
    }

    if (userSettingsReady && applicationDataTablesReady) {
        try {
            await autoResumeAll();
        } catch (err) {
            logger.error('server', '放貸引擎自動恢復失敗', { error: err.message });
        }
    } else {
        logger.error('server', '資料表未就緒；暫停自動恢復放貸引擎');
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

    try {
        startShadowResearch();
    } catch (err) {
        logger.error('server', '啟動 USD 影子研究收集器失敗', { error: err.message });
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
    const { stopShadowResearch } = require('./services/research/shadow');
    try {
        stopDailyCleanup();
        stopFundingTradeCollector();
        stopShadowResearch();
    } catch (err) {}
    await shutdownAll();
    server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
    logger.info('server', '收到 SIGINT，正在優雅關閉所有放貸機器人...');
    const { shutdownAll } = require('./services/engine/manager');
    const { stopDailyCleanup } = require('./services/analysis/cleanup');
    const { stopFundingTradeCollector } = require('./services/market-summary');
    const { stopShadowResearch } = require('./services/research/shadow');
    try {
        stopDailyCleanup();
        stopFundingTradeCollector();
        stopShadowResearch();
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
