import { describe, it, expect } from 'vitest';

const { buildOfferEpisodes, analyzeReofferBenefit } = require('./reoffer');

describe('reoffer analysis', () => {
  it('should reconstruct a 3-hour reoffer chain and match the final filled loan', () => {
    const offers = [
      {
        offer_id: 1,
        currency: 'USD',
        amount: 500,
        rate: 0.00040,
        period: 2,
        status: 'closed',
        created_at: '2026-06-01T00:00:00.000Z',
        closed_at: '2026-06-01T03:00:00.000Z',
        updated_at: '2026-06-01T03:00:00.000Z',
      },
      {
        offer_id: 2,
        currency: 'USD',
        amount: 500,
        rate: 0.000384,
        period: 2,
        status: 'closed',
        created_at: '2026-06-01T03:02:00.000Z',
        closed_at: '2026-06-01T04:00:00.000Z',
        updated_at: '2026-06-01T04:00:00.000Z',
      },
    ];

    const loans = [
      {
        loan_id: 10,
        currency: 'USD',
        amount: 500,
        rate: 0.000384,
        period: 2,
        opened_at: '2026-06-01T04:01:00.000Z',
      },
    ];

    const episodes = buildOfferEpisodes(offers, loans);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].reofferCount).toBe(1);
    expect(episodes[0].matchedLoan.loan_id).toBe(10);
    expect(episodes[0].filled).toBe(true);
  });

  it('should recommend reconsidering fixed reoffers when fills are slow and market drop is smaller than the cut', () => {
    const offers = [
      {
        offer_id: 1,
        currency: 'USD',
        amount: 500,
        rate: 0.00040,
        period: 2,
        status: 'closed',
        created_at: '2026-06-01T00:00:00.000Z',
        closed_at: '2026-06-01T03:00:00.000Z',
        updated_at: '2026-06-01T03:00:00.000Z',
      },
      {
        offer_id: 2,
        currency: 'USD',
        amount: 500,
        rate: 0.000384,
        period: 2,
        status: 'closed',
        created_at: '2026-06-01T03:02:00.000Z',
        closed_at: '2026-06-01T12:00:00.000Z',
        updated_at: '2026-06-01T12:00:00.000Z',
      },
      {
        offer_id: 3,
        currency: 'USD',
        amount: 500,
        rate: 0.00042,
        period: 2,
        status: 'closed',
        created_at: '2026-06-02T00:00:00.000Z',
        closed_at: '2026-06-02T03:00:00.000Z',
        updated_at: '2026-06-02T03:00:00.000Z',
      },
      {
        offer_id: 4,
        currency: 'USD',
        amount: 500,
        rate: 0.0004032,
        period: 2,
        status: 'active',
        created_at: '2026-06-02T03:03:00.000Z',
        updated_at: '2026-06-02T12:00:00.000Z',
      },
      {
        offer_id: 5,
        currency: 'USD',
        amount: 500,
        rate: 0.00039,
        period: 2,
        status: 'closed',
        created_at: '2026-06-03T00:00:00.000Z',
        closed_at: '2026-06-03T03:00:00.000Z',
        updated_at: '2026-06-03T03:00:00.000Z',
      },
      {
        offer_id: 6,
        currency: 'USD',
        amount: 500,
        rate: 0.0003744,
        period: 2,
        status: 'closed',
        created_at: '2026-06-03T03:02:00.000Z',
        closed_at: '2026-06-03T10:30:00.000Z',
        updated_at: '2026-06-03T10:30:00.000Z',
      },
      {
        offer_id: 7,
        currency: 'USD',
        amount: 500,
        rate: 0.00041,
        period: 2,
        status: 'closed',
        created_at: '2026-06-04T00:00:00.000Z',
        closed_at: '2026-06-04T03:00:00.000Z',
        updated_at: '2026-06-04T03:00:00.000Z',
      },
      {
        offer_id: 8,
        currency: 'USD',
        amount: 500,
        rate: 0.0003936,
        period: 2,
        status: 'closed',
        created_at: '2026-06-04T03:04:00.000Z',
        closed_at: '2026-06-04T12:30:00.000Z',
        updated_at: '2026-06-04T12:30:00.000Z',
      },
      {
        offer_id: 9,
        currency: 'USD',
        amount: 500,
        rate: 0.00043,
        period: 2,
        status: 'closed',
        created_at: '2026-06-05T00:00:00.000Z',
        closed_at: '2026-06-05T03:00:00.000Z',
        updated_at: '2026-06-05T03:00:00.000Z',
      },
      {
        offer_id: 10,
        currency: 'USD',
        amount: 500,
        rate: 0.0004128,
        period: 2,
        status: 'closed',
        created_at: '2026-06-05T03:03:00.000Z',
        closed_at: '2026-06-05T11:30:00.000Z',
        updated_at: '2026-06-05T11:30:00.000Z',
      },
    ];

    const loans = [
      {
        loan_id: 20,
        currency: 'USD',
        amount: 500,
        rate: 0.0003744,
        period: 2,
        opened_at: '2026-06-03T10:31:00.000Z',
      },
      {
        loan_id: 21,
        currency: 'USD',
        amount: 500,
        rate: 0.0004128,
        period: 2,
        opened_at: '2026-06-05T11:31:00.000Z',
      },
    ];

    const rateHistory = [
      { currency: 'USD', frr: 0.00040, recorded_at: '2026-06-01T00:00:00.000Z' },
      { currency: 'USD', frr: 0.000395, recorded_at: '2026-06-01T03:00:00.000Z' },
      { currency: 'USD', frr: 0.00042, recorded_at: '2026-06-02T00:00:00.000Z' },
      { currency: 'USD', frr: 0.000415, recorded_at: '2026-06-02T03:00:00.000Z' },
      { currency: 'USD', frr: 0.00039, recorded_at: '2026-06-03T00:00:00.000Z' },
      { currency: 'USD', frr: 0.000387, recorded_at: '2026-06-03T03:00:00.000Z' },
      { currency: 'USD', frr: 0.00041, recorded_at: '2026-06-04T00:00:00.000Z' },
      { currency: 'USD', frr: 0.000406, recorded_at: '2026-06-04T03:00:00.000Z' },
      { currency: 'USD', frr: 0.00043, recorded_at: '2026-06-05T00:00:00.000Z' },
      { currency: 'USD', frr: 0.000425, recorded_at: '2026-06-05T03:00:00.000Z' },
    ];

    const result = analyzeReofferBenefit({ offers, loans, rateHistory }, { minSampleSize: 4 });
    expect(result.summary.reofferedEpisodes).toBe(5);
    expect(result.summary.recommendation).toBe('reconsider_reoffer');
    expect(result.summary.harmfulCount).toBeGreaterThanOrEqual(3);
  });
});
