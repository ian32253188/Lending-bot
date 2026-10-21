const { TelegramBot } = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../utils/logger');
const cron = require('node-cron');
const { buildFundingMarketSummary } = require('./market-summary');
const { RATE_STRATEGY_LABELS, PERIOD_DAYS, normalizeStrategyConfig } = require('./strategy-config');
const {
    normalizeTelegramChatId,
    isPrivateTelegramSender,
    isPrivateTelegramChatId,
} = require('./telegram-routing');
const { getSharedTelegramBotToken } = require('./telegram-binding');
const { getUsdToTwdRate, convertToTwd } = require('./exchange-rate');
const { isPublicTickerFresh } = require('./bitfinex/ws');
const { isSingleAccount, SINGLE_ACCOUNT_USER_ID } = require('../config/single-account');

// One shared Bot and one private account route are supported in this deployment.
const userBots = new Map();

// 系統管理員 Bot (用 .env 設定的全域 Bot，可選)
let adminBot = null;
let adminChatId = null;
let sharedBotToken = null;
let handlersReady = false;
let dailySummaryJob = null;
let actualFundingInterestJob = null;

function ensureDailySummarySchedule() {
    if (dailySummaryJob) return;

    // 每日摘要與管理員 Bot 無關；SaaS 使用者只設定自己的 Bot 時也必須啟動
    dailySummaryJob = cron.schedule('0 7 * * *', () => {
        logger.info('telegram', '⏰ 觸發每日放貸摘要定時任務...');
        sendDailySummary().catch(err => {
            logger.error('telegram', '定時發送每日摘要失敗', { error: err.message });
        });
    }, {
        timezone: 'Asia/Taipei'
    });
    logger.info('telegram', '📅 已註冊每日放貸摘要排程 (每天 07:00 台北時間)');
}

function ensureActualFundingInterestSchedule() {
    if (actualFundingInterestJob) return;
    actualFundingInterestJob = cron.schedule('*/10 * * * *', async () => {
        const { syncUserEarnings } = require('./engine/sync');
        const { getBot } = require('./engine/manager');
        for (const [userId] of userBots) {
            try {
                const engine = getBot(userId);
                if (engine) await engine._syncActualFundingEarnings(false, true);
                else await syncUserEarnings(userId, false, true);
            } catch (error) {
                logger.error('telegram', `用戶 ${userId} 實際放貸利息同步失敗`, { error: error.message });
            }
        }
    }, { timezone: 'Asia/Taipei' });
    logger.info('telegram', '📒 已註冊實際放貸利息帳本同步排程（每 10 分鐘）');
}

/**
 * 初始化系統管理員 Telegram Bot (使用 .env 全域設定)
 * 這是向下相容的管理員通知 Bot，不對應任何特定用戶
 */
function initTelegram() {
    if (!config.telegram.botToken) {
        logger.info('telegram', '尚未設定共用 Telegram Bot Token，跳過初始化');
        return null;
    }
    return ensureSharedBot(config.telegram.botToken);
}

function ensureSharedBot(botToken) {
    if (!botToken) return null;
    if (adminBot) {
        if (sharedBotToken !== botToken) {
            logger.warn('telegram', '收到不同的 Telegram Bot Token，仍使用既有 shared Bot');
        }
        return adminBot;
    }
    try {
        adminBot = new TelegramBot(botToken, { polling: true });
        sharedBotToken = botToken;
        adminChatId = isPrivateTelegramChatId(config.telegram.chatId)
            ? normalizeTelegramChatId(config.telegram.chatId)
            : null;
        if (config.telegram.chatId && !adminChatId) {
            logger.warn('telegram', '拒絕使用非私人 Telegram Chat ID，避免將帳戶通知傳送到群組');
        }
        if (!handlersReady) {
            setupAdminBotHandlers(adminBot);
            handlersReady = true;
        }
        ensureDailySummarySchedule();
        logger.info('telegram', '✅ shared Telegram Bot 已初始化');
        return adminBot;
    } catch (err) {
        logger.error('telegram', 'shared Telegram Bot 初始化失敗', { error: err.message });
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
    if (!isSingleAccount(userId)) {
        logger.warn('telegram', '拒絕註冊非管理員帳戶的 Telegram route（單一帳戶模式）');
        return null;
    }
    const normalizedChatId = normalizeTelegramChatId(chatId);
    if (!normalizedChatId) {
        logger.debug('telegram', `用戶 ${userId} 未設定 Telegram Chat ID，通知功能跳過`);
        return null;
    }
    if (!isPrivateTelegramChatId(normalizedChatId)) {
        logger.warn('telegram', '拒絕註冊群組或頻道 Telegram route；只允許私人對話');
        return null;
    }

    const bot = ensureSharedBot(config.telegram.botToken || botToken);
    if (!bot) {
        logger.error('telegram', `用戶 ${userId} 無法取得 shared Telegram Bot`);
        return null;
    }

    userBots.set(userId, { bot, chatId: normalizedChatId });
    ensureActualFundingInterestSchedule();
    logger.info('telegram', `✅ 用戶 ${userId} 的 Telegram Chat ID 已註冊`);
    return bot;
}

async function initConfiguredUserTelegram() {
    const db = require('./database');
    try {
        const settings = await db.getUserSettings(SINGLE_ACCOUNT_USER_ID);
        if (!settings?.telegram_chat_id) return null;
        const botToken = getSharedTelegramBotToken(settings);
        if (!botToken) return null;
        return initUserTelegram(SINGLE_ACCOUNT_USER_ID, botToken, settings.telegram_chat_id);
    } catch (error) {
        logger.error('telegram', '初始化已設定的 Telegram 路由失敗', { error: error.message });
        return null;
    }
}

/**
 * 銷毀特定用戶的 Telegram Bot 實例
 */
function destroyUserTelegram(userId) {
    if (userBots.delete(userId)) {
        logger.debug('telegram', `用戶 ${userId} 的 Telegram Bot 已銷毀`);
    }
}

// ============== 核心發送函數（多租戶版）==============

/**
 * 向特定用戶發送 Telegram 訊息
 * 指定 userId 時只允許發送到該 userId 的精確 Chat ID；未知 route 不得 fallback。
 * @param {string} text - 訊息內容 (HTML)
 * @param {string|null} userId - 目標用戶 ID
 */
async function sendMessage(text, userId = null) {
    // 1. 嘗試用該用戶自己的 Bot
    if (userId) {
        if (!isSingleAccount(userId)) {
            logger.warn('telegram', '拒絕向非管理員帳戶發送訊息（單一帳戶模式）');
            return;
        }
        const entry = userBots.get(userId);
        if (entry && entry.bot && entry.chatId) {
            try {
                await entry.bot.sendMessage(entry.chatId, text, { parse_mode: 'HTML' });
                return;
            } catch (err) {
                logger.error('telegram', `用戶 ${userId} 的 Telegram 訊息發送失敗`, { error: err.message });
            }
        }
        // Never send a tenant's private notification to another account.
        logger.warn('telegram', `用戶 ${userId} 尚未註冊 Telegram route，拒絕 fallback`);
        return;
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

function getTelegramRoutingStats() {
    return {
        sharedBotActive: !!adminBot,
        registeredUsers: userBots.size,
    };
}

/**
 * 發送異常警報
 * @param {string} title - 警報標題
 * @param {string} details - 警報詳情
 * @param {string|null} userId - 目標用戶 ID
 */
async function sendAlert(title, details, userId = null) {
    const msg = `${title}\n\n${details}\n警報時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`;
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

    const msg = `🎉 放貸合約成交\n\n` +
        `成交金額: $${amount.toFixed(2)}\n` +
        `年化利率: ${annualRate.toFixed(2)}%\n` +
        `放貸天數: ${period} 天`;

    await sendMessage(msg, userId);
}

/**
 * 📤 發送策略掛單已送出通知（尚未代表成交）
 */
async function sendOfferNotification(currency, amount, rate, period, userId = null) {
    const normalizedAmount = Number(amount) || 0;
    const normalizedRate = Number(rate) || 0;
    const annualRate = normalizedRate * 365 * 100;
    const msg = `📤 放貸策略已送出新掛單\n\n` +
        `掛單金額: $${normalizedAmount.toFixed(2)}\n` +
        `年化利率: ${annualRate.toFixed(2)}%\n` +
        `掛單期限: ${period} 天`;

    await sendMessage(msg, userId);
}

/**
 * 💸 發送放貸合約結束／本金返還通知
 */
async function sendLoanRepaymentNotification(currency, principal, rate, period, userId = null) {
    const normalizedPrincipal = Number(principal) || 0;
    const msg = `💸 放貸合約結束，本金已返還\n\n` +
        `返還本金: $${normalizedPrincipal.toFixed(2)}`;

    await sendMessage(msg, userId);
}

/** Notify one actual positive interest credit recorded by the Bitfinex Funding Wallet ledger. */
async function sendActualFundingInterestNotification(entry, userId = null) {
    const currency = entry?.currency || 'USD';
    const amount = Number(entry?.amount) || 0;
    if (amount <= 0) return;
    const msg = `💰 放貸利息實際入帳\n\n` +
        `實際入帳金額: $${amount.toFixed(8)} ${currency}`;
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
    const { getBitfinexPublicWS } = require('./bitfinex/ws');
    const publicWs = getBitfinexPublicWS();
    const marketSummary = await buildFundingMarketSummary({ publicWs, db });

    // 收集所有需要發送摘要的 targets: (userId, engine)
    const targets = [];

    // 已綁定 Telegram 的帳戶即使引擎停止，也要收到同一份每日摘要。
    for (const [userId] of userBots) {
        const engine = getBot(userId);
        targets.push({ userId, engine, adminRoute: false });
    }

    // 單一帳戶模式下的共用 Bot 仍使用個人每日摘要格式。
    if (targets.length === 0 && adminBot && adminChatId) {
        targets.push({ userId: SINGLE_ACCOUNT_USER_ID, engine: getBot(SINGLE_ACCOUNT_USER_ID), adminRoute: true });
    }

    for (const { userId, engine, adminRoute } of targets) {
        try {
            // 發送摘要前強制同步一次放貸利息收益
            const { syncUserEarnings } = require('./engine/sync');
            await syncUserEarnings(userId, true);

            const msg = await buildUserSummaryMessage(userId, engine, null, publicWs, db, marketSummary);
            if (adminRoute) await adminBot.sendMessage(adminChatId, msg, { parse_mode: 'HTML' });
            else await sendMessage(msg, userId);
        } catch (err) {
            logger.error('telegram', `用戶 ${userId} 每日摘要發送失敗`, { error: err.message });
        }
    }

    logger.info('telegram', `📊 每日放貸營運總結已發送 (${targets.length} 位用戶)`);
}

/**
 * 組合特定用戶的每日摘要訊息
 */
async function buildUserSummaryMessage(userId, engine, strategy, publicWs, db, marketSummary = null) {
    let status;
    if (engine) {
        status = engine.getDetailedStatus();
    } else {
        const [settings, accountSnapshot] = await Promise.all([
            db.getUserSettings(userId),
            require('./private-account-status').getReadOnlyAccountSnapshot(userId),
        ]);
        const isPaused = settings?.status === 'paused';
        status = {
            ...accountSnapshot,
            running: isPaused,
            paused: isPaused,
            pauseReason: settings?.pause_reason || '',
        };
    }
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    let exchangeQuote = null;
    try {
        exchangeQuote = await getUsdToTwdRate();
    } catch (err) {
        logger.warn('telegram', '取得 USD/TWD 匯率失敗，摘要將標示暫不可用', {
            error: err.message,
            userId,
        });
    }

    // 為了防範伺服器時區差異，採用亞洲/台北時區 (UTC+8) 作為結算基準
    const taipeiOffset = 8 * 60 * 60 * 1000;
    const nowTaipei = new Date(Date.now() + taipeiOffset);
    const todayStart = new Date(Date.UTC(nowTaipei.getUTCFullYear(), nowTaipei.getUTCMonth(), nowTaipei.getUTCDate()));
    todayStart.setTime(todayStart.getTime() - taipeiOffset);

    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const monthStart = new Date(Date.UTC(nowTaipei.getUTCFullYear(), nowTaipei.getUTCMonth(), 1));
    monthStart.setTime(monthStart.getTime() - taipeiOffset);

    const [todayEarnings, yesterdayEarnings, monthEarnings, allEarnings] = await Promise.all([
        db.getEarnings('USD', todayStart.toISOString(), null, userId),
        db.getEarnings('USD', yesterdayStart.toISOString(), todayStart.toISOString(), userId),
        db.getEarnings('USD', monthStart.toISOString(), null, userId),
        db.getEarnings('USD', null, null, userId),
    ]);

    function sumTwdAmount(rows) {
        if (!rows.length) return 0;
        let total = 0;
        for (const row of rows) {
            const converted = convertToTwd(row.amount, row.currency, exchangeQuote);
            if (converted === null) return null;
            total += converted;
        }
        return total;
    }

    const todayTotal = sumTwdAmount(todayEarnings);
    const yesterdayTotal = sumTwdAmount(yesterdayEarnings);
    const monthTotal = sumTwdAmount(monthEarnings);
    const allTimeTotal = sumTwdAmount(allEarnings);

    let msg = `📊 每日放貸營運總結\n`;
    msg += `統計時間: ${now}\n`;
    const credentialFailure = status.accountDataErrorCode === 'BITFINEX_SIGNATURE_INVALID'
        ? 'Bitfinex API 簽章驗證失敗'
        : status.accountDataErrorCode === 'BITFINEX_CREDENTIAL_DECRYPTION_FAILED'
            ? 'Bitfinex 憑證無法解密'
            : null;
    const engineLabel = !status.running
        ? '已停止'
        : status.paused
            ? `已暫停（${status.pauseReason || '未提供原因'}）`
            : credentialFailure
                ? `程序已啟動，但${credentialFailure}`
                : status.accountDataError
                    ? '程序已啟動，但帳戶資料同步異常'
                    : status.authenticated === false
                        ? '程序已啟動，等待 Bitfinex 私有連線認證'
                        : '運作中';
    msg += `放貸引擎: ${engineLabel}\n\n`;

    // 1. fUSD 市場行情
    msg += formatFundingMarketSection(marketSummary, { concise: true });

    // 2. 收益回報統計
    msg += `\n💰 量化收益回報（TWD）\n`;
    msg += `  ├─ 今日收益: ${formatTwdAmount(todayTotal, 4)}\n`;
    msg += `  ├─ 昨日收益: ${formatTwdAmount(yesterdayTotal, 4)}\n`;
    msg += `  ├─ 本月收益: ${formatTwdAmount(monthTotal, 4)}\n`;
    msg += `  └─ 累計收益: ${formatTwdAmount(allTimeTotal, 4)}\n`;

    // 3. USD 錢包與放貸水位
    msg += `\n💳 資產與放貸水位\n`;
    for (const cur of ['USD']) {
        const wallet = status.wallets[cur] || { balance: null, available: null };
        const activeOffers = Array.isArray(status.activeOffers[cur]) ? status.activeOffers[cur] : [];
        const activeCredits = Array.isArray(status.activeCredits[cur]) ? status.activeCredits[cur] : [];
        const walletBalance = wallet.balance === null || wallet.balance === undefined ? null : Number(wallet.balance);
        const availableBalance = wallet.available === null || wallet.available === undefined ? null : Number(wallet.available);
        const rawOffers = status.activeOffers[cur];
        const rawCredits = status.activeCredits[cur];
        const offersCount = Array.isArray(rawOffers) ? activeOffers.length : rawOffers == null ? null : Number(rawOffers);
        const creditsCount = Array.isArray(rawCredits) ? activeCredits.length : rawCredits == null ? null : Number(rawCredits);
        const offersAmount = Array.isArray(rawOffers) && activeOffers.length > 0
            ? activeOffers.reduce((sum, offer) => sum + (Number(offer.amount) || 0), 0)
            : Array.isArray(rawOffers) ? 0 : null;
        const creditsAmount = Array.isArray(rawCredits) && activeCredits.length > 0
            ? activeCredits.reduce((sum, credit) => sum + Math.abs(Number(credit.amount) || 0), 0)
            : Array.isArray(rawCredits) ? 0 : null;
        const creditDetails = Array.isArray(rawCredits) && activeCredits.length > 0
            ? activeCredits.map(formatActiveCredit).join('、')
            : formatOptionalFixedMoney(creditsAmount);
        const lendingAmount = Number.isFinite(walletBalance) && Number.isFinite(availableBalance)
            ? Math.max(0, walletBalance - availableBalance)
            : null;
        const walletTwd = Number.isFinite(walletBalance) ? convertToTwd(walletBalance, cur, exchangeQuote) : null;
        msg += `  ${cur} 資產:\n`;
        const walletTwdText = walletTwd === null ? 'NT$—' : formatTwdAmount(walletTwd, 2);
        msg += `  ├─ 錢包總額: ${formatOptionalFixedMoney(walletBalance)}（約 ${walletTwdText}）\n`;
        msg += `  ├─ 可用餘額: ${formatOptionalFixedMoney(availableBalance)}\n`;
        msg += `  ├─ 已投入放貸: ${formatOptionalFixedMoney(lendingAmount)}\n`;
        msg += `  └─ 進行中: 掛單 ${offersCount ?? '—'} 筆 (${formatOptionalFixedMoney(offersAmount)}) | 貸款中 ${creditsCount ?? '—'} 筆 (${creditDetails})\n`;
    }

    return msg;
}

function formatPercent(value) {
    return value === null || value === undefined || !Number.isFinite(Number(value))
        ? '—'
        : `${Number(value).toFixed(2)}%`;
}

function formatAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? `$${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—';
}

function formatFixedMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount)
        ? `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '$—';
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function toValidDate(value) {
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value : null;
    }

    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
        const timestamp = Number(value);
        const date = new Date(timestamp);
        return Number.isFinite(date.getTime()) ? date : null;
    }

    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Bitfinex 的 PERIOD 是天數，MTS_OPENING 是放貸實際開放時間。
 * 以開放時間加上期限計算下一個還款日；若資料不完整則回傳 null。
 */
function getCreditRepaymentDate(credit) {
    const periodDays = Number(credit?.period);
    if (!Number.isFinite(periodDays) || periodDays <= 0) return null;

    const openedAt = toValidDate(credit?.openedAt) || toValidDate(credit?.createdAt);
    if (!openedAt) return null;

    return new Date(openedAt.getTime() + periodDays * DAY_IN_MILLISECONDS);
}

function formatMonthDay(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        month: 'numeric',
        day: 'numeric',
    }).formatToParts(date);
    const month = parts.find(part => part.type === 'month')?.value;
    const day = parts.find(part => part.type === 'day')?.value;
    return month && day ? `${month}/${day}` : null;
}

function formatActiveCredit(credit) {
    const amount = Math.abs(Number(credit?.amount));
    const amountText = formatFixedMoney(Number.isFinite(amount) ? amount : null);
    const repaymentDate = getCreditRepaymentDate(credit);
    const dateText = repaymentDate ? formatMonthDay(repaymentDate) : null;
    return dateText ? `${amountText}(${dateText})` : amountText;
}

function formatTwdAmount(value, fractionDigits = 2) {
    const amount = Number(value);
    return Number.isFinite(amount)
        ? `NT$${amount.toLocaleString('zh-TW', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`
        : 'NT$—';
}

function formatFundingMarketSection(summary, { concise = false } = {}) {
    if (!summary) {
        return concise
            ? `📈 fUSD 市場行情\n  └─ 公開市場資料暫時無法取得\n`
            : `📈 <b>fUSD 市場行情</b>\n  └─ 公開市場資料暫時無法取得\n\n`;
    }

    const currentRateLabel = summary.currentRateSource === 'funding_trades_24h_vwap'
        ? '近 24H 成交加權均值'
        : summary.currentRateSource === 'bitfinex_public_ticker_last_price'
            ? '最新公開成交價'
            : summary.currentRateSource === 'bitfinex_public_ticker_frr'
                ? '公開 FRR'
                : '成交利率';

    if (concise) {
        return `📈 fUSD 市場行情\n` +
            `  ├─ ${currentRateLabel}: ${formatPercent(summary.currentApy)}\n` +
            `  ├─ 24H 區間: ${formatPercent(summary.low24hApy)} – ${formatPercent(summary.high24hApy)}\n` +
            `  ├─ 30 日平均: ${formatPercent(summary.average30dApy)}\n` +
            `  ├─ 30 日最高: ${formatPercent(summary.high30dApy)}\n` +
            `  └─ 30 日最低: ${formatPercent(summary.low30dApy)}\n`;
    }

    let msg = `📈 <b>fUSD 市場行情</b>（Bitfinex 公開資料）\n`;
    msg += `  ├─ ${currentRateLabel}: <b>${formatPercent(summary.currentApy)}</b>\n`;
    msg += `  ├─ 24H 區間: ${formatPercent(summary.low24hApy)} – ${formatPercent(summary.high24hApy)}\n`;
    msg += `  ├─ 24H 最高: ${formatPercent(summary.high24hApy)}（${summary.high24hSource || '來源未知'}）\n`;
    msg += `  ├─ 24H 成交額: ${formatAmount(summary.volume24h)}（${summary.volume24hSource || '來源未知'}）\n`;
    msg += `  ├─ 30 日平均: ${formatPercent(summary.average30dApy)}\n`;
    msg += `  ├─ 30 日最高: ${formatPercent(summary.high30dApy)}\n`;
    msg += `  ├─ 30 日最低: ${formatPercent(summary.low30dApy)}\n`;
    if (!concise && summary.currentRateSource) {
        msg += `  ├─ 成交均值來源: ${summary.currentRateSource}${summary.currentRateObservedAt ? `（截至 ${new Date(summary.currentRateObservedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}）` : ''}\n`;
    }
    if (!concise && summary.historyCoverageDays != null) {
        const start = summary.historyCoverageStartDate || '—';
        const end = summary.historyCoverageEndDate || '—';
        msg += `  ├─ 歷史覆蓋: ${summary.historyCoverageDays}/${summary.historyWindowDays || 30} 日（${start} 至 ${end}）\n`;
    }
    if (!concise && summary.marketDataSources?.rateHistory) {
        msg += `  ├─ 歷史來源: ${summary.marketDataSources.rateHistory}\n`;
    }

    if (!concise && summary.tradeDataAvailable === false) {
        msg += `  └─ 近 24H 撮合: 資料來源暫不可用（不等同無成交）\n`;
        if (summary.marketDataSources?.trades) msg += `      來源: ${summary.marketDataSources.trades}\n`;
        msg += `\n`;
        return msg;
    }

    const hasFullHourlyWindow = Array.isArray(summary.hourlyMatches24) && summary.hourlyMatches24.length > 0;
    const hourly = hasFullHourlyWindow
        ? summary.hourlyMatches24
        : Array.isArray(summary.hourlyMatches) ? summary.hourlyMatches : [];
    if (hourly.length === 0) {
        msg += `  └─ 近 24H 撮合: 暫無資料\n\n`;
        return msg;
    }

    msg += hasFullHourlyWindow ? `  └─ 近 24 小時逐時撮合:\n` : `  └─ 近期有成交時段:\n`;
    for (const row of hourly) {
        const time = new Date(row.timestamp).toLocaleTimeString('zh-TW', {
            timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const trades = Number.isFinite(Number(row.count)) ? `${Number(row.count)} 筆` : '筆數未知';
        const range = Number(row.count) === 0
            ? '無成交'
            : `${formatPercent(row.minApy)}–${formatPercent(row.maxApy)}`;
        msg += `      ${time} ${range} | ${formatAmount(row.amount)} | ${trades}\n`;
    }
    msg += `\n`;
    return msg;
}

/**
 * 組合全域管理員摘要訊息 (無特定用戶)
 */
async function buildGlobalSummaryMessage(strategy, publicWs, db, marketSummary = null) {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    let msg = `🌌 <b>3D Hybrid 系統管理員每日摘要</b>\n`;
    msg += `📅 統計時間: <code>${now}</code>\n\n`;

    msg += formatFundingMarketSection(marketSummary, { concise: true });

    for (const cur of ['USD']) {
        const md = publicWs.getMarketData(cur);
        if (!md) continue;
        const tickerFresh = isPublicTickerFresh(md);
        const currentFRR = tickerFresh && md.frr !== null && md.frr !== undefined && Number.isFinite(Number(md.frr))
            ? `${(Number(md.frr) * 100).toFixed(4)}%/天`
            : '—';
        let average7dRate = null;
        let historyDays = 0;
        let latestHistoryAt = null;
        try {
            const rows = await db.getRateHistory(cur, 168, 'recorded_at,frr');
            const validRows = (Array.isArray(rows) ? rows : [])
                .filter(row => row?.recorded_at && row.frr !== null && row.frr !== undefined && Number.isFinite(Number(row.frr)));
            if (validRows.length) {
                average7dRate = validRows.reduce((sum, row) => sum + Number(row.frr), 0) / validRows.length;
                historyDays = new Set(validRows.map(row => new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
                }).format(new Date(row.recorded_at)))).size;
                latestHistoryAt = validRows.reduce((latest, row) =>
                    Date.parse(row.recorded_at) > Date.parse(latest) ? row.recorded_at : latest,
                validRows[0].recorded_at);
            }
        } catch (error) {
            logger.warn('telegram', `讀取 ${cur} 近 7 日 FRR 平均失敗`, { error: error.message });
        }
        const hasHistoryAverage = average7dRate !== null && average7dRate !== undefined && Number.isFinite(Number(average7dRate));
        const avg7d = hasHistoryAverage
            ? `${(Number(average7dRate) * 100).toFixed(4)}%/天${historyDays ? `（${historyDays}/7 日有資料${latestHistoryAt ? `，截至 ${new Date(latestHistoryAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}` : ''}）` : ''}`
            : '—';
        msg += `📊 <b>${cur} 市場</b>: FRR ${currentFRR} | 7d 均值 ${avg7d}\n`;
        const tickerUpdated = tickerFresh && md.tickerLastUpdate
            ? `，更新 ${new Date(md.tickerLastUpdate).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false })}`
            : '';
        msg += `  └─ FRR 來源: Bitfinex 公開 Funding Ticker${tickerUpdated || '（尚無新資料）'}\n`;
    }

    const { getReadOnlyAccountSnapshot } = require('./private-account-status');
    const adminAccountStatus = await getReadOnlyAccountSnapshot('00000000-0000-0000-0000-000000000001');
    msg += `\n${formatPrivateAccountSection(adminAccountStatus)}`;
    msg += `👥 Telegram 帳戶綁定: ${userBots.size} 個`;
    return msg;
}

function formatOptionalFixedMoney(value) {
    return value === null || value === undefined || !Number.isFinite(Number(value))
        ? '$—'
        : formatFixedMoney(value);
}

function formatPrivateAccountSection(snapshot) {
    if (!snapshot?.accountDataAvailable) {
        return `🔐 <b>Bitfinex 個人放貸部位</b>\n  └─ ${snapshot?.accountDataError || '私有帳戶資料暫不可用'}\n\n`;
    }

    const updatedAt = snapshot.accountDataUpdatedAt
        ? new Date(snapshot.accountDataUpdatedAt).toLocaleTimeString('zh-TW', {
            timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
        })
        : '時間未知';
    let message = `🔐 <b>Bitfinex 個人放貸部位</b>（${snapshot.accountDataSource || '私有 API'}，${updatedAt} 更新）\n`;
    for (const currency of ['USD']) {
        const wallet = snapshot.wallets?.[currency] || {};
        const offers = Array.isArray(snapshot.activeOffers?.[currency]) ? snapshot.activeOffers[currency] : [];
        const credits = Array.isArray(snapshot.activeCredits?.[currency]) ? snapshot.activeCredits[currency] : [];
        const amount = credits.reduce((sum, credit) => sum + Math.abs(Number(credit.amount) || 0), 0);
        message += `  ├─ ${currency}: Funding 錢包 ${formatFixedMoney(wallet.balance)}（可用 ${formatFixedMoney(wallet.available)}）`;
        message += ` | 放貸中 ${credits.length} 筆（${formatFixedMoney(amount)}） | 掛單 ${offers.length} 筆\n`;
    }
    return `${message}\n`;
}

// ============== 管理員 Bot 指令處理 ==============

/**
 * 設定管理員 Bot 的指令處理器
 * 管理員 Bot 使用 getLendingEngine singleton 作為向下相容層
 */
function setupAdminBotHandlers(bot) {
    if (!bot) return;

    // 自動註冊指令選單到 Telegram
    bot.setMyCommands([
        { command: 'control', description: '喚出互動控制面板' },
        { command: 'status', description: '查詢放貸核心與收益狀態' },
        { command: 'help', description: '顯示操作說明與指令清單' }
    ]).catch(err => logger.error('telegram', '設定 Bot 指令選單失敗', { error: err.message }));

    async function isAuthorized(msg) {
        const chatId = normalizeTelegramChatId(msg.chat.id);
        if (!isPrivateTelegramSender(msg.chat, msg.from, chatId)) {
            logger.warn('telegram', '拒絕非私人對話或非本人發出的指令');
            return false;
        }
        const isAdmin = config.telegram.chatId && chatId === normalizeTelegramChatId(config.telegram.chatId);
        const binding = await getSettingsByChatId(chatId);
        if (!isAdmin && !binding) {
            logger.warn('telegram', `⚠️ 收到未授權用戶的指令！ChatID: ${chatId}, 用戶名: ${msg.from?.username || 'unknown'}`);
            bot.sendMessage(chatId, '🚷 <b>權限不足</b>\n您無權操控此放貸機器人。', { parse_mode: 'HTML' }).catch(() => {});
            return false;
        }
        return true;
    }

    async function isCallbackAuthorized(query) {
        const chat = query.message?.chat;
        const chatId = chat?.id === undefined ? null : normalizeTelegramChatId(chat.id);
        if (!isPrivateTelegramSender(chat, query.from, chatId)) {
            logger.warn('telegram', '拒絕非私人對話或非本人發出的按鈕操作');
            bot.answerCallbackQuery(query.id, { text: '🚷 僅允許已綁定管理員的私人對話操作。', show_alert: true }).catch(() => {});
            return false;
        }
        const isAdmin = config.telegram.chatId && chatId === normalizeTelegramChatId(config.telegram.chatId);
        const binding = await getSettingsByChatId(chatId);
        if (!isAdmin && !binding) {
            logger.warn('telegram', `⚠️ 收到未授權用戶的按鈕點擊！ChatID: ${chatId}, 用戶名: ${query.from?.username || 'unknown'}`);
            bot.answerCallbackQuery(query.id, { text: '🚷 權限不足，拒絕操作！', show_alert: true }).catch(() => {});
            return false;
        }
        return true;
    }

    // `/start` 指令
    bot.onText(/\/start/, async (msg) => {
        if (!(await isAuthorized(msg))) return;
        const welcome = `👋 <b>歡迎使用 Bitfinex 放貸機器人控制終端</b>\n\n` +
            `本機器人已啟用雙向即時長輪詢監聽 (Long Polling)，您可以隨時在此操控您的 3D Hybrid 自適應放貸策略。\n\n` +
            `⌨️ <b>可用指令</b>:\n` +
            `• <code>/control</code> - 喚出互動控制面板\n` +
            `• <code>/status</code> - 查詢放貸核心與收益狀態\n` +
            `• <code>/help</code> - 顯示操作說明與指令清單`;
        bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' }).catch(() => {});
    });

    // `/help` 指令
    bot.onText(/\/help/, async (msg) => {
        if (!(await isAuthorized(msg))) return;
        const helpText = `📖 <b>放貸機器人操作指南</b>\n\n` +
            `🤖 <b>指令清單</b>:\n` +
            `• <code>/control</code> - 調整利率基準與放貸期限，並啟動或停止策略；複利固定開啟。\n` +
            `• <code>/status</code> - 即時查詢 USD 餘額、放貸中合約筆數、最新年化利率、以及今日/昨日/累計淨收益。\n\n` +
            `🛡️ <b>安全提示</b>:\n` +
            `• 本終端僅限管理員 Chat ID 操控，其他任何人均無法存取，請放心使用。`;
        bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' }).catch(() => {});
    });

    // `/status` 指令
    bot.onText(/\/status/, async (msg) => {
        if (!(await isAuthorized(msg))) return;
        try {
            const db = require('./database');
            const { getBot } = require('./engine/manager');
            const { getStrategyEngine } = require('./engine/strategy');
            const { getBitfinexPublicWS } = require('./bitfinex/ws');
            
            const strategy = getStrategyEngine();
            const publicWs = getBitfinexPublicWS();
            const marketSummary = await buildFundingMarketSummary({ publicWs, db });

            const boundSettings = await getSettingsByChatId(msg.chat.id);
            const activeUserId = (await db.getActiveUsers()).find(isSingleAccount);
            const userId = boundSettings?.user_id || activeUserId || SINGLE_ACCOUNT_USER_ID;
            const engine = getBot(userId);
            const report = await buildUserSummaryMessage(userId, engine, strategy, publicWs, db, marketSummary);
            bot.sendMessage(msg.chat.id, report, { parse_mode: 'HTML' }).catch(() => {});
        } catch (err) {
            bot.sendMessage(msg.chat.id, `❌ 查詢狀態失敗: ${err.message}`).catch(() => {});
        }
    });

    // `/control` 指令
    bot.onText(/\/control/, async (msg) => {
        if (!(await isAuthorized(msg))) return;
        sendAdminControlPanel(bot, msg.chat.id);
    });

    // 按鈕 Callback Query 監聽
    bot.on('callback_query', async (query) => {
        if (!(await isCallbackAuthorized(query))) return;

        const action = query.data;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        const { getBot } = require('./engine/manager');
        const db = require('./database');
        
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
                        await engine.setCompounding(true);
                    } else {
                        await db.saveUserSettings(userId, {
                            compounding_enabled: true,
                            compounding_hold_amount: 0,
                        });
                    }
                    await bot.answerCallbackQuery(query.id, { text: '複利固定開啟' });
                    await updateAdminControlPanel(bot, chatId, messageId);
                    break;
                }
                case 'toggle_autotransfer': {
                    await bot.answerCallbackQuery(query.id, { text: '自動劃轉已移除' });
                    await updateAdminControlPanel(bot, chatId, messageId);
                    break;
                }
                case 'strategy_current_avg':
                case 'strategy_high_24h':
                case 'strategy_high_30d': {
                    const rateStrategy = action.replace('strategy_', '');
                    const nextConfig = normalizeStrategyConfig({
                        ...(dbSettings?.strategy_config || {}),
                        rateStrategy,
                    });
                    await saveTelegramStrategySettings(userId, nextConfig, !!engine?.running);
                    await bot.answerCallbackQuery(query.id, { text: `利率策略：${RATE_STRATEGY_LABELS[rateStrategy]}` });
                    await updateAdminControlPanel(bot, chatId, messageId);
                    break;
                }
                case 'period_2':
                case 'period_10':
                case 'period_30':
                case 'period_60':
                case 'period_90':
                case 'period_120': {
                    const periodDays = Number(action.replace('period_', ''));
                    const nextConfig = normalizeStrategyConfig({
                        ...(dbSettings?.strategy_config || {}),
                        periodDays,
                    });
                    await saveTelegramStrategySettings(userId, nextConfig, !!engine?.running);
                    await bot.answerCallbackQuery(query.id, { text: `放貸期限：${periodDays} 天` });
                    await updateAdminControlPanel(bot, chatId, messageId);
                    break;
                }
                case 'start_engine': {
                    const { startBot } = require('./engine/manager');
                    await startBot(userId);
                    await bot.answerCallbackQuery(query.id, { text: '放貸策略已啟動' });
                    await updateAdminControlPanel(bot, chatId, messageId);
                    break;
                }
                case 'stop_engine': {
                    const { stopBot } = require('./engine/manager');
                    await stopBot(userId);
                    await bot.answerCallbackQuery(query.id, { text: '放貸策略已停止' });
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
                    const { startBot } = require('./engine/manager');
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

    ensureDailySummarySchedule();
}

// ============== 管理員控制面板輔助函數 ==============

async function getSettingsByChatId(chatId) {
    try {
        const db = require('./database');
        if (typeof db.getUserSettingsByTelegramChatId === 'function') {
            const settings = await db.getUserSettingsByTelegramChatId(chatId);
            return isSingleAccount(settings?.user_id) ? settings : null;
        }

        // Compatibility path for isolated test doubles only. It is still an
        // exact lookup and deliberately never returns the first account.
        const supabase = db.getSupabase();
        if (!supabase) return null;
        const normalizedChatId = normalizeTelegramChatId(chatId);
        const { data, error } = await supabase.from('user_bot_settings')
            .select('*')
            .eq('telegram_chat_id', normalizedChatId)
            .maybeSingle();
        if (error) return null;
        return isSingleAccount(data?.user_id) ? data : null;
    } catch {
        return null;
    }
}

function buildInactiveUserSummaryMessage(settings, marketSummary, accountStatus = null) {
    const strategyConfig = normalizeStrategyConfig(settings?.strategy_config || {});
    const market = marketSummary?.current || marketSummary || {};
    return `📊 <b>放貸狀態</b>\n\n` +
        `👤 帳戶：<code>${settings.user_id}</code>\n` +
        `⏸️ 引擎：<b>${settings.status === 'paused' ? '暫停' : '停止'}</b>\n` +
        `📈 策略：${RATE_STRATEGY_LABELS[strategyConfig.rateStrategy]}｜${strategyConfig.periodDays} 天\n\n` +
        `🏦 <b>USD 融資市場</b>\n` +
        `目前成交均值：${market.currentApy != null ? `${Number(market.currentApy).toFixed(2)}%` : '—'}\n` +
        `24 小時最高：${market.high24hApy != null ? `${Number(market.high24hApy).toFixed(2)}%` : '—'}\n` +
        `30 日最高：${market.high30dApy != null ? `${Number(market.high30dApy).toFixed(2)}%` : '—'}\n` +
        (market.historyCoverageDays != null
            ? `歷史覆蓋：${market.historyCoverageDays}/${market.historyWindowDays || 30} 日\n\n`
            : '\n') +
        formatPrivateAccountSection(accountStatus);
}

async function sendAdminControlPanel(bot, chatId) {
    if (!bot) return;
    try {
        const { getBot } = require('./engine/manager');
        
        const dbSettings = await getSettingsByChatId(chatId);
        const userId = dbSettings?.user_id || null;

        if (!dbSettings || !userId) {
            await bot.sendMessage(chatId, '⚠️ 此 Telegram Chat ID 尚未綁定使用者帳戶，請先在網頁設定完成綁定。');
            return;
        }
        
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
    const strategyConfig = normalizeStrategyConfig(dbSettings?.strategy_config || engine?.strategyConfig || {});
    const strategyLabel = RATE_STRATEGY_LABELS[strategyConfig.rateStrategy];

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
        `🧠 <b>利率基準</b>: <b>${strategyLabel}</b>\n` +
        `📅 <b>放貸期限</b>: <b>${strategyConfig.periodDays} 天</b>\n` +
        `💰 <b>掛單方式</b>: 可用 USD 大於 $150 時，單筆投入全部可用餘額\n` +
        `♻️ <b>複利滾投</b>: 固定開啟\n` +
        `──────────────────────\n` +
        `請點擊下方按鈕進行即時變更：`;
}

function getControlPanelKeyboard(engine, dbSettings = null) {
    const isRunning = engine ? engine.running && !engine.paused : false;
    const strategyConfig = normalizeStrategyConfig(dbSettings?.strategy_config || engine?.strategyConfig || {});

    const strategyButtons = Object.entries(RATE_STRATEGY_LABELS).map(([value, label]) => ({
        text: `${strategyConfig.rateStrategy === value ? '✅ ' : ''}${label}`,
        callback_data: `strategy_${value}`,
    }));
    const periodButtons = PERIOD_DAYS.map(days => ({
        text: `${strategyConfig.periodDays === days ? '✅ ' : ''}${days}天`,
        callback_data: `period_${days}`,
    }));

    return {
        reply_markup: {
            inline_keyboard: [
                [
                    isRunning
                        ? { text: '⏹️ 停止策略', callback_data: 'stop_engine' }
                        : { text: '🚀 啟動策略', callback_data: 'start_engine' }
                ],
                [
                    ...strategyButtons
                ],
                periodButtons.slice(0, 3),
                periodButtons.slice(3),
            ]
        }
    };
}

async function saveTelegramStrategySettings(userId, strategyConfig, wasRunning) {
    const db = require('./database');
    const { startBot, stopBot } = require('./engine/manager');
    await db.saveUserSettings(userId, { strategy_config: strategyConfig });
    if (wasRunning) {
        await stopBot(userId);
        await startBot(userId);
    }
}

module.exports = {
    initTelegram,
    initUserTelegram,
    initConfiguredUserTelegram,
    destroyUserTelegram,
    sendMessage,
    getTelegramRoutingStats,
    sendDailySummary,
    sendAlert,
    sendTradeNotification,
    sendOfferNotification,
    sendLoanRepaymentNotification,
    sendActualFundingInterestNotification,
    sendReofferNotification,
    buildUserSummaryMessage,
    buildGlobalSummaryMessage,
    formatFundingMarketSection,
    formatPrivateAccountSection,
    buildInactiveUserSummaryMessage,
    getControlPanelText,
    getControlPanelKeyboard,
};
