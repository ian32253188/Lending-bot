const { decrypt, encrypt, isEncryptedCredential, needsReEncryption } = require('./crypto');

function encryptImportedCredential(value) {
    if (value === null || value === undefined || value === '') return value;
    if (typeof value !== 'string') {
        const error = new Error('搬遷的帳戶憑證格式無效');
        error.code = 'INVALID_IMPORTED_CREDENTIAL';
        throw error;
    }

    if (isEncryptedCredential(value)) {
        const plaintext = decrypt(value);
        if (plaintext === null) {
            const error = new Error('無法解密來源帳戶憑證；請確認來源與目的端使用相同的 CREDENTIAL_ENCRYPTION_KEY（或舊版 JWT_SECRET）與 ENCRYPTION_SALT。');
            error.code = 'IMPORTED_CREDENTIAL_DECRYPTION_FAILED';
            throw error;
        }
        return encrypt(plaintext);
    }

    return encrypt(value);
}

function ensureEncryptedCredential(value) {
    if (value === null || value === undefined || value === '') return value;
    if (typeof value !== 'string') {
        const error = new Error('儲存的帳戶憑證格式無效');
        error.code = 'INVALID_STORED_CREDENTIAL';
        throw error;
    }

    if (!isEncryptedCredential(value)) return encrypt(value);
    const plaintext = decrypt(value);
    if (plaintext === null) {
        const error = new Error('無法解密已儲存的帳戶憑證；請確認 CREDENTIAL_ENCRYPTION_KEY（或舊版 JWT_SECRET）與 ENCRYPTION_SALT，或重新輸入該憑證。');
        error.code = 'STORED_CREDENTIAL_DECRYPTION_FAILED';
        throw error;
    }
    if (needsReEncryption(value)) return encrypt(plaintext);
    return value;
}

module.exports = { encryptImportedCredential, ensureEncryptedCredential };
