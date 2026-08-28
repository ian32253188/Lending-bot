import { describe, expect, it } from 'vitest';

const metrics = require('./metrics');

describe('operational metrics', () => {
  it('exposes process, active-engine, and Bitfinex API error metrics', async () => {
    metrics.setActiveEngines(2);
    metrics.recordApiError('GET', '/v2/funding/trades/fUSD/hist', 'HTTP_429');
    const output = await metrics.registry.metrics();

    expect(output).toContain('lending_bot_process_cpu_usage_percent');
    expect(output).toContain('lending_bot_process_memory_rss_bytes');
    expect(output).toContain('lending_bot_process_heap_used_bytes');
    expect(output).toContain('lending_bot_active_engines 2');
    expect(output).toContain('lending_bot_api_errors_total');
    expect(output).toContain('lending_bot_last_api_error_timestamp_seconds');
  });
});
