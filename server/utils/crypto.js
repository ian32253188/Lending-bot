const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
    const secret = process.env.JWT_SECRET || 'default-secret-key-change-me';
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
    return decrypted !== null ? decrypted : text;
}

module.exports = { encrypt, decrypt, decryptWithFallback };
