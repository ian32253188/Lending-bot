'use strict';

const { isIP } = require('node:net');

function isLoopbackHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === 'localhost') return true;

    const ipVersion = isIP(normalized);
    if (ipVersion === 4) return normalized.startsWith('127.');
    return ipVersion === 6 && normalized === '::1';
}

function requireSecureSupabaseUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('SUPABASE_URL must be a valid HTTPS URL; HTTP is allowed only for a loopback development server.');
    }

    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('SUPABASE_URL must not contain credentials, query parameters, or a fragment.');
    }

    if (parsed.protocol === 'https:') return parsed.toString();
    if (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) return parsed.toString();

    throw new Error('SUPABASE_URL must use HTTPS for remote services; HTTP is allowed only for a loopback development server.');
}

module.exports = { isLoopbackHostname, requireSecureSupabaseUrl };
