import { describe, expect, it } from 'vitest';
import { getEngineBadge } from './engine-status';

describe('engine status badge', () => {
    it('does not label a running process as lending when Bitfinex account sync fails', () => {
        const badge = getEngineBadge({
            running: true,
            paused: false,
            accountDataError: 'Bitfinex 拒絕 API 簽章',
            accountDataComplete: false,
        });

        expect(badge.label).toContain('帳戶同步異常');
        expect(badge.className).toBe('degraded');
        expect(badge.title).toContain('不可視為正常放貸');
    });

    it('shows normal operation only when account status is not degraded', () => {
        expect(getEngineBadge({ running: true, paused: false, accountDataComplete: true }).label)
            .toBe('放貸中');
    });
});
