import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import StatusPanel from './StatusPanel';

describe('StatusPanel private account data', () => {
    it('shows unavailable account data as unavailable rather than zero', () => {
        render(<StatusPanel status={{
            running: true,
            paused: false,
            accountDataAvailable: false,
            accountDataComplete: false,
            accountDataError: 'Bitfinex 私有 API 讀取失敗；請確認 Funding Read 權限。',
            wallets: {
                USD: { balance: null, available: null },
            },
            activeOffers: { USD: null },
            activeCredits: { USD: null },
        }} />);

        expect(screen.getByText(/私有帳戶資料無法讀取/)).toBeInTheDocument();
        expect(screen.getByText(/請確認 Funding Read 權限/)).toBeInTheDocument();
        expect(screen.queryByText('0.00')).not.toBeInTheDocument();
        expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    });
});
