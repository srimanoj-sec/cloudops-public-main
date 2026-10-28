import { Router } from 'express';
import type IORedis from 'ioredis';
import type { Prisma } from '../infra/prisma.js';
import { reportConnectionError } from '../infra/redis.js';

interface CheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

class CheckTimeout extends Error {}

/**
 * Run one dependency check. The response only says `timeout`/`unreachable` —
 * these endpoints are unauthenticated, and driver errors name internal hosts,
 * ports and users. The real cause goes to the (throttled) log.
 */
async function timed(name: string, fn: () => Promise<unknown>, timeoutMs = 2_000): Promise<CheckResult> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeout(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    reportConnectionError(`${name} (health check)`, err);
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof CheckTimeout ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Postgres + Redis round-trips, in parallel, each bounded to 2 s. */
export async function checkDependencies(
  prisma: Prisma,
  redis: IORedis,
): Promise<{ database: CheckResult; redis: CheckResult }> {
  const [database, redisCheck] = await Promise.all([
    timed('database', () => prisma.$queryRaw`SELECT 1`),
    timed('redis', () => redis.ping()),
  ]);
  return { database, redis: redisCheck };
}

/**
 * Health endpoints (unauthenticated; they reveal no estate data):
 *  - GET /health/live  — the process is up (container liveness).
 *  - GET /health/ready — Postgres AND Redis reachable; safe to route traffic (readiness).
 *  - GET /health       — same as ready; kept for existing probes. Backward-compatible
 *                        shape: `status` is 'ok' | 'degraded', plus `time`.
 */
export function createHealthRouter(deps: { prisma: Prisma; redis: IORedis; version: string }): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  });

  const ready = async (_req: unknown, res: import('express').Response) => {
    const { database, redis } = await checkDependencies(deps.prisma, deps.redis);
    const ok = database.ok && redis.ok;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      version: deps.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks: { database, redis },
      ...(ok ? {} : { reason: !database.ok ? 'database unavailable' : 'redis unavailable' }),
    });
  };
  router.get('/health/ready', ready);
  router.get('/health', ready);
  return router;
}
