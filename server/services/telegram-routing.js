'use strict';

const { isSingleAccount } = require('../config/single-account');

/**
 * Telegram Chat ID is an identifier, not a number. Keep it as a string so
 * large IDs and negative group IDs are never rounded or reformatted.
 */
function normalizeTelegramChatId(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    if (!normalized) return null;
    if (!/^-?\d+$/.test(normalized)) {
        const error = new Error('Telegram Chat ID 必須是整數格式（個人或群組 Chat ID）');
        error.code = 'INVALID_TELEGRAM_CHAT_ID';
        throw error;
    }
    return normalized;
}

function isPrivateTelegramSender(chat, sender, expectedChatId) {
    if (chat?.type !== 'private' || sender?.id === undefined || sender?.id === null) return false;
    try {
        const expected = normalizeTelegramChatId(expectedChatId);
        return Boolean(expected)
            && normalizeTelegramChatId(chat.id) === expected
            && normalizeTelegramChatId(sender.id) === expected;
    } catch {
        return false;
    }
}

function isPrivateTelegramChatId(value) {
    try {
        const normalized = normalizeTelegramChatId(value);
        return Boolean(normalized && /^[1-9]\d*$/.test(normalized));
    } catch {
        return false;
    }
}

/**
 * Resolve only an exact binding. An unknown chat must return null; falling
 * back to an arbitrary account would break tenant isolation.
 */
function resolveUserSettingsByChatId(settingsRows, chatId) {
    const normalizedChatId = normalizeTelegramChatId(chatId);
    if (!normalizedChatId) return null;

    return (settingsRows || []).find((row) => {
        if (!isSingleAccount(row?.user_id)) return false;
        try {
            return normalizeTelegramChatId(row?.telegram_chat_id) === normalizedChatId;
        } catch {
            return false;
        }
    }) || null;
}

module.exports = {
    normalizeTelegramChatId,
    isPrivateTelegramSender,
    isPrivateTelegramChatId,
    resolveUserSettingsByChatId,
};
