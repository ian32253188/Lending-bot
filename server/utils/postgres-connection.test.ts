import { describe, expect, it } from 'vitest';

const { postgresHostTls, requireVerifiedTls } = require('./postgres-connection');

describe('external PostgreSQL connection security', () => {
  it('requires hostname and certificate verified TLS even when the URL disables it', () => {
    const normalized = requireVerifiedTls(
      'postgresql://app@db.example.test:5432/lending?sslmode=disable&application_name=lending-bot',
    );
    const parsed = new URL(normalized);

    expect(parsed.searchParams.get('sslmode')).toBe('verify-full');
    expect(parsed.searchParams.get('application_name')).toBe('lending-bot');
    expect(parsed.password).toBe('');
  });

  it('rejects non-PostgreSQL URLs without including them in the error', () => {
    expect(() => requireVerifiedTls('https://user:secret@example.test/database'))
      .toThrow('DATABASE_URL 必須使用 PostgreSQL 協定');
  });

  it('requires certificate verification for remote host-based connections', () => {
    expect(postgresHostTls('db.example.test')).toEqual({ rejectUnauthorized: true });
    expect(postgresHostTls('203.0.113.5')).toEqual({ rejectUnauthorized: true });
  });

  it('requires an explicit opt-in for the private Compose service alias', () => {
    const originalComposeOptIn = process.env.LENDING_BOT_ALLOW_PLAINTEXT_COMPOSE_POSTGRES;
    delete process.env.LENDING_BOT_ALLOW_PLAINTEXT_COMPOSE_POSTGRES;
    try {
      expect(postgresHostTls('localhost')).toBeUndefined();
      expect(postgresHostTls('127.0.0.1')).toBeUndefined();
      expect(postgresHostTls('::1')).toBeUndefined();
      expect(postgresHostTls('postgres')).toEqual({ rejectUnauthorized: true });

      process.env.LENDING_BOT_ALLOW_PLAINTEXT_COMPOSE_POSTGRES = '1';
      expect(postgresHostTls('postgres')).toBeUndefined();
      expect(postgresHostTls('db.example.test')).toEqual({ rejectUnauthorized: true });
      expect(postgresHostTls('postgres.example.test')).toEqual({ rejectUnauthorized: true });
    } finally {
      if (originalComposeOptIn === undefined) delete process.env.LENDING_BOT_ALLOW_PLAINTEXT_COMPOSE_POSTGRES;
      else process.env.LENDING_BOT_ALLOW_PLAINTEXT_COMPOSE_POSTGRES = originalComposeOptIn;
    }
    expect(postgresHostTls('db.example.test.')).toEqual({ rejectUnauthorized: true });
  });
});
