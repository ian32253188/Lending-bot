import { describe, expect, it } from 'vitest';

const { decrypt, decryptWithFallback, encrypt } = require('./crypto');

describe('credential encryption helpers', () => {
  it('round-trips API secrets without storing plaintext', () => {
    const plaintext = 'bitfinex-secret-123';
    const ciphertext = encrypt(plaintext);

    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.split(':')).toHaveLength(3);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('uses a fresh IV for each encryption', () => {
    expect(encrypt('same-value')).not.toBe(encrypt('same-value'));
  });

  it('rejects tampered ciphertext and preserves legacy plaintext fallback', () => {
    const ciphertext = encrypt('secret');
    const [iv, tag, body] = ciphertext.split(':');
    const tampered = `${iv}:${tag}:${body.slice(0, -1)}${body.endsWith('0') ? '1' : '0'}`;

    expect(decrypt(tampered)).toBeNull();
    expect(decryptWithFallback('legacy-secret')).toBe('legacy-secret');
    expect(decryptWithFallback(ciphertext)).toBe('secret');
  });

  it('fails clearly when an encrypted credential uses a different server secret', () => {
    const originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'source-encryption-key';
    const ciphertext = encrypt('bitfinex-secret');
    process.env.JWT_SECRET = 'different-deployment-key';

    try {
      expect(() => decryptWithFallback(ciphertext)).toThrow(expect.objectContaining({
        code: 'CREDENTIAL_DECRYPTION_FAILED',
      }));
    } finally {
      if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalJwtSecret;
    }
  });
});
