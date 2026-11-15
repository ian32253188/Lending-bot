const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTED_CREDENTIAL_PATTERN = /^[0-9a-f]{32}:[0-9a-f]{32}:(?:[0-9a-f]{2})+$/i;

function isEncryptedCredential(value) {
    return typeof value === 'string' && ENCRYPTED_CREDENTIAL_PATTERN.test(value);
}

function getSecretKey(secret, label) {
    const minimumLength = label === 'JWT_SECRET' ? 16 : 32;
    if (typeof secret !== 'string' || secret.length < minimumLength || /your_|change_me|default|example/i.test(secret)) {
        throw new Error(`${label} 必須設定為至少 ${minimumLength} 個隨機字元，才能加密帳戶憑證。`);
    }
    const salt = process.env.ENCRYPTION_SALT || 'lending-bot-secured-default-salt-2026';
    return crypto.scryptSync(secret, salt, 32);
}

function getEncryptionKey() {
    const secret = process.env.CREDENTIAL_ENCRYPTION_KEY
        || process.env.JWT_SECRET
        || (process.env.NODE_ENV === 'test' ? 'vitest-only-encryption-secret-32chars' : '');
    return getSecretKey(secret, process.env.CREDENTIAL_ENCRYPTION_KEY ? 'CREDENTIAL_ENCRYPTION_KEY' : 'JWT_SECRET');
}

function getLegacyEncryptionKey() {
    if (!process.env.CREDENTIAL_ENCRYPTION_KEY || !process.env.JWT_SECRET) return null;
    try {
        return getSecretKey(process.env.JWT_SECRET, 'JWT_SECRET');
    } catch {
        return null;
    }
}

function decryptWithKey(encryptedText, key) {
    if (!key) return null;
    try {
        const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch {
        return null;
    }
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
        if (!isEncryptedCredential(encryptedText)) return null;
        const currentKey = getEncryptionKey();
        const currentDecrypted = decryptWithKey(encryptedText, currentKey);
        if (currentDecrypted !== null) return currentDecrypted;

        const legacyKey = getLegacyEncryptionKey();
        if (legacyKey && !legacyKey.equals(currentKey)) return decryptWithKey(encryptedText, legacyKey);
        return null;
    } catch {
        return null;
    }
}

function needsReEncryption(encryptedText) {
    if (!process.env.CREDENTIAL_ENCRYPTION_KEY || !isEncryptedCredential(encryptedText)) return false;
    try {
        return decryptWithKey(encryptedText, getEncryptionKey()) === null;
    } catch {
        return false;
    }
}

function decryptWithFallback(text) {
    if (!text) return '';
    // Plaintext legacy credentials remain readable during the at-rest migration.
    if (!isEncryptedCredential(text)) {
        return text;
    }
    const decrypted = decrypt(text);
    if (decrypted !== null) return decrypted;

    // Never send an encrypted credential blob to Bitfinex as if it were a
    // plaintext API key. This commonly happens when JWT_SECRET or
    // ENCRYPTION_SALT changed after credentials were saved.
    const error = new Error('無法解密已儲存的憑證；請確認 CREDENTIAL_ENCRYPTION_KEY、JWT_SECRET 與 ENCRYPTION_SALT，或重新輸入該憑證。');
    error.code = 'CREDENTIAL_DECRYPTION_FAILED';
    throw error;
}

module.exports = { encrypt, decrypt, decryptWithFallback, isEncryptedCredential, needsReEncryption };
