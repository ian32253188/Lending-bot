const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../utils/logger');
const cron = require('node-cron');

let bot = null;

function initTelegram() {
    if (!config.telegram.botToken || !config.telegram.chatId) {
        logger.warn('telegram', 'Telegram 設定未完成，通知功能停用');
        return null;
    }

    try {
        // 🌟 方案一：啟用 Long Polling (即時雙向監聽)
        bot = new TelegramBot(config.telegram.botToken, { polling: true });
        logger.info('telegram', '✅ Telegram Bot 已初始化 (啟用長輪詢即時監聽 ⚡)');

        // 註冊指令與按鈕監聽器
        setupBotHandlers();

        // 🌟 自動註冊 3D Hybrid 每日放貸摘要排程（每晚 23:55 台北時間）
        cron.schedule('55 23 * * *', () => {
            logger.info('telegram', '⏰ 觸發每日放貸摘要定時任務...');
            sendDailySummary().catch(err => {
                logger.error('telegram', '定時發送每日摘要失敗', { error: err.message });
            });
        }, {
            timezone: "Asia/Taipei"
        });
        logger.info('telegram', '📅 已註冊每日放貸摘要排程 (每晚 23:55 台北時間)');

        return bot;
    } catch (err) {
        logger.error('telegram', '初始化失敗', { error: err.message });
        return null;
    }
}

/**
 * 註冊指令與 Callback 按鈕監聽器
 */
function setupBotHandlers() {
    if (!bot) return;

    // 1. 權限認證過濾器
    function isAuthorized(msg) {
        const chatId = msg.chat.id.toString();
        const authorizedId = config.telegram.chatId?.toString();
        if (chatId !== authorizedId) {
            logger.warn('telegram', `⚠️ 收到未授權用戶的指令！ChatID: ${chatId}, 用戶名: ${msg.from?.username || 'unknown'}`);
            bot.sendMessage(chatId, '🚷 <b>權限不足</b>\n您無權操控此放貸機器人。', { parse_mode: 'HTML' }).catch(() => {});
            return false;
        }
        return true;
    }

    function isCallbackAuthorized(query) {
        const chatId = query.message.chat.id.toString();
        const authorizedId = config.telegram.chatId?.toString();
        if (chatId !== authorizedId) {
            logger.warn('telegram', `⚠️ 收到未授權用戶的按鈕點擊！ChatID: ${chatId}, 用戶名: ${query.from?.username || 'unknown'}`);
            bot.answerCallbackQuery(query.id, { text: '🚷 權限不足，拒絕操作！', show_alert: true }).catch(() => {});
            return false;
        }
        return true;
    }

    // 2. `/start` 指令
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

    // 3. `/help` 指令
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

    // 4. `/status` 指令 - 快速卡片回報
    bot.onText(/\/status/, async (msg) => {
        if (!isAuthorized(msg)) return;
        try {
            await sendDailySummary(); // 直接觸發一次當前最新的精美狀態總結卡片
        } catch (err) {
            bot.sendMessage(msg.chat.id, `❌ 查詢狀態失敗: ${err.message}`).catch(() => {});
        }
    });

    // 5. `/control` 指令 - 控制面板
    bot.onText(/\/control/, (msg) => {
        if (!isAuthorized(msg)) return;
        sendControlPanel(msg.chat.id);
    });

    // 6. 按鈕 Callback Query 監聽
    bot.on('callback_query', async (query) => {
        if (!isCallbackAuthorized(query)) return;

        const action = query.data;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        const { getLendingEngine } = require('./engine/lending');
        const engine = getLendingEngine();

        try {
            switch (action) {
                case 'toggle_compounding': {
                    const nextVal = !engine.compoundingEnabled;
                    engine.setCompounding(nextVal);
                    await bot.answerCallbackQuery(query.id, { text: `♻️ 複利滾投已變更為: ${nextVal ? '開啟' : '關閉'}` });
                    await updateControlPanelMessage(chatId, messageId);
                    break;
                }
                case 'toggle_autotransfer': {
                    const nextVal = !engine.autoTransferEnabled;
                    engine.setAutoTransfer(nextVal, engine.autoTransferThreshold);
                    await bot.answerCallbackQuery(query.id, { text: `🔄 自動劃轉已變更為: ${nextVal ? '開啟' : '關閉'}` });
                    await updateControlPanelMessage(chatId, messageId);
                    break;
                }
                case 'pause_engine': {
                    engine.pause('Telegram 手動暫停');
                    await bot.answerCallbackQuery(query.id, { text: '⏸️ 自動放貸已暫停' });
                    await updateControlPanelMessage(chatId, messageId);
                    break;
                }
                case 'resume_engine': {
                    engine.resume();
                    await bot.answerCallbackQuery(query.id, { text: '▶️ 自動放貸已恢復' });
                    await updateControlPanelMessage(chatId, messageId);
                    break;
                }
                case 'get_diagnostics': {
                    await bot.answerCallbackQuery(query.id, { text: '📊 正在獲取 3D Hybrid 決策診斷...' });
                    await sendDetailedDiagnostics(chatId);
                    break;
                }
                case 'emergency_stop': {
                    // 🚨 雙重確認安全選單
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
                    await bot.answerCallbackQuery(query.id, { text: '🚨 正在執行緊急避險，撤銷掛單中...' });
                    await engine.emergencyStop();
                    await bot.editMessageText('🚨 <b>緊急避險已完成</b>\n\n系統已取消所有掛單，且放貸核心引擎已設定為<b>緊急暫停狀態</b>。\n\n如需重新啟動，請再次使用下方控制面板。', {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML'
                    });
                    // 延遲 3 秒後重新送出主控制面板
                    setTimeout(() => {
                        sendControlPanel(chatId);
                    }, 3000);
                    break;
                }
                case 'cancel_emergency': {
                    await bot.answerCallbackQuery(query.id, { text: '取消操作' });
                    await updateControlPanelMessage(chatId, messageId);
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
}

/**
 * 送出主控制面板
 */
function sendControlPanel(chatId) {
    if (!bot) return;
    const { getLendingEngine } = require('./engine/lending');
    const engine = getLendingEngine();
    
    const panelText = getControlPanelText(engine);
    const keyboard = getControlPanelKeyboard(engine);

    bot.sendMessage(chatId, panelText, {
        parse_mode: 'HTML',
        ...keyboard
    }).catch(() => {});
}

/**
 * 更新現有的控制面板訊息
 */
async function updateControlPanelMessage(chatId, messageId) {
    if (!bot) return;
    const { getLendingEngine } = require('./engine/lending');
    const engine = getLendingEngine();

    const panelText = getControlPanelText(engine);
    const keyboard = getControlPanelKeyboard(engine);

    try {
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

/**
 * 組合控制面板文字
 */
function getControlPanelText(engine) {
    const compounding = engine.compoundingEnabled ? '開啟 ♻️' : '關閉 ⏸️';
    const autoTransfer = engine.autoTransferEnabled ? `開啟 🔄 ($${engine.autoTransferThreshold})` : '關閉 ⏹️';
    
    let engineStatus = '⏹️ 已停止';
    if (engine.running) {
        engineStatus = engine.paused ? `⏸️ 已暫停 (${engine.pauseReason})` : '✅ 運作中';
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

/**
 * 組合控制面板鍵盤
 */
function getControlPanelKeyboard(engine) {
    const compoundingLabel = engine.compoundingEnabled ? '♻️ 關閉複利滾投' : '♻️ 開啟複利滾投';
    const autoTransferLabel = engine.autoTransferEnabled ? '🔄 關閉自動劃轉' : '🔄 開啟自動劃轉';
    
    const pauseOrResumeBtn = engine.paused
        ? { text: '▶️ 恢復自動放貸', callback_data: 'resume_engine' }
        : { text: '⏸️ 暫停自動放貸', callback_data: 'pause_engine' };

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
 * 發送詳細的 3D Hybrid 決策診斷卡片
 */
async function sendDetailedDiagnostics(chatId) {
    if (!bot) return;
    const { getLendingEngine } = require('./engine/lending');
    const engine = getLendingEngine();
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
        
        diagText += `🪙 <b>${cur} 自適應指標</b>:\n`;
        diagText += `  ├─ 當前 FRR: <code>${frr}</code> (年化 ${(diag.frr * 365 * 100).toFixed(2)}%)\n`;
        diagText += `  ├─ 瓦爾拉斯出清: <code>${equilibrium}</code>\n`;
        diagText += `  ├─ 最終掛單基準: <b>${finalRate}</b>\n`;
        diagText += `  ├─ 真實供需比: <code>${dsRatio}</code>\n`;
        diagText += `  ├─ 巨牆偵測: ${diag.wallDetected ? `⚠️ 偵測到阻力牆 (${(diag.wallRate * 100).toFixed(4)}%/天)，已觸發避讓前置掛單` : '🟢 通暢'}\n`;
        
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
}

/**
 * 發送訊息（基礎底層）
 */
async function sendMessage(text) {
    if (!bot || !config.telegram.chatId) return;
    try {
        await bot.sendMessage(config.telegram.chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
        logger.error('telegram', '發送訊息失敗', { error: err.message });
    }
}

/**
 * 📊 發送 3D Hybrid 每日放貸營運總結
 */
async function sendDailySummary() {
    const { getLendingEngine } = require('./engine/lending');
    const { getStrategyEngine } = require('./engine/strategy');
    const db = require('./database');
    const engine = getLendingEngine();
    const strategy = getStrategyEngine();
    const status = engine.getDetailedStatus(); // 獲取包含決策診斷的詳細狀態

    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    // 取得今日與昨日的收益
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    const [todayEarnings, yesterdayEarnings, allEarnings] = await Promise.all([
        db.getEarnings(null, todayStart.toISOString(), null),
        db.getEarnings(null, yesterdayStart.toISOString(), todayStart.toISOString()),
        db.getEarnings(null, null, null),
    ]);

    function sumAmount(rows) {
        return rows.reduce((s, r) => s + (r.amount || 0), 0);
    }

    const todayTotal = sumAmount(todayEarnings);
    const yesterdayTotal = sumAmount(yesterdayEarnings);
    const allTimeTotal = sumAmount(allEarnings);
    
    // 計算日增長率
    let changeText = '—';
    if (yesterdayTotal > 0) {
        const pct = ((todayTotal - yesterdayTotal) / yesterdayTotal * 100).toFixed(1);
        changeText = pct > 0 ? `+${pct}% 📈` : `${pct}% 📉`;
    } else if (todayTotal > 0) {
        changeText = '新收益 🚀';
    }

    let msg = `🌌 <b>3D Hybrid 放貸每日營運總結</b>\n`;
    msg += `📅 統計時間: <code>${now}</code>\n\n`;

    // 1. 系統核心與特性狀態
    msg += `🤖 <b>核心調配狀態</b>\n`;
    msg += `  ├─ 引擎運作: ${status.running ? '✅ 運作中' : '⏹️ 已停止'}`;
    if (status.paused) msg += ` (暫停: ${status.pauseReason})`;
    msg += `\n`;
    msg += `  ├─ 複利滾投: ${status.features?.compounding ? 'ON ♻️' : 'OFF ⏸️'}\n`;
    msg += `  ├─ 自動轉帳: ${status.features?.autoTransfer ? `ON 🔄 (門檻 $${status.features.autoTransferThreshold})` : 'OFF ⏹️'}\n`;
    msg += `  └─ 放貸策略: 🧠 <b>3D_Hybrid (三維自適應)</b>\n\n`;

    // 2. 收益回報統計 (扣稅後)
    msg += `💰 <b>量化收益回報 (已扣 15% 稅)</b>\n`;
    msg += `  ├─ 今日收益: <b>$${todayTotal.toFixed(4)} USD</b> (${changeText})\n`;
    msg += `  ├─ 昨日收益: $${yesterdayTotal.toFixed(4)} USD\n`;
    msg += `  └─ 累計收益: <b>$${allTimeTotal.toFixed(4)} USD</b> 🏆\n\n`;

    // 3. 各幣種錢包與放貸水位
    msg += `💳 <b>資產與放貸水位</b>\n`;
    for (const cur of Object.keys(status.wallets)) {
        const wallet = status.wallets[cur] || { balance: 0, available: 0 };
        const offersCount = Array.isArray(status.activeOffers[cur]) ? status.activeOffers[cur].length : (status.activeOffers[cur] || 0);
        const creditsCount = Array.isArray(status.activeCredits[cur]) ? status.activeCredits[cur].length : (status.activeCredits[cur] || 0);
        msg += `  <b>${cur} 資產</b>:\n`;
        msg += `  ├─ 錢包總額: $${wallet.balance.toFixed(2)}\n`;
        msg += `  ├─ 可用餘額: $${wallet.available.toFixed(2)}\n`;
        msg += `  └─ 運行合約: 掛單 ${offersCount} 筆 | 放貸中 ${creditsCount} 筆\n`;
    }
    msg += `\n`;

    // 4. 3D Hybrid 核心決策維度診斷
    msg += `📊 <b>3D Hybrid 決策維度診斷</b>\n`;
    for (const cur of ['USD', 'USDT']) {
        const md = status.marketData?.[cur];
        if (!md) continue;

        const lastDec = status.lastDecision?.[cur] || {};
        const opt = lastDec.optimalResult || {};
        const diag = opt.diagnostics || {};

        const currentFRR = md.frr ? `${(md.frr * 100).toFixed(4)}%/天` : '—';
        const equilibrium = diag.equilibriumRate ? `${(diag.equilibriumRate * 100).toFixed(4)}%/天` : '—';
        const dsRatio = diag.demandSupplyRatio ? diag.demandSupplyRatio.toFixed(2) : '—';
        const avg7d = strategy.historicalFRR[cur]?.['7d'] ? `${(strategy.historicalFRR[cur]['7d'] * 100).toFixed(4)}%` : '—';
        const avg30d = strategy.historicalFRR[cur]?.['30d'] ? `${(strategy.historicalFRR[cur]['30d'] * 100).toFixed(4)}%` : '—';

        msg += `  <b>${cur} 市場特徵</b>:\n`;
        msg += `  ├─ 當前市場 FRR: ${currentFRR} (年化 ${(md.frr * 365 * 100).toFixed(2)}%)\n`;
        msg += `  ├─ 瓦爾拉斯出清點: ${equilibrium}\n`;
        msg += `  ├─ 真實供需比: ${dsRatio} (需求/供應)\n`;

        // 阻力牆
        if (diag.wallDetected) {
            msg += `  ├─ 大資金阻力牆: ⚠️ 偵測到巨牆 (${(diag.wallRate * 100).toFixed(4)}%/天)！已觸發避讓前置掛單\n`;
        } else {
            msg += `  ├─ 大資金阻力牆: 🟢 通暢 (未偵測到巨牆)\n`;
        }

        msg += `  └─ 歷史均值 (7d/30d): ${avg7d} | ${avg30d}\n`;
    }
    msg += `\n`;

    // 5. 運行效率統計
    msg += `⚙️ <b>引擎調度效率</b>\n`;
    msg += `  ├─ 網格掛單提交: ${status.stats.offersPlaced} 次\n`;
    msg += `  ├─ 利率飆升取消: ${status.stats.offersCancelled} 次\n`;
    if (status.stats.transfersExecuted > 0) {
        msg += `  └─ 自動資金劃轉: ${status.stats.transfersExecuted} 次\n`;
    } else {
        msg += `  └─ 自動資金劃轉: 0 次 (無觸發)\n`;
    }

    await sendMessage(msg);
    logger.info('telegram', '🌌 3D Hybrid 每日營運總結已發送');
}

/**
 * 發送異常警報
 */
async function sendAlert(title, details) {
    const msg = `🚨 <b>${title}</b>\n\n${details}\n\n⏰ 警報時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`;
    await sendMessage(msg);
}

/**
 * 🎉 發送成交通知（3D Hybrid 自適應版本）
 */
async function sendTradeNotification(currency, amount, rate, period) {
    const { getLendingEngine } = require('./engine/lending');
    const engine = getLendingEngine();
    const marketData = engine.state.marketData?.[currency] || {};
    const frr = marketData.frr || 0;

    const annualRate = rate * 365 * 100;
    const estimatedInterest = amount * rate * period;
    const netEstimatedInterest = estimatedInterest * 0.85; // 扣除 15% 手續費

    // 🌟 3D Grid 自適應匹配判斷
    let dimensionTag = '🛡️ 第一維度：空間穩健底倉 (平衡穩健掛單)';
    if (frr > 0) {
        const ratio = rate / frr;
        if (ratio >= 2.0) {
            dimensionTag = '⚡ <b>第三維度：Cascade 時間級聯天價探針 (天價成交！🚀)</b>';
        } else if (ratio >= 1.05) {
            dimensionTag = '🔍 <b>第二維度：Percent Depth 深度探針 (中溢價成交！📈)</b>';
        }
    }

    const msg = `🎉 <b>放貸合約成交 (3D Hybrid 智能調度)</b>\n\n` +
        `🪙 <b>放貸幣種</b>: ${currency}\n` +
        `💵 <b>成交金額</b>: $${amount.toFixed(2)}\n` +
        `📉 <b>放貸利率</b>: <b>${(rate * 100).toFixed(4)}%/天</b> (年化 ${annualRate.toFixed(2)}%)\n` +
        `⏳ <b>放貸期限</b>: <b>${period} 天</b> (自適應鎖倉)\n` +
        `🔮 <b>策略歸屬</b>: ${dimensionTag}\n` +
        `💰 <b>預估淨利息</b>: <b>$${netEstimatedInterest.toFixed(6)} USD</b> (已扣稅)`;

    await sendMessage(msg);
}

/**
 * 🔄 發送自動降息重掛通知
 */
async function sendReofferNotification(currency, amount, oldRate, newRate, period, isFloor) {
    const msg = `🔄 <b>自動降息重掛 (3D Hybrid 時間級聯衰減)</b>\n\n` +
        `⚙️ <b>荷蘭拍衰減機制已觸發</b>，為避免資金閒置，系統已將未成交掛單自動調息重掛。\n\n` +
        `🪙 <b>放貸幣種</b>: ${currency}\n` +
        `💵 <b>掛單金額</b>: $${amount.toFixed(2)}\n` +
        `📉 <b>日利率調降</b>:\n` +
        `  ├─ 原利率: ${(oldRate * 100).toFixed(4)}%/天 (年化 ${(oldRate * 365 * 100).toFixed(2)}%)\n` +
        `  └─ 新利率: ${(newRate * 100).toFixed(4)}%/天 (年化 ${(newRate * 365 * 100).toFixed(2)}%)\n` +
        `⏳ <b>掛單期限</b>: ${period} 天\n` +
        `⏱️ <b>當前狀態</b>: ${isFloor ? '⚠️ 已觸發保底年化 12% 利率，不再調降' : '📉 已進行 4% 衰減優化'}`;

    await sendMessage(msg);
}

module.exports = {
    initTelegram,
    sendMessage,
    sendDailySummary,
    sendAlert,
    sendTradeNotification,
    sendReofferNotification,
};
