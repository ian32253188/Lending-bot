const { decrypt, encrypt, isEncryptedCredential } = require('./crypto');

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
            const error = new Error('無法解密來源帳戶憑證；請確認來源與目的端使用相同的 JWT_SECRET 與 ENCRYPTION_SALT。');
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
    if (decrypt(value) === null) {
        const error = new Error('無法解密已儲存的帳戶憑證；請確認 JWT_SECRET 與 ENCRYPTION_SALT。');
        error.code = 'STORED_CREDENTIAL_DECRYPTION_FAILED';
        throw error;
    }
    return value;
}

module.exports = { encryptImportedCredential, ensureEncryptedCredential };
