import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ResearchPanel from './ResearchPanel';

describe('ResearchPanel', () => {
    beforeEach(() => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                databaseReady: true,
                market: { fresh: true, ageSeconds: 12, latestAt: '2026-10-06T04:00:00Z', count: 80, coverage60Days: 0.001, gaps24h: 2, collectionErrors24h: 1 },
                fills: { count: 8, matched: 6 },
                models: [{ model_id: 'persistence', predictions: 40, labeled: 0, mae: null }],
                experiments: [],
                collection: { state: 'healthy', modelArtifactLoaded: false },
                horizon: { locked: false, minutes: 1440 },
                evaluation: { elapsedDays: 0.1, stage: 'warmup', insufficientData: false },
                retentionDays: 180,
                simulation: { offersPerModel: 14, amountPerOffer: 500, nominalPerModel: 7000 },
            }),
        });
    });

    it('separates shadow simulations from real strategy and shows missing model readiness', async () => {
        render(<ResearchPanel token="private-token" />);

        expect(await screen.findByRole('heading', { name: 'USD 影子研究' })).toBeInTheDocument();
        expect(screen.getByText(/不會送出或取消訂單/)).toBeInTheDocument();
        expect(screen.getByText('現行策略基準')).toBeInTheDocument();
        expect(screen.getByText('Ridge regression')).toBeInTheDocument();
        expect(screen.getAllByText('等待離線訓練')).toHaveLength(4);
        expect(screen.getByText(/缺口：2；收集錯誤：1/)).toBeInTheDocument();
        expect(globalThis.fetch).toHaveBeenCalledWith('/api/research/status', expect.objectContaining({
            headers: { Authorization: 'Bearer private-token' },
        }));
    });
});
