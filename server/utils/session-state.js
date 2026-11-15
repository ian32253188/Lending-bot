const { EventEmitter } = require('node:events');
const db = require('../services/database');
const jwt = require('jsonwebtoken');

const events = new EventEmitter();
let state = null;
let initializationPromise = null;
let revocationInProgress = false;
let revocationUncertain = false;
let revocationQueue = Promise.resolve();

function normalizeState(row) {
    const version = Number(row?.version);
    if (!Number.isSafeInteger(version) || version < 0) {
        throw new Error('管理員工作階段版本資料無效');
    }
    const revokedAtValue = row?.revoked_at_ms ?? row?.revokedAtMs;
    const revokedAtMs = revokedAtValue == null ? null : Number(revokedAtValue);
    return {
        version,
        revokedAtMs: Number.isFinite(revokedAtMs) ? revokedAtMs : null,
    };
}

async function initialize() {
    if (state) return state;
    if (!initializationPromise) {
        initializationPromise = (async () => {
            if (!db.isPostgresConfigured()) {
                const supabase = db.getSupabase();
                if (!supabase) {
                    if (process.env.NODE_ENV === 'production') {
                        throw new Error('正式環境必須設定 PostgreSQL 或可讀寫的 Supabase，才能持久化撤銷管理員工作階段');
                    }
                    state = { version: 0, revokedAtMs: null };
                    return state;
                }

                const { data, error } = await supabase
                    .from('bot_settings')
                    .select('value')
                    .eq('key', 'auth_session_state')
                    .maybeSingle();
                if (error) throw error;
                if (data?.value) {
                    state = normalizeState(data.value);
                    return state;
                }

                const initialState = { version: 0, revokedAtMs: null };
                const { data: inserted, error: insertError } = await supabase
                    .from('bot_settings')
                    .upsert({ key: 'auth_session_state', value: initialState, updated_at: new Date().toISOString() }, { onConflict: 'key' })
                    .select('value')
                    .single();
                if (insertError || !inserted?.value) throw insertError || new Error('無法建立管理員工作階段狀態');
                state = normalizeState(inserted.value);
                return state;
            }

            await db.query(`
                CREATE TABLE IF NOT EXISTS auth_session_state (
                    id SMALLINT PRIMARY KEY CHECK (id = 1),
                    version BIGINT NOT NULL DEFAULT 0,
                    revoked_at TIMESTAMPTZ
                );
                INSERT INTO auth_session_state (id, version, revoked_at)
                VALUES (1, 0, NULL)
                ON CONFLICT (id) DO NOTHING;
            `);
            const result = await db.query(`
                SELECT version, EXTRACT(EPOCH FROM revoked_at) * 1000 AS revoked_at_ms
                FROM auth_session_state
                WHERE id = 1;
            `);
            if (!result?.rows?.[0]) throw new Error('無法讀取管理員工作階段狀態');
            state = normalizeState(result.rows[0]);
            return state;
        })();
    }
    try {
        return await initializationPromise;
    } finally {
        initializationPromise = null;
    }
}

async function getState() {
    if (revocationInProgress || revocationUncertain) {
        throw new Error('管理員工作階段撤銷狀態尚未確認');
    }
    return state || initialize();
}

function isLocalTokenCurrent(claims, currentState) {
    const tokenVersion = Number(claims?.sv ?? 0);
    return Number.isSafeInteger(tokenVersion) && tokenVersion === currentState.version;
}

function isSupabaseTokenCurrent(token, currentState) {
    if (currentState.revokedAtMs === null) return true;
    const issuedAt = Number(jwt.decode(token)?.iat);
    return Number.isFinite(issuedAt) && issuedAt * 1000 > currentState.revokedAtMs;
}

async function revokeOnce() {
    const currentState = await getState();
    revocationInProgress = true;
    if (db.isPostgresConfigured()) {
        try {
            const result = await db.query(`
                INSERT INTO auth_session_state (id, version, revoked_at)
                VALUES (1, 1, NOW())
                ON CONFLICT (id) DO UPDATE
                    SET version = auth_session_state.version + 1,
                        revoked_at = NOW()
                RETURNING version, EXTRACT(EPOCH FROM revoked_at) * 1000 AS revoked_at_ms;
            `);
            if (!result?.rows?.[0]) throw new Error('無法撤銷管理員工作階段');
            state = normalizeState(result.rows[0]);
        } catch (error) {
            // The database may have committed even if the response was lost.
            // Block all future auth and close live sockets until process restart
            // reloads the durable version from the database.
            state = null;
            revocationUncertain = true;
            events.emit('revoked', currentState.version + 1);
            throw error;
        }
    } else {
        const supabase = db.getSupabase();
        if (supabase) {
            try {
                const nextState = { version: currentState.version + 1, revokedAtMs: Date.now() };
                const { data, error } = await supabase
                    .from('bot_settings')
                    .upsert({ key: 'auth_session_state', value: nextState, updated_at: new Date().toISOString() }, { onConflict: 'key' })
                    .select('value')
                    .single();
                if (error || !data?.value) throw error || new Error('無法撤銷管理員工作階段');
                state = normalizeState(data.value);
            } catch (error) {
                state = null;
                revocationUncertain = true;
                events.emit('revoked', currentState.version + 1);
                throw error;
            }
        } else if (process.env.NODE_ENV === 'production') {
            revocationUncertain = true;
            events.emit('revoked', currentState.version + 1);
            throw new Error('正式環境無法持久化管理員工作階段撤銷');
        } else {
            state = { version: currentState.version + 1, revokedAtMs: Date.now() };
        }
    }
    events.emit('revoked', state.version);
    return state;
}

function revokeAll() {
    const operation = revocationQueue.then(revokeOnce);
    revocationQueue = operation.catch(() => {});
    return operation.finally(() => {
        if (!revocationUncertain) revocationInProgress = false;
    });
}

module.exports = { initialize, getState, isLocalTokenCurrent, isSupabaseTokenCurrent, revokeAll, events };
