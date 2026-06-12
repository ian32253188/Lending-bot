import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MLPredictor } from './ml-predictor';

// Mock logger
vi.mock('../../utils/logger', () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
}));

describe('MLPredictor Unit Tests', () => {
  let predictor: MLPredictor;

  beforeEach(() => {
    predictor = new MLPredictor();
  });

  it('should fallback to statistical model if history is too short', () => {
    const mockMarketData = { frr: 0.00035 };
    const prediction = predictor.predict('USD', mockMarketData);
    expect(prediction.direction).toBe('stable');
    expect(prediction.confidence).toBe(0);
    expect(prediction.reason).toContain('歷史數據不足');
  });

  it('should successfully run prediction with weights when history is sufficient', () => {
    // 填充 10 筆歷史快照
    for (let i = 0; i < 10; i++) {
      predictor.pushSnapshot('USD', {
        frr: 0.00035,
        bids: [{ rate: 0.00034, amount: 2000 }],
        asks: [{ rate: 0.00036, amount: 3000 }],
        volume: 50000,
        lastPrice: 0.00035
      });
    }

    const prediction = predictor.predict('USD', {
      frr: 0.00035,
      bids: [{ rate: 0.00034, amount: 2000 }],
      asks: [{ rate: 0.00036, amount: 3000 }],
      volume: 50000,
      lastPrice: 0.00035
    });

    expect(prediction.direction).toBeDefined();
    expect(prediction.confidence).toBeGreaterThanOrEqual(0);
    expect(prediction.confidence).toBeLessThanOrEqual(1);
    expect(prediction.predictedDelta).toBeDefined();
    expect(prediction.reason).toContain('Phase 2 AI 模型預測');
  });
});
