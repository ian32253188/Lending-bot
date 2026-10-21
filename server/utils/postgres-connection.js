'use strict';

const LOCAL_POSTGRES_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
]);
const COMPOSE_POSTGRES_HOST = 'postgres';
const ALLOW_PLAINTEXT_COMPOSE_POSTGRES = 'LENDING_BOT_ALLOW_PLAINTEXT_COMPOSE_POSTGRES';

function requireVerifiedTls(connectionString) {
    if (typeof connectionString !== 'string' || !connectionString.trim()) {
        const error = new Error('DATABASE_URL 必須是有效的 PostgreSQL 連線網址');
        error.code = 'INVALID_DATABASE_URL';
        throw error;
    }

    let parsed;
    try {
        parsed = new URL(connectionString);
    } catch {
        const error = new Error('DATABASE_URL 必須是有效的 PostgreSQL 連線網址');
        error.code = 'INVALID_DATABASE_URL';
        throw error;
    }

    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        const error = new Error('DATABASE_URL 必須使用 PostgreSQL 協定');
        error.code = 'INVALID_DATABASE_URL';
        throw error;
    }

    // pg-connection-string honors this mode with certificate and hostname
    // verification. Overwrite weaker URL options such as sslmode=disable.
    parsed.searchParams.set('sslmode', 'verify-full');
    return parsed.toString();
}

function postgresHostTls(host) {
    const normalizedHost = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (LOCAL_POSTGRES_HOSTS.has(normalizedHost)) return undefined;
    if (normalizedHost === COMPOSE_POSTGRES_HOST
        && process.env[ALLOW_PLAINTEXT_COMPOSE_POSTGRES] === '1') return undefined;
    return { rejectUnauthorized: true };
}

module.exports = { postgresHostTls, requireVerifiedTls };
