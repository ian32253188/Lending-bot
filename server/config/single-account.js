// This deployment is intentionally operated as one private lending account.
// Keep this ID aligned with the local administrator identity used by auth.js.
const SINGLE_ACCOUNT_USER_ID = '00000000-0000-0000-0000-000000000001';

function isSingleAccount(userId) {
    return String(userId || '') === SINGLE_ACCOUNT_USER_ID;
}

module.exports = { SINGLE_ACCOUNT_USER_ID, isSingleAccount };
