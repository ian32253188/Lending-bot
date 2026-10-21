-- Compare legacy plaintext credentials in the POST body and encrypt them in
-- place without putting their values in PostgREST URL query parameters.
CREATE OR REPLACE FUNCTION public.migrate_user_bot_settings_credentials(
    p_user_id UUID,
    p_expected_credentials JSONB,
    p_encrypted_credentials JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    updated_user_id UUID;
BEGIN
    UPDATE public.user_bot_settings
    SET
        bitfinex_api_key = CASE
            WHEN p_encrypted_credentials ? 'bitfinex_api_key'
            THEN p_encrypted_credentials ->> 'bitfinex_api_key'
            ELSE bitfinex_api_key
        END,
        bitfinex_api_secret = CASE
            WHEN p_encrypted_credentials ? 'bitfinex_api_secret'
            THEN p_encrypted_credentials ->> 'bitfinex_api_secret'
            ELSE bitfinex_api_secret
        END,
        telegram_bot_token = CASE
            WHEN p_encrypted_credentials ? 'telegram_bot_token'
            THEN p_encrypted_credentials ->> 'telegram_bot_token'
            ELSE telegram_bot_token
        END,
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND bitfinex_api_key IS NOT DISTINCT FROM (p_expected_credentials ->> 'bitfinex_api_key')
      AND bitfinex_api_secret IS NOT DISTINCT FROM (p_expected_credentials ->> 'bitfinex_api_secret')
      AND telegram_bot_token IS NOT DISTINCT FROM (p_expected_credentials ->> 'telegram_bot_token')
    RETURNING user_id INTO updated_user_id;

    RETURN updated_user_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_user_bot_settings_credentials(UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_user_bot_settings_credentials(UUID, JSONB, JSONB) TO service_role;
