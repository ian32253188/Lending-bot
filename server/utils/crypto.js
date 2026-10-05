const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
    const secret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'test' ? 'vitest-only-encryption-secret-32chars' : '');
    if (secret.length < 16 || /your_|change_me|default|example/i.test(secret)) {
        throw new Error('JWT_SECRET 必須設定為至少 32 個隨機字元，才能加密帳戶憑證。');
    }
    const salt = process.env.ENCRYPTION_SALT || 'lending-bot-secured-default-salt-2026';
    return crypto.scryptSync(secret, salt, 32);
}

function encrypt(text) {
    if (!text) return '';
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decrypt(encryptedText) {
    try {
        if (!encryptedText) return null;
        const key = getEncryptionKey();
        const parts = encryptedText.split(':');
        if (parts.length !== 3) return null;
        const [ivHex, authTagHex, encrypted] = parts;
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch {
        return null;
    }
}

function decryptWithFallback(text) {
    if (!text) return '';
    // If it doesn't have the encrypted format shape, it's plaintext
    if (!text.includes(':') || text.split(':').length !== 3) {
        return text;
    }
    const decrypted = decrypt(text);
    if (decrypted !== null) return decrypted;

    // Never send an encrypted credential blob to Bitfinex as if it were a
    // plaintext API key. This commonly happens when JWT_SECRET or
    // ENCRYPTION_SALT changed after credentials were saved.
    const error = new Error('無法解密已儲存的 Bitfinex API 憑證；請在網站設定重新輸入並儲存 API Key 與 Secret。');
    error.code = 'CREDENTIAL_DECRYPTION_FAILED';
    throw error;
}

module.exports = { encrypt, decrypt, decryptWithFallback };
