import IORedis from 'ioredis';
import { config } from '../env.js';
import { logger } from './logger.js';

/**
 * A useful one-line cause. Connection failures are often an AggregateError
 * (IPv4 + IPv6 attempts) whose own `message` is empty.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const inner = (err as { errors?: unknown[] }).errors?.[0];
  const code = (err as { code?: string }).code;
  return err.message || (inner instanceof Error ? inner.message : '') || code || err.name;
}

interface OutageState {
  lastLoggedAt: number;
  suppressed: number;
  failing: boolean;
}
const outages = new Map<string, OutageState>();
const LOG_EVERY_MS = 60_000;

/**
 * Report a connection error for a component (e.g. `redis (queue)`, `queue sync`).
 * During an outage every client retries continuously, so errors are logged at
 * most once a minute per component, with a count of what was suppressed.
 */
export function reportConnectionError(component: string, err: unknown): void {
  const s = outages.get(component) ?? { lastLoggedAt: 0, suppressed: 0, failing: false };
  outages.set(component, s);
  s.failing = true;
  if (Date.now() - s.lastLoggedAt < LOG_EVERY_MS) {
    s.suppressed += 1;
    return;
  }
  logger.warn(`${component} connection error`, {
    error: describeError(err),
    ...(s.suppressed ? { suppressedSinceLastLog: s.suppressed } : {}),
  });
  s.lastLoggedAt = Date.now();
  s.suppressed = 0;
}

/** Log once when a component that was failing is healthy again. */
export function reportConnectionRestored(component: string): void {
  const s = outages.get(component);
  if (!s?.failing) return;
  outages.delete(component);
  logger.info(`${component} connection restored`);
}

function watch(client: IORedis, name: string): IORedis {
  const component = `redis (${name})`;
  client.on('error', (err: Error) => reportConnectionError(component, err));
  client.on('ready', () => reportConnectionRestored(component));
  return client;
}

/**
 * Shared Redis connection factory for BullMQ. BullMQ requires
 * `maxRetriesPerRequest: null` (commands wait for reconnection instead of
 * failing), so each queue/worker gets its own blocking-tolerant connection.
 */
export function createRedis(): IORedis {
  return watch(new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null }), 'queue');
}

/**
 * Fast-fail client for the request path (rate limits, readiness, locks). When
 * Redis is down, commands reject immediately instead of queueing — callers fail
 * open or report "degraded" rather than hanging an HTTP request.
 */
export const fastRedis: IORedis = watch(
  new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 1_000,
    connectTimeout: 2_000,
  }),
  'request-path',
);
