'use strict';

const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const { normalizeTelegramChatId } = require('./telegram-routing');

function getSharedTelegramBotToken(settings = null) {
    // Production SaaS uses one token from the server environment. The
    // settings value is kept only as a backwards-compatible bootstrap path.
    return config.telegram.botToken || settings?.telegram_bot_token || null;
}

async function verifyTelegramChatId({ botToken, chatId }) {
    const normalizedChatId = normalizeTelegramChatId(chatId);
    if (!botToken) {
        const error = new Error('尚未設定共用 Telegram Bot Token');
        error.code = 'TELEGRAM_BOT_TOKEN_MISSING';
        throw error;
    }

    const bot = new TelegramBot(botToken, { polling: false });
    try {
        await bot.getChat(normalizedChatId);
        return normalizedChatId;
    } catch (error) {
        const bindingError = new Error('Telegram Chat ID 無法由目前的 Bot 驗證，請先對 Bot 傳送 /start 或確認 Chat ID');
        bindingError.code = 'TELEGRAM_CHAT_VERIFICATION_FAILED';
        bindingError.cause = error;
        throw bindingError;
    }
}

module.exports = {
    getSharedTelegramBotToken,
    verifyTelegramChatId,
};
