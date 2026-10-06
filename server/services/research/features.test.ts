import { describe, expect, it } from 'vitest';

const { FEATURE_NAMES, buildFeatureVector } = require('./features');
const { makeDecisions, collectCandidatePredictions } = require('./models');

describe('USD shadow feature and decision pipeline', () => {
  it('builds the shared numeric features and UTC cyclical time from minute bars', () => {
    const stamp = Date.UTC(2026, 0, 5, 12, 0);
    const history = Array.from({ length: 8 }, (_, index) => ({
      minute_at: new Date(stamp + index * 60_000),
      features: {
        frr: 0.0003 + index * 0.000001,
        fundingVwap: 0.00031 + index * 0.000001,
        tradeVolume: 100 + index,
        tradeCount: 2,
        tenorDistribution: { 2: 70, 30: 30 },
        bookBids: [{ rate: 0.0003, amount: 80 }],
        bookAsks: [{ rate: 0.0004, amount: 20 }],
      },
    }));

    const features = buildFeatureVector(history, stamp + 7 * 60_000);

    expect(Object.keys(features).sort()).toEqual([...FEATURE_NAMES].sort());
    expect(features.frrChange5m).toBeGreaterThan(0);
    expect(features.bestBid).toBe(0.0003);
    expect(features.bookImbalance5).toBeCloseTo(0.6);
    expect(features.tenorShortShare).toBeCloseTo(0.7);
    expect(features.hourSin).toBeCloseTo(-0.0305, 3);
  });

  it('waits below the FRR/minimum floor, and never applies a maximum rate cap', () => {
    const decisions = makeDecisions([
      { modelId: 'low', modelVersion: 'test', predictedRate: 0.0001 },
      { modelId: 'high', modelVersion: 'test', predictedRate: 0.02 },
    ], {
      decisionAt: new Date().toISOString(), features: {}, frr: 0.0003,
      horizonMinutes: 1440, marketFresh: true,
    });

    expect(decisions[0].recommendation).toBe('wait');
    expect(decisions[0].floorRate).toBe(0.0003);
    expect(decisions[1].recommendation).toBe('offer');
    expect(decisions[1].predictedRate).toBe(0.02);
    expect(decisions[1].simulatedOfferCount).toBeUndefined();
  });

  it('refuses stale inputs and takes P50 while retaining the P10/P90 range', () => {
    const [decision] = makeDecisions([
      { modelId: 'quantile', modelVersion: 'q1', predictedRate: 0.0005, p10Rate: 0.0002, p90Rate: 0.0008 },
    ], {
      decisionAt: new Date().toISOString(), features: {}, frr: 0.0001,
      horizonMinutes: 1440, marketFresh: false,
    });
    expect(decision.recommendation).toBe('wait');
    expect(decision.reason).toBe('stale_market_data');
    expect(decision.predictedRate).toBe(0.0005);
    expect(decision.p10Rate).toBe(0.0002);
    expect(decision.p90Rate).toBe(0.0008);
  });

  it('only exposes trained challengers from a versioned artifact; old model weights are not candidates', () => {
    const now = Date.now();
    const history = [{ minute_at: new Date(now), features: { fundingVwap: 0.0004, tradeVolume: 100 } }];
    const predictions = collectCandidatePredictions(history, { frr: 0.0003 }, null);
    expect(predictions.map(row => row.modelId)).toEqual(['persistence', 'hour_mean']);
  });

  it('scores exported histogram leaves without applying sklearn learning-rate shrinkage twice', () => {
    const artifact = {
      schemaVersion: 1,
      version: 'hgb-test',
      featureNames: ['frr'],
      models: {
        hist_gradient_boosting: {
          kind: 'histGradientBoosting',
          version: 'hgb-test',
          baseline: 0.1,
          learningRate: 0.05,
          trees: [
            [
              { feature: 0, threshold: 0.5, left: 1, right: 2, value: 0, isLeaf: false },
              { feature: -1, threshold: 0, left: 0, right: 0, value: 0.2, isLeaf: true },
              { feature: -1, threshold: 0, left: 0, right: 0, value: -0.1, isLeaf: true },
            ],
            [
              { feature: -1, threshold: 0, left: 0, right: 0, value: 0.04, isLeaf: true },
            ],
          ],
        },
      },
    };
    const predictions = collectCandidatePredictions(
      [{ minute_at: new Date(), features: { fundingVwap: 0.0004, tradeVolume: 0 } }],
      { frr: 0.75 },
      artifact,
    );

    expect(predictions.find(row => row.modelId === 'hist_gradient_boosting')?.predictedRate).toBeCloseTo(0.04);
  });
});
