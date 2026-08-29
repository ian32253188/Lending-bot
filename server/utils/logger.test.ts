import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock database saveLog to avoid network/configuration issues in tests
vi.mock('../services/database', () => ({
  saveLog: vi.fn().mockResolvedValue(null)
}));

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
});
