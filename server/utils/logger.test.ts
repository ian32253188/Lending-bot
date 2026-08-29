import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDatabase = { saveLog: vi.fn().mockResolvedValue(null) };
const databasePath = require.resolve('../services/database');

describe('Logger Utility JSON Format Tests', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    // Reset NODE_ENV
    process.env.NODE_ENV = originalEnv;
    process.env.LOG_LEVEL = originalLogLevel;
    vi.resetModules();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockDatabase.saveLog.mockResolvedValue(null);
    require.cache[databasePath] = {
      id: databasePath,
      filename: databasePath,
      loaded: true,
      exports: mockDatabase,
    } as any;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    process.env.LOG_LEVEL = originalLogLevel;
  });

  it('should print structured JSON in production mode', () => {
    process.env.NODE_ENV = 'production';
    
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Dynamically import or require logger so it picks up the mock/env
    const logger = require('./logger');
    logger.info('test-cat', 'Hello production', { details: 'extra-info' });

    // Verify it is a valid JSON string
    const calls = consoleSpy.mock.calls;
    const output = calls[calls.length - 1][0];
    expect(() => JSON.parse(output)).not.toThrow();
    
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe('INFO');
    expect(parsed.category).toBe('test-cat');
    expect(parsed.message).toBe('Hello production');
    expect(parsed.metadata).toEqual({ details: 'extra-info' });
  });

  it('should print standard human-readable text in non-production mode', () => {
    process.env.NODE_ENV = 'development';
    
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    const logger = require('./logger');
    logger.info('test-cat', 'Hello development', { details: 'extra-info' });

    const calls = consoleSpy.mock.calls;
    const output = calls[calls.length - 1][0];
    
    // Should NOT be JSON
    expect(() => JSON.parse(output)).toThrow();
    expect(output).toContain('[test-cat] Hello development');
  });

  it('should not persist debug messages to operation_logs', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_LEVEL = 'debug';

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const database = require('../services/database');
    const saveLogSpy = vi.spyOn(database, 'saveLog');
    const logger = require('./logger');

    logger.debug('strategy', 'high-frequency diagnostic');

    expect(consoleSpy).toHaveBeenCalled();
    expect(saveLogSpy).not.toHaveBeenCalled();
  });

  it('should deduplicate repeated warnings and report suppressed count later', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_LEVEL = 'warn';
    vi.useFakeTimers();

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const database = require('../services/database');
    const logger = require('./logger');

    logger.warn('bitfinex-ws', '連線暫時中斷', { dedupeKey: 'public-ws' });
    logger.warn('bitfinex-ws', '連線暫時中斷', { dedupeKey: 'public-ws' });
    expect(database.saveLog).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    logger.warn('bitfinex-ws', '連線暫時中斷', { dedupeKey: 'public-ws' });
    expect(database.saveLog).toHaveBeenCalledTimes(2);
    expect(database.saveLog.mock.calls[1][3]).toMatchObject({
      suppressedCount: 1,
      suppressionWindowMs: 5 * 60 * 1000,
    });
    expect(consoleSpy).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
