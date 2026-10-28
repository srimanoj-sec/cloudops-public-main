import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import { describeError, reportConnectionError, reportConnectionRestored } from './redis.js';

describe('describeError', () => {
  it('digs the cause out of an AggregateError (whose own message is empty)', () => {
    const agg = new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:6379')], '');
    expect(describeError(agg)).toBe('connect ECONNREFUSED 127.0.0.1:6379');
  });
  it('falls back to the error code, then the name', () => {
    expect(describeError(Object.assign(new Error(''), { code: 'ETIMEDOUT' }))).toBe('ETIMEDOUT');
    expect(describeError(new TypeError(''))).toBe('TypeError');
    expect(describeError('plain')).toBe('plain');
  });
});

describe('reportConnectionError — an outage is a few lines, not thousands', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the first error, suppresses repeats, and logs recovery once', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    for (let i = 0; i < 500; i++) reportConnectionError('redis (test)', new Error('read ECONNRESET'));
    expect(warn).toHaveBeenCalledTimes(1);
    reportConnectionRestored('redis (test)');
    reportConnectionRestored('redis (test)');
    expect(info).toHaveBeenCalledTimes(1);
    // A new outage after recovery is reported again straight away.
    reportConnectionError('redis (test)', new Error('read ECONNRESET'));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
