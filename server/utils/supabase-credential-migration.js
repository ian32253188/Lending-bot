'use strict';

const CREDENTIAL_COLUMNS = Object.freeze([
    'bitfinex_api_key',
    'bitfinex_api_secret',
    'telegram_bot_token',
]);

/**
 * Compare legacy plaintext values and replace them atomically through a POST
 * RPC body. Credential values must never be used as PostgREST URL filters,
 * because hosted API logs retain request URLs.
 */
async function compareAndSetEncryptedCredentials(supabase, userId, current, updates) {
    const expectedCredentials = Object.fromEntries(
        CREDENTIAL_COLUMNS.map(column => [column, current?.[column] ?? null]),
    );
    const { data, error } = await supabase.rpc('migrate_user_bot_settings_credentials', {
        p_user_id: userId,
        p_expected_credentials: expectedCredentials,
        p_encrypted_credentials: updates,
    });

    return { updated: data === true, error };
}

module.exports = { CREDENTIAL_COLUMNS, compareAndSetEncryptedCredentials };
