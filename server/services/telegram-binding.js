'use strict';

const { TelegramBot } = require('node-telegram-bot-api');
const config = require('../config');
const { normalizeTelegramChatId } = require('./telegram-routing');
const { decryptWithFallback } = require('../utils/crypto');

function getSharedTelegramBotToken(settings = null) {
    // Production SaaS uses one token from the server environment. The
    // The settings value is kept as a backwards-compatible bootstrap path.
    // It supports legacy plaintext rows while decrypting newly stored values.
    return config.telegram.botToken || decryptWithFallback(settings?.telegram_bot_token) || null;
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
        const chat = await bot.getChat(normalizedChatId);
        if (chat?.type !== 'private' || String(chat.id) !== normalizedChatId) {
            const bindingError = new Error('為保護帳戶資料與操作權限，Telegram 只能綁定私人對話，不能使用群組或頻道');
            bindingError.code = 'TELEGRAM_PRIVATE_CHAT_REQUIRED';
            throw bindingError;
        }
        return normalizedChatId;
    } catch (error) {
        if (error?.code === 'TELEGRAM_PRIVATE_CHAT_REQUIRED') throw error;
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
