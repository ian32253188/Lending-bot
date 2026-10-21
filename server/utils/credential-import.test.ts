import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const originalJwtSecret = process.env.JWT_SECRET;
const originalEncryptionSalt = process.env.ENCRYPTION_SALT;
process.env.JWT_SECRET = 'test-import-encryption-secret-32-characters';
process.env.ENCRYPTION_SALT = 'test-import-salt';

const { decrypt, encrypt } = require('./crypto');
const { encryptImportedCredential, ensureEncryptedCredential } = require('./credential-import');

beforeEach(() => {
  process.env.JWT_SECRET = 'test-import-encryption-secret-32-characters';
  process.env.ENCRYPTION_SALT = 'test-import-salt';
});

afterEach(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  if (originalEncryptionSalt === undefined) delete process.env.ENCRYPTION_SALT;
  else process.env.ENCRYPTION_SALT = originalEncryptionSalt;
});

describe('credential migration encryption', () => {
  it('encrypts legacy plaintext before it is written to PostgreSQL', () => {
    const stored = encryptImportedCredential('synthetic-api-secret');

    expect(stored).not.toBe('synthetic-api-secret');
    expect(decrypt(stored)).toBe('synthetic-api-secret');
  });

  it('validates and re-encrypts an existing ciphertext', () => {
    const source = encrypt('synthetic-api-secret');
    const stored = encryptImportedCredential(source);

    expect(stored).not.toBe(source);
    expect(decrypt(stored)).toBe('synthetic-api-secret');
  });

  it('fails closed for ciphertext-shaped values that cannot be decrypted', () => {
    const source = `${'a'.repeat(32)}:${'b'.repeat(32)}:00`;

    expect(() => encryptImportedCredential(source)).toThrow(expect.objectContaining({
      code: 'IMPORTED_CREDENTIAL_DECRYPTION_FAILED',
    }));
  });

  it('preserves absent credentials without inventing a value', () => {
    expect(encryptImportedCredential(null)).toBeNull();
    expect(encryptImportedCredential('')).toBe('');
  });

  it('encrypts legacy stored credentials once and validates existing ciphertext', () => {
    const stored = ensureEncryptedCredential('123456789:synthetic-token');

    expect(stored).not.toBe('123456789:synthetic-token');
    expect(decrypt(stored)).toBe('123456789:synthetic-token');
    expect(ensureEncryptedCredential(stored)).toBe(stored);
  });
});
