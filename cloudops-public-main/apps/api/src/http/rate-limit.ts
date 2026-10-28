import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type IORedis from 'ioredis';
import { logger } from '../infra/logger.js';

/**
 * Fixed-window rate limiting backed by Redis (already a platform dependency, so
 * limits are shared across processes and survive API restarts).
 *
 * Fails OPEN: if Redis is slow or down, requests are allowed and a warning is
 * logged — abuse protection must never become an availability outage.
 */

export interface RateLimitRule {
  /** Namespace for the counter (e.g. 'login'). */
  name: string;
  windowMs: number;
  max: number;
  /** What to count by. Default: client IP. */
  key?: (req: Request) => string;
}

/** Atomic INCR + first-hit expiry; returns [count, ttlMs]. */
const INCR_WINDOW = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { c, redis.call('PTTL', KEYS[1]) }
`;

export const byIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';
export const byUser = (req: Request): string => req.user?.id ?? `ip:${byIp(req)}`;

export interface RateLimiterFactory {
  (rule: RateLimitRule): RequestHandler;
}

export function createRateLimiter(redis: IORedis | null, enabled: boolean): RateLimiterFactory {
  return (rule) => {
    const keyOf = rule.key ?? byIp;
    return (req: Request, res: Response, next: NextFunction) => {
      if (!enabled || !redis) return next();
      const key = `cloudops:rl:${rule.name}:${keyOf(req)}`;
      (redis.eval(INCR_WINDOW, 1, key, String(rule.windowMs)) as Promise<[number, number]>)
        .then(([count, ttlMs]) => {
          const resetSeconds = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : rule.windowMs) / 1000));
          res.setHeader('RateLimit-Limit', String(rule.max));
          res.setHeader('RateLimit-Remaining', String(Math.max(0, rule.max - count)));
          res.setHeader('RateLimit-Reset', String(resetSeconds));
          if (count > rule.max) {
            res.setHeader('Retry-After', String(resetSeconds));
            res.status(429).json({
              error: {
                code: 'rate_limited',
                message: `Too many requests — try again in ${resetSeconds} second${resetSeconds === 1 ? '' : 's'}.`,
                retryAfterSeconds: resetSeconds,
                requestId: res.locals.requestId,
              },
            });
            return;
          }
          next();
        })
        .catch((err: unknown) => {
          logger.warn('rate limiter unavailable; allowing request', {
            limiter: rule.name,
            error: err instanceof Error ? err.message : String(err),
          });
          next();
        });
    };
  };
}
