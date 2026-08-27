const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../utils/logger');
const cron = require('node-cron');

// ============== 多租戶 Telegram Bot 註冊表 ==============
// key = userId, value = { bot: TelegramBot, chatId: string }
const userBots = new Map();

// 系統管理員 Bot (用 .env 設定的全域 Bot，可選)
let adminBot = null;
let adminChatId = null;

/**
 * 初始化系統管理員 Telegram Bot (使用 .env 全域設定)
 * 這是向下相容的管理員通知 Bot，不對應任何特定用戶
 */
function initTelegram() {
    if (!config.telegram.botToken || !config.telegram.chatId) {
        logger.info('telegram', 'Telegram 管理員 Bot 未設定 (SaaS 模式下為選配)，跳過');
        return null;
    }

    try {
        adminBot = new TelegramBot(config.telegram.botToken, { polling: true });
        adminChatId = config.telegram.chatId;
        logger.info('telegram', '✅ 管理員 Telegram Bot 已初始化');

        // 註冊管理員控制面板指令
        setupAdminBotHandlers(adminBot, adminChatId);

        return adminBot;
    } catch (err) {
        logger.error('telegram', '管理員 Telegram Bot 初始化失敗', { error: err.message });
        return null;
    }
}

/**
 * 為特定用戶初始化 Telegram Bot
 * @param {string} userId - 用戶 ID
 * @param {string} botToken - 用戶自訂的 Telegram Bot Token
 * @param {string} chatId - 用戶自訂的 Telegram Chat ID
 */
function initUserTelegram(userId, botToken, chatId) {
    if (!botToken || !chatId) {
        logger.debug('telegram', `用戶 ${userId} 未設定 Telegram Bot，通知功能跳過`);
        return null;
    }

    // 如果該用戶已有 Bot 實例，先停止再重建
    destroyUserTelegram(userId);

    try {
        // 用戶 Bot 使用 polling: false (只用來發送訊息，不監聽指令)
        const bot = new TelegramBot(botToken, { polling: false });
        userBots.set(userId, { bot, chatId });
        logger.info('telegram', `✅ 用戶 ${userId} 的 Telegram Bot 已初始化`);
        return bot;
    } catch (err) {
        logger.error('telegram', `用戶 ${userId} 的 Telegram Bot 初始化失敗`, { error: err.message });
        return null;
    }
}

/**
 * 銷毀特定用戶的 Telegram Bot 實例
 */
function destroyUserTelegram(userId) {
    const entry = userBots.get(userId);
    if (entry) {
        try {
            entry.bot.stopPolling?.();
        } catch (e) { /* ignore */ }
        userBots.delete(userId);
        logger.debug('telegram', `用戶 ${userId} 的 Telegram Bot 已銷毀`);
    }
}

// ============== 核心發送函數（多租戶版）==============

/**
 * 向特定用戶發送 Telegram 訊息
 * 若用戶有自訂 Bot 則用其 Bot 發送，否則嘗試管理員 Bot
 * @param {string} text - 訊息內容 (HTML)
 * @param {string|null} userId - 目標用戶 ID
 */
async function sendMessage(text, userId = null) {
    // 1. 嘗試用該用戶自己的 Bot
    if (userId) {
        const entry = userBots.get(userId);
        if (entry && entry.bot && entry.chatId) {
            try {
                await entry.bot.sendMessage(entry.chatId, text, { parse_mode: 'HTML' });
                return;
            } catch (err) {
                logger.error('telegram', `用戶 ${userId} 的 Telegram 訊息發送失敗`, { error: err.message });
            }
        }
    }

    // 2. Fallback: 使用管理員 Bot
    if (adminBot && adminChatId) {
        try {
            await adminBot.sendMessage(adminChatId, text, { parse_mode: 'HTML' });
        } catch (err) {
            logger.error('telegram', '管理員 Telegram 訊息發送失敗', { error: err.message });
        }
    }
}

/**
 * 發送異常警報
 * @param {string} title - 警報標題
 * @param {string} details - 警報詳情
 * @param {string|null} userId - 目標用戶 ID
 */
async function sendAlert(title, details, userId = null) {
    const msg = `🚨 <b>${title}</b>\n\n${details}\n\n⏰ 警報時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`;
    await sendMessage(msg, userId);
}

/**
 * 🎉 發送成交通知（3D Hybrid 自適應版本）
 * @param {string} currency - 幣種
 * @param {number} amount - 成交金額
 * @param {number} rate - 成交利率
 * @param {number} period - 期限
 * @param {string|null} userId - 目標用戶 ID
 */
async function sendTradeNotification(currency, amount, rate, period, userId = null) {
    const annualRate = rate * 365 * 100;
    const estimatedInterest = amount * rate * period;
    const netEstimatedInterest = estimatedInterest * 0.85; // 扣除 15% 手續費

    const msg = `🎉 <b>放貸合約成交</b>\n\n` +
        `🪙 <b>放貸幣種</b>: ${currency}\n` +
        `💵 <b>成交金額</b>: $${amount.toFixed(2)}\n` +
        `📉 <b>日利率</b>: <b>${(rate * 100).toFixed(4)}%/天</b>\n` +
        `📈 <b>年化利率</b>: <b>${annualRate.toFixed(2)}%</b>\n` +
        `⏳ <b>放貸天數</b>: <b>${period} 天</b>\n` +
        `💰 <b>預估淨利息</b>: <b>$${netEstimatedInterest.toFixed(6)} USD</b> (已扣稅)`;

    await sendMessage(msg, userId);
}

/**
 * 🔄 發送自動降息重掛通知
 * @param {string|null} userId - 目標用戶 ID (最後一個參數)
 */
async function sendReofferNotification(currency, amount, oldRate, newRate, period, isFloor, userId = null) {
    const msg = `🔄 <b>自動降息重掛 (3D Hybrid 時間級聯衰減)</b>\n\n` +
        `⚙️ <b>荷蘭拍衰減機制已觸發</b>，為避免資金閒置，系統已將未成交掛單自動調息重掛。\n\n` +
        `🪙 <b>放貸幣種</b>: ${currency}\n` +
        `💵 <b>掛單金額</b>: $${amount.toFixed(2)}\n` +
        `📉 <b>日利率調降</b>:\n` +
        `  ├─ 原利率: ${(oldRate * 100).toFixed(4)}%/天 (年化 ${(oldRate * 365 * 100).toFixed(2)}%)\n` +
        `  └─ 新利率: ${(newRate * 100).toFixed(4)}%/天 (年化 ${(newRate * 365 * 100).toFixed(2)}%)\n` +
        `⏳ <b>掛單期限</b>: ${period} 天\n` +
        `⏱️ <b>當前狀態</b>: ${isFloor ? '⚠️ 已觸發保底年化 12% 利率，不再調降' : '📉 已進行 4% 衰減優化'}`;

    await sendMessage(msg, userId);
}

/**
 * 📊 發送 3D Hybrid 每日放貸營運總結
 * 多租戶版本：遍歷所有有 Telegram 設定的活躍用戶
 */
async function sendDailySummary() {
    const db = require('./database');
    const { getBot } = require('./engine/manager');
    const { getStrategyEngine } = require('./engine/strategy');
    const { getBitfinexPublicWS } = require('./bitfinex/ws');
    const strategy = getStrategyEngine();
    const publicWs = getBitfinexPublicWS();

    // 收集所有需要發送摘要的 targets: (userId, engine)
    const targets = [];

    // 1. 所有有 Telegram Bot 的活躍用戶
    for (const [userId] of userBots) {
        const engine = getBot(userId);
        if (engine) {
            targets.push({ userId, engine });
        }
    }

    // 2. 若無任何用戶目標但有管理員 Bot，發送管理員全域摘要
    if (targets.length === 0 && adminBot && adminChatId) {
        const summaryMsg = await buildGlobalSummaryMessage(strategy, publicWs, db);
        try {
            await adminBot.sendMessage(adminChatId, summaryMsg, { parse_mode: 'HTML' });
        } catch (err) {
            logger.error('telegram', '管理員每日摘要發送失敗', { error: err.message });
        }
        return;
    }

    // 3. 為每位有 Telegram 的活躍用戶發送個人摘要
    for (const { userId, engine } of targets) {
        try {
            // 發送摘要前強制同步一次放貸利息收益
            const { syncUserEarnings } = require('./engine/sync');
            await syncUserEarnings(userId, true);

            const msg = await buildUserSummaryMessage(userId, engine, strategy, publicWs, db);
            await sendMessage(msg, userId);
        } catch (err) {
            logger.error('telegram', `用戶 ${userId} 每日摘要發送失敗`, { error: err.message });
        }
    }

    logger.info('telegram', `🌌 3D Hybrid 每日營運總結已發送 (${targets.length} 位用戶)`);
}

/**
 * 組合特定用戶的每日摘要訊息
 */
async function buildUserSummaryMessage(userId, engine, strategy, publicWs, db) {
    const status = engine.getDetailedStatus();
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    // 為了防範伺服器時區差異，採用亞洲/台北時區 (UTC+8) 作為結算基準
    const taipeiOffset = 8 * 60 * 60 * 1000;
    const nowTaipei = new Date(Date.now() + taipeiOffset);
    const todayStart = new Date(Date.UTC(nowTaipei.getUTCFullYear(), nowTaipei.getUTCMonth(), nowTaipei.getUTCDate()));
    todayStart.setTime(todayStart.getTime() - taipeiOffset);

    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

    const [todayEarnings, yesterdayEarnings, allEarnings] = await Promise.all([
        db.getEarnings(null, todayStart.toISOString(), null, userId),
        db.getEarnings(null, yesterdayStart.toISOString(), todayStart.toISOString(), userId),
        db.getEarnings(null, null, null, userId),
    ]);

    function sumAmount(rows) {
        return rows.reduce((s, r) => s + (r.amount || 0), 0);
    }

    const todayTotal = sumAmount(todayEarnings);
    const yesterdayTotal = sumAmount(yesterdayEarnings);
    const allTimeTotal = sumAmount(allEarnings);

    let changeText = '';
    if (yesterdayTotal > 0) {
        const pct = ((todayTotal - yesterdayTotal) / yesterdayTotal * 100).toFixed(1);
        changeText = pct > 0 ? ` (+${pct}% 📈)` : ` (${pct}% 📉)`;
    } else if (todayTotal > 0) {
        changeText = ' (🚀)';
    }

    let msg = `📊 <b>每日放貸營運總結</b>\n`;
    msg += `📅 統計時間: <code>${now}</code>\n\n`;

    // 1. 收益回報統計
    msg += `💰 <b>量化收益回報 (已扣稅)</b>\n`;
    msg += `  ├─ 今日收益: <b>$${todayTotal.toFixed(4)} USD</b>${changeText}\n`;
    msg += `  ├─ 昨日收益: <b>$${yesterdayTotal.toFixed(4)} USD</b>\n`;
    msg += `  └─ 累計收益: <b>$${allTimeTotal.toFixed(4)} USD</b>\n\n`;

    // 2. 各幣種錢包與放貸水位
    msg += `💳 <b>資產與放貸水位</b>\n`;
    for (const cur of Object.keys(status.wallets)) {
        const wallet = status.wallets[cur] || { balance: 0, available: 0 };
        const offersCount = Array.isArray(status.activeOffers[cur]) ? status.activeOffers[cur].length : (status.activeOffers[cur] || 0);
        const creditsCount = Array.isArray(status.activeCredits[cur]) ? status.activeCredits[cur].length : (status.activeCredits[cur] || 0);
        msg += `  <b>${cur} 資產</b>:\n`;
        msg += `  ├─ 錢包總額: $${wallet.balance.toFixed(2)}\n`;
        msg += `  ├─ 可用餘額: $${wallet.available.toFixed(2)}\n`;
        msg += `  └─ 進行中合約: 掛單 ${offersCount} 筆 | 貸款中 ${creditsCount} 筆\n`;
    }

    return msg;
}

/**
 * 組合全域管理員摘要訊息 (無特定用戶)
 */
async function buildGlobalSummaryMessage(strategy, publicWs, db) {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    let msg = `🌌 <b>3D Hybrid 系統管理員每日摘要</b>\n`;
    msg += `📅 統計時間: <code>${now}</code>\n\n`;

    for (const cur of ['USD', 'USDT']) {
        const md = publicWs.getMarketData(cur);
        if (!md) continue;
        const currentFRR = md.frr ? `${(md.frr * 100).toFixed(4)}%/天` : '—';
        const avg7d = strategy.historicalFRR[cur]?.['7d'] ? `${(strategy.historicalFRR[cur]['7d'] * 100).toFixed(4)}%` : '—';
        msg += `📊 <b>${cur} 市場</b>: FRR ${currentFRR} | 7d 均值 ${avg7d}\n`;
    }

    msg += `\n👥 活躍用戶 Telegram Bot: ${userBots.size} 個`;
    return msg;
}

// ============== 管理員 Bot 指令處理 ==============

/**
 * 設定管理員 Bot 的指令處理器
 * 管理員 Bot 使用 getLendingEngine singleton 作為向下相容層
 */
function setupAdminBotHandlers(bot, authorizedChatId) {
    if (!bot) return;

    // 自動註冊指令選單到 Telegram
    bot.setMyCommands([
        { command: 'control', description: '喚出互動控制面板' },
        { command: 'status', description: '查詢放貸核心與收益狀態' },
        { command: 'help', description: '顯示操作說明與指令清單' }
    ]).catch(err => logger.error('telegram', '設定 Bot 指令選單失敗', { error: err.message }));

    function isAuthorized(msg) {
        const chatId = msg.chat.id.toString();
        if (chatId !== authorizedChatId?.toString()) {
            logger.warn('telegram', `⚠️ 收到未授權用戶的指令！ChatID: ${chatId}, 用戶名: ${msg.from?.username || 'unknown'}`);
            bot.sendMessage(chatId, '🚷 <b>權限不足</b>\n您無權操控此放貸機器人。', { parse_mode: 'HTML' }).catch(() => {});
            return false;
        }
        return true;
    }

    function isCallbackAuthorized(query) {
        const chatId = query.message.chat.id.toString();
        if (chatId !== authorizedChatId?.toString()) {
            logger.warn('telegram', `⚠️ 收到未授權用戶的按鈕點擊！ChatID: ${chatId}, 用戶名: ${query.from?.username || 'unknown'}`);
            bot.answerCallbackQuery(query.id, { text: '🚷 權限不足，拒絕操作！', show_alert: true }).catch(() => {});
            return false;
        }
        return true;
    }

    // `/start` 指令
    bot.onText(/\/start/, (msg) => {
        if (!isAuthorized(msg)) return;
        const welcome = `👋 <b>歡迎使用 Bitfinex 放貸機器人控制終端</b>\n\n` +
            `本機器人已啟用雙向即時長輪詢監聽 (Long Polling)，您可以隨時在此操控您的 3D Hybrid 自適應放貸策略。\n\n` +
            `⌨️ <b>可用指令</b>:\n` +
            `• <code>/control</code> - 喚出互動控制面板\n` +
            `• <code>/status</code> - 查詢放貸核心與收益狀態\n` +
            `• <code>/help</code> - 顯示操作說明與指令清單`;
        bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' }).catch(() => {});
    });

    // `/help` 指令
    bot.onText(/\/help/, (msg) => {
        if (!isAuthorized(msg)) return;
        const helpText = `📖 <b>放貸機器人操作指南</b>\n\n` +
            `🤖 <b>指令清單</b>:\n` +
            `• <code>/control</code> - 開啟視覺化控制面板。您可以一鍵切換複利、自動劃轉、暫停或恢復放貸，或者執行緊急避險撤單。\n` +
            `• <code>/status</code> - 即時查詢當前各幣種餘額、放貸中合約筆數、最新年化利率、以及今日/昨日/累計淨收益。\n\n` +
            `🛡️ <b>安全提示</b>:\n` +
            `• 本終端僅限管理員 Chat ID 操控，其他任何人均無法存取，請放心使用。`;
        bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' }).catch(() => {});
    });

    // `/status` 指令
    bot.onText(/\/status/, async (msg) => {
        if (!isAuthorized(msg)) return;
        try {
            const db = require('./database');
            const { getBot } = require('./engine/manager');
            const { getStrategyEngine } = require('./engine/strategy');
            const { getBitfinexPublicWS } = require('./bitfinex/ws');
            
            const strategy = getStrategyEngine();
            const publicWs = getBitfinexPublicWS();
            const activeUserIds = await db.getActiveUsers();
            
            if (activeUserIds.length > 0) {
                let report = '';
                for (const userId of activeUserIds) {
                    const engine = getBot(userId);
                    if (engine) {
                        const userReport = await buildUserSummaryMessage(userId, engine, strategy, publicWs, db);
                        report += userReport + '\n';
                    }
                }
                bot.sendMessage(msg.chat.id, report, { parse_mode: 'HTML' }).catch(() => {});
            } else {
                const summaryMsg = await buildGlobalSummaryMessage(strategy, publicWs, db);
                bot.sendMessage(msg.chat.id, summaryMsg, { parse_mode: 'HTML' }).catch(() => {});
            }
        } catch (err) {
            bot.sendMessage(msg.chat.id, `❌ 查詢狀態失敗: ${err.message}`).catch(() => {});
        }
    });

    // `/control` 指令
    bot.onText(/\/control/, (msg) => {
        if (!isAuthorized(msg)) return;
        sendAdminControlPanel(bot, msg.chat.id);
    });

    // 按鈕 Callback Query 監聽
    bot.on('callback_query', async (query) => {
        if (!isCallbackAuthorized(query)) return;

        const action = query.data;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        const { getBot } = require('./engine/manager');
        
        const dbSettings = await getSettingsByChatId(chatId);
        const userId = dbSettings?.user_id || null;
        
        if (!userId) {
            await bot.answerCallbackQuery(query.id, { text: '❌ 找不到您的使用者帳戶設定！', show_alert: true });
            return;
        }

        const engine = getBot(userId);

        try {
            switch (action) {
                case 'toggle_compounding': {
                    if (engine) {
                        const nextVal = !engine.compoundingEnabled;
                        engine.setCompounding(nextVal);
                        await db.saveUserSettings(userId, { compounding_enabled: nextVal });
                        await bot.answerCallbackQuery(query.id, { text: `♻️ 複利滾投已變更為: ${nextVal ? '開啟' : '關閉'}` });
                    } else {
                        const nextVal = !(dbSettings?.compounding_enabled !== false);
                        await db.saveUserSettings(userId, { compounding_enabled: nextVal });
                        await bot.answerCallbackQuery(query.id, { text: `♻️ 複利設定已變更為: ${nextVal ? '開啟' : '關閉'} (將在啟動時套用)` });
                    }
                    await updateAdminControlPanel(bot, chatId, messageId);
                    break;
                }
                case 'toggle_autotransfer': {
                    if (engine) {
                        const nextVal = !engine.autoTransferEnabled;
                        engine.setAutoTransfer(nextVal, engine.autoTransferThreshold);
                        await db.saveUserSettings(userId, { auto_transfer_enabled: nextVal });
                        await bot.answerCallbackQuery(query.id, { text: `🔄 自動劃轉已變更為: ${nextVal ? '開啟' : '關閉'}` });
                    } else {
                        const nextVal = !(dbSettings?.auto_transfer_enabled || false);
                        await db.saveUserSettings(userId, { auto_transfer_enabled: nextVal });
                        await bot.answerCallbackQuery(query.id, { text: `🔄 劃轉設定已變更為: ${nextVal ? '開啟' : '關閉'} (將在啟動時套用)` });
                    }
                    await updateAdminControlPanel(bot, chatId, messageId);
                    break;
                }
                case 'pause_engine': {
                    if (engine) {
                        engine.pause('Telegram 手動暫停');
                        await db.saveUserSettings(userId, { paused: true, pause_reason: 'Telegram 手動暫停' });
                        await bot.answerCallbackQuery(query.id, { text: '⏸️ 自動放貸已暫停' });
                    } else {
                        await bot.answerCallbackQuery(query.id, { text: '⚠️ 機器人未在運行中，無法暫停' });
                    }
                    await updateAdminControlPanel(bot, chatId, messageId);
                    break;
                }
                case 'resume_engine': {
                    if (engine) {
                        engine.resume();
                        await db.saveUserSettings(userId, { paused: false });
                        await bot.answerCallbackQuery(query.id, { text: '▶️ 自動放貸已恢復' });
                    } else {
                        // 如果未啟動，則呼叫 startBot 啟動它！
                        await bot.answerCallbackQuery(query.id, { text: '🚀 正在啟動放貸機器人...' });
                        await startBot(userId);
                    }
                    await updateAdminControlPanel(bot, chatId, messageId);
                    break;
                }
                case 'get_diagnostics': {
                    await bot.answerCallbackQuery(query.id, { text: '📊 正在獲取 3D Hybrid 決策診斷...' });
                    await sendAdminDetailedDiagnostics(bot, chatId);
                    break;
                }
                case 'emergency_stop': {
                    const confirmKeyboard = {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '🚨 確認緊急撤單並暫停！', callback_data: 'confirm_emergency' },
                                    { text: '❌ 點錯了，返回選單', callback_data: 'cancel_emergency' }
                                ]
                            ]
                        }
                    };
                    await bot.editMessageText('⚠️ <b>🚨 安全確認</b>\n\n您即將執行<b>緊急避險操作</b>。系統將立刻嘗試撤銷所有 Bitfinex 上掛著的放貸訂單，並暫停引擎！\n\n您確定要繼續嗎？', {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML',
                        ...confirmKeyboard
                    });
                    break;
                }
                case 'confirm_emergency': {
                    if (engine) {
                        await bot.answerCallbackQuery(query.id, { text: '🚨 正在執行緊急避險，撤銷掛單中...' });
                        await engine.emergencyStop();
                        await db.saveUserSettings(userId, { paused: true, pause_reason: '緊急避險暫停' });
                        await bot.editMessageText('🚨 <b>緊急避險已完成</b>\n\n系統已取消所有掛單，且放貸核心引擎已設定為<b>緊急暫停狀態</b>。\n\n如需重新啟動，請再次使用下方控制面板。', {
                            chat_id: chatId,
                            message_id: messageId,
                            parse_mode: 'HTML'
                        });
                    } else {
                        await bot.answerCallbackQuery(query.id, { text: '⚠️ 機器人未在運行中，無法執行避險' });
                    }
                    setTimeout(() => {
                        sendAdminControlPanel(bot, chatId);
                    }, 3000);
                    break;
                }
                case 'cancel_emergency': {
                    await bot.answerCallbackQuery(query.id, { text: '取消操作' });
                    await updateAdminControlPanel(bot, chatId, messageId);
                    break;
                }
                default:
                    await bot.answerCallbackQuery(query.id, { text: '未知的指令' });
            }
        } catch (err) {
            logger.error('telegram', '處理 Callback Query 失敗', { error: err.message });
            bot.answerCallbackQuery(query.id, { text: `❌ 執行失敗: ${err.message}`, show_alert: true }).catch(() => {});
        }
    });

    // 🌟 每日放貸摘要排程（每晚 23:55 台北時間）
    cron.schedule('55 23 * * *', () => {
        logger.info('telegram', '⏰ 觸發每日放貸摘要定時任務...');
        sendDailySummary().catch(err => {
            logger.error('telegram', '定時發送每日摘要失敗', { error: err.message });
        });
    }, {
        timezone: "Asia/Taipei"
    });
    logger.info('telegram', '📅 已註冊每日放貸摘要排程 (每晚 23:55 台北時間)');
}

// ============== 管理員控制面板輔助函數 ==============

async function getSettingsByChatId(chatId) {
    try {
        const db = require('./database');
        const supabase = db.getSupabase();
        if (!supabase) return null;
        
        // 優先使用 telegram_chat_id 進行精確匹配
        const { data } = await supabase.from('user_bot_settings')
            .select('*')
            .or(`telegram_chat_id.eq.${chatId},telegram_chat_id.eq.${chatId.toString()}`)
            .limit(1);
            
        if (data && data.length > 0) {
            return data[0];
        }
        
        // 如果找不到匹配的 chat_id，則回退到獲取資料庫中的第一個帳戶設定（保證向下相容單用戶）
        const { data: firstSettings } = await supabase.from('user_bot_settings').select('*').limit(1);
        return firstSettings?.[0] || null;
    } catch {
        return null;
    }
}

async function sendAdminControlPanel(bot, chatId) {
    if (!bot) return;
    try {
        const { getBot } = require('./engine/manager');
        
        const dbSettings = await getSettingsByChatId(chatId);
        const userId = dbSettings?.user_id || null;
        
        const engine = userId ? getBot(userId) : null;

        const panelText = getControlPanelText(engine, dbSettings);
        const keyboard = getControlPanelKeyboard(engine, dbSettings);

        bot.sendMessage(chatId, panelText, {
            parse_mode: 'HTML',
            ...keyboard
        }).catch(() => {});
    } catch (err) {
        logger.error('telegram', '發送控制面板失敗', { error: err.message });
        bot.sendMessage(chatId, `❌ 無法開啟控制面板: ${err.message}`).catch(() => {});
    }
}

async function updateAdminControlPanel(bot, chatId, messageId) {
    if (!bot) return;
    try {
        const { getBot } = require('./engine/manager');
        
        const dbSettings = await getSettingsByChatId(chatId);
        const userId = dbSettings?.user_id || null;
        
        const engine = userId ? getBot(userId) : null;

        const panelText = getControlPanelText(engine, dbSettings);
        const keyboard = getControlPanelKeyboard(engine, dbSettings);

        await bot.editMessageText(panelText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            ...keyboard
        });
    } catch (err) {
        if (!err.message.includes('message is not modified')) {
            logger.error('telegram', '更新控制面板失敗', { error: err.message });
        }
    }
}

function getControlPanelText(engine, dbSettings = null) {
    const compoundingEnabled = engine ? engine.compoundingEnabled : dbSettings?.compounding_enabled !== false;
    const autoTransferEnabled = engine ? engine.autoTransferEnabled : dbSettings?.auto_transfer_enabled || false;
    const autoTransferThreshold = engine ? engine.autoTransferThreshold : dbSettings?.auto_transfer_threshold || 500;
    
    const compounding = compoundingEnabled ? '開啟 ♻️' : '關閉 ⏸️';
    const autoTransfer = autoTransferEnabled ? `開啟 🔄 ($${autoTransferThreshold})` : '關閉 ⏹️';

    let engineStatus = '⏹️ 已停止';
    if (engine && engine.running) {
        engineStatus = engine.paused ? `⏸️ 已暫停 (${engine.pauseReason})` : '✅ 運作中';
    } else if (dbSettings && dbSettings.status === 'running') {
        engineStatus = '✅ 運作中 (背景恢復中)';
    }

    return `🌌 <b>3D Hybrid 放貸核心控制面板</b>\n\n` +
        `當前放貸引擎與策略設定：\n` +
        `──────────────────────\n` +
        `⚙️ <b>引擎狀態</b>: <b>${engineStatus}</b>\n` +
        `🧠 <b>目前策略</b>: <code>3D_Hybrid</code>\n` +
        `♻️ <b>複利滾投</b>: <b>${compounding}</b>\n` +
        `🔄 <b>自動劃轉</b>: <b>${autoTransfer}</b>\n` +
        `──────────────────────\n` +
        `請點擊下方按鈕進行即時變更：`;
}

function getControlPanelKeyboard(engine, dbSettings = null) {
    const compoundingEnabled = engine ? engine.compoundingEnabled : dbSettings?.compounding_enabled !== false;
    const autoTransferEnabled = engine ? engine.autoTransferEnabled : dbSettings?.auto_transfer_enabled || false;
    const isPaused = engine ? engine.paused : true;
    const isRunning = engine ? engine.running : false;

    const compoundingLabel = compoundingEnabled ? '♻️ 關閉複利滾投' : '♻️ 開啟複利滾投';
    const autoTransferLabel = autoTransferEnabled ? '🔄 關閉自動劃轉' : '🔄 開啟自動劃轉';

    const pauseOrResumeBtn = (!isRunning)
        ? { text: '▶️ 啟動自動放貸', callback_data: 'resume_engine' }
        : (isPaused
            ? { text: '▶️ 恢復自動放貸', callback_data: 'resume_engine' }
            : { text: '⏸️ 暫停自動放貸', callback_data: 'pause_engine' });

    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: compoundingLabel, callback_data: 'toggle_compounding' },
                    { text: autoTransferLabel, callback_data: 'toggle_autotransfer' }
                ],
                [
                    pauseOrResumeBtn,
                    { text: '📊 即時決策診斷', callback_data: 'get_diagnostics' }
                ],
                [
                    { text: '🚨 緊急撤單與避險', callback_data: 'emergency_stop' }
                ]
            ]
        }
    };
}

/**
 * 發送管理員用的詳細決策診斷
 */
async function sendAdminDetailedDiagnostics(bot, chatId) {
    if (!bot) return;
    try {
        const { getBot } = require('./engine/manager');
        const { getBitfinexPublicWS } = require('./bitfinex/ws');
        
        const publicWs = getBitfinexPublicWS();
        const dbSettings = await getSettingsByChatId(chatId);
        const userId = dbSettings?.user_id || null;
        
        const engine = userId ? getBot(userId) : null;
        if (!engine) {
            bot.sendMessage(chatId, '⚠️ <b>放貸機器人目前未在運行中，無法獲取決策診斷。</b>', { parse_mode: 'HTML' }).catch(() => {});
            return;
        }
        
        const status = engine.getDetailedStatus();

        let diagText = `📊 <b>3D Hybrid 決策診斷即時反饋</b>\n`;
        diagText += `⏰ 查詢時間: <code>${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</code>\n\n`;

        for (const cur of ['USD', 'USDT']) {
            const lastDec = status.lastDecision?.[cur];
            if (!lastDec) {
                diagText += `🪙 <b>${cur}</b>: 目前無決策記錄（等待下個週期）\n\n`;
                continue;
            }

            const opt = lastDec.optimalResult || {};
            const diag = opt.diagnostics || {};

            const frr = diag.frr ? `${(diag.frr * 100).toFixed(4)}%` : '—';
            const equilibrium = diag.equilibriumRate ? `${(diag.equilibriumRate * 100).toFixed(4)}%` : '—';
            const finalRate = diag.finalRate ? `${(diag.finalRate * 100).toFixed(4)}%` : '—';
            const dsRatio = diag.demandSupplyRatio ? diag.demandSupplyRatio.toFixed(2) : '—';
            const frrAnnualized = diag.frr ? `${(diag.frr * 365 * 100).toFixed(2)}%` : '—';

            diagText += `🪙 <b>${cur} 自適應指標</b>:\n`;
            diagText += `  ├─ 當前 FRR: <code>${frr}</code> (年化 ${frrAnnualized})\n`;
            diagText += `  ├─ 瓦爾拉斯出清: <code>${equilibrium}</code>\n`;
            diagText += `  ├─ 最終掛單基準: <b>${finalRate}</b>\n`;
            diagText += `  ├─ 真實供需比: <code>${dsRatio}</code>\n`;
            diagText += `  ├─ 巨牆偵測: ${diag.wallDetected ? `⚠️ 偵測到阻力牆 (${((diag.wallRate || 0) * 100).toFixed(4)}%/天)，已觸發避讓前置掛單` : '🟢 通暢'}\n`;

            if (opt.orders && opt.orders.length > 0) {
                diagText += `  └─ <b>當前 3D Grid 拆單計劃</b>:\n`;
                opt.orders.forEach((o, i) => {
                    let tag = '底倉 🛡️';
                    if (o.tag === 'grid_depth') tag = '深度探針 🔍';
                    if (o.tag === 'grid_cascade') tag = '天價探針 ⚡';
                    diagText += `     [${i+1}] $${o.amount.toFixed(0)} @ ${(o.rate * 100).toFixed(4)}% (${o.period}天) - ${tag}\n`;
                });
            } else {
                diagText += `  └─ 當前無拆單計劃 (資金已全數放貸中)\n`;
            }
            diagText += `\n`;
        }

        bot.sendMessage(chatId, diagText, { parse_mode: 'HTML' }).catch(() => {});
    } catch (err) {
        logger.error('telegram', '發送決策診斷失敗', { error: err.message });
        bot.sendMessage(chatId, `❌ 無法獲取決策診斷: ${err.message}`).catch(() => {});
    }
}

module.exports = {
    initTelegram,
    initUserTelegram,
    destroyUserTelegram,
    sendMessage,
    sendDailySummary,
    sendAlert,
    sendTradeNotification,
    sendReofferNotification,
    buildUserSummaryMessage,
};
