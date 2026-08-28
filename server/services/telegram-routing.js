'use strict';

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

/**
 * Resolve only an exact binding. An unknown chat must return null; falling
 * back to an arbitrary account would break tenant isolation.
 */
function resolveUserSettingsByChatId(settingsRows, chatId) {
    const normalizedChatId = normalizeTelegramChatId(chatId);
    if (!normalizedChatId) return null;

    return (settingsRows || []).find((row) => {
        try {
            return normalizeTelegramChatId(row?.telegram_chat_id) === normalizedChatId;
        } catch {
            return false;
        }
    }) || null;
}

module.exports = {
    normalizeTelegramChatId,
    resolveUserSettingsByChatId,
};
