import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import FundingMarketDashboard from './FundingMarketDashboard';

const summary = {
    volume24h: 123456,
    high24hApy: 12.5,
    currentApy: 8.94,
    average30dApy: 8,
    high30dApy: 13.58,
    low30dApy: 0.03,
    history: [
        { timestamp: '2026-08-01T00:00:00Z', avgRate: 0.0002, highRate: 0.0004, lowRate: 0.0001 },
        { timestamp: '2026-08-02T00:00:00Z', avgRate: 0.0003, highRate: 0.0005, lowRate: 0.00015 },
    ],
    hourlyMatches24: [{
        timestamp: '2026-08-29T15:00:00+08:00',
        count: 2,
        minApy: 8,
        maxApy: 10,
        amount: 1500,
        details: [
            { id: 'large', timestamp: '2026-08-29T15:30:00+08:00', amount: 1000, period: 120, apy: 8 },
            { id: 'small', timestamp: '2026-08-29T15:31:00+08:00', amount: 500, period: 2, apy: 10 },
        ],
    }],
};

describe('FundingMarketDashboard interactions', () => {
    beforeEach(() => {
        vi.useRealTimers();
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => summary,
        });
    });

    it('shows a single-point tooltip when hovering the 30-day chart', async () => {
        render(<FundingMarketDashboard token="test-token" />);
        const chart = await screen.findByRole('img', { name: 'fUSD 30 日利率走勢' });
        Object.defineProperty(chart, 'getBoundingClientRect', { value: () => ({ left: 0, width: 720 }) });

        fireEvent.mouseMove(chart, { clientX: 360 });

        expect(await screen.findByText('最高')).toBeInTheDocument();
        expect(screen.getByText('18.25%')).toBeInTheDocument();
        expect(screen.getByText('10.95%')).toBeInTheDocument();
    });

    it('opens hourly details and sorts by amount, period, and APY controls', async () => {
        render(<FundingMarketDashboard token="test-token" />);
        const rate = await screen.findByText('8.00% - 10.00%');
        fireEvent.click(rate.closest('button'));

        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByRole('heading', { name: /撮合明細（USD）/ })).toBeInTheDocument();
        const rowsBefore = [...dialog.querySelectorAll('.market-detail-row')].map(row => row.textContent);
        expect(rowsBefore[0]).toContain('1,000');

        fireEvent.click(within(dialog).getByRole('button', { name: '依金額排序' }));
        const rowsByAmount = [...dialog.querySelectorAll('.market-detail-row')].map(row => row.textContent);
        expect(rowsByAmount[0]).toContain('500');

        fireEvent.click(within(dialog).getByRole('button', { name: '依天數排序' }));
        const rowsByPeriod = [...dialog.querySelectorAll('.market-detail-row')].map(row => row.textContent);
        expect(rowsByPeriod[0]).toContain('1,000');

        fireEvent.click(within(dialog).getByRole('button', { name: '依成交利率排序' }));
        const rowsByApy = [...dialog.querySelectorAll('.market-detail-row')].map(row => row.textContent);
        expect(rowsByApy[0]).toContain('500');
    });

    it('renders an API error instead of silently showing stale market data', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            json: async () => ({ error: '市場資料服務暫時無法使用' }),
        });

        render(<FundingMarketDashboard token="test-token" />);

        await waitFor(() => expect(screen.getByText('市場資料服務暫時無法使用')).toBeInTheDocument());
        expect(screen.queryByText('撮合明細（USD）')).not.toBeInTheDocument();
    });
});
