import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type IORedis from 'ioredis';
import { Prisma } from '@prisma/client';
import { ZodError, z } from 'zod';
import { createRateLimiter } from './rate-limit.js';
import { AppError, errorHandler } from './errors.js';
import { redact } from '../infra/logger.js';

/** Minimal Express response double capturing status, headers and body. */
function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    locals: { requestId: 'req-123' } as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
  };
  return res;
}
const fakeReq = { ip: '10.0.0.1', method: 'GET', path: '/x', socket: {} } as unknown as Request;

describe('rate limiter', () => {
  function limiterWith(counts: number[]) {
    let i = 0;
    const redis = { eval: vi.fn(async () => [counts[i++] ?? 99, 30_000]) } as unknown as IORedis;
    return createRateLimiter(redis, true)({ name: 't', windowMs: 60_000, max: 2 });
  }

  it('allows requests up to the limit and sets RateLimit headers', async () => {
    const mw = limiterWith([1]);
    const res = fakeRes();
    const next = vi.fn();
    mw(fakeReq, res as unknown as Response, next as NextFunction);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    expect(res.headers['ratelimit-remaining']).toBe('1');
  });

  it('rejects over-limit requests with 429 + Retry-After', async () => {
    const mw = limiterWith([3]);
    const res = fakeRes();
    const next = vi.fn();
    mw(fakeReq, res as unknown as Response, next as NextFunction);
    await vi.waitFor(() => expect(res.statusCode).toBe(429));
    expect(next).not.toHaveBeenCalled();
    expect(res.headers['retry-after']).toBe('30');
    expect((res.body as { error: { code: string } }).error.code).toBe('rate_limited');
  });

  it('fails OPEN when Redis is unavailable', async () => {
    const redis = { eval: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) } as unknown as IORedis;
    const mw = createRateLimiter(redis, true)({ name: 't', windowMs: 60_000, max: 1 });
    const next = vi.fn();
    mw(fakeReq, fakeRes() as unknown as Response, next as NextFunction);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith());
  });

  it('is a no-op when disabled', () => {
    const redis = { eval: vi.fn() } as unknown as IORedis;
    const next = vi.fn();
    createRateLimiter(redis, false)({ name: 't', windowMs: 1, max: 1 })(fakeReq, fakeRes() as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });
});

describe('errorHandler', () => {
  const run = (err: unknown) => {
    const res = fakeRes();
    errorHandler(err, fakeReq, res as unknown as Response, vi.fn());
    return res as typeof res & { body: { error: Record<string, unknown> } };
  };

  it('maps malformed JSON bodies to 400 invalid_json (not 500)', () => {
    const err = Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 });
    const res = run(err);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('maps oversized bodies to 413', () => {
    expect(run(Object.assign(new Error('too large'), { type: 'entity.too.large' })).statusCode).toBe(413);
  });

  it('maps Prisma "record not found" to 404 and unique violations to 409', () => {
    const notFound = new Prisma.PrismaClientKnownRequestError('missing', { code: 'P2025', clientVersion: 'x' });
    const dup = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
    expect(run(notFound).statusCode).toBe(404);
    expect(run(dup).statusCode).toBe(409);
  });

  it('returns validation details for Zod errors', () => {
    let zerr: ZodError | undefined;
    try {
      z.object({ a: z.string() }).parse({});
    } catch (e) {
      zerr = e as ZodError;
    }
    const res = run(zerr);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('hides internals of unknown errors but includes the request id', () => {
    const res = run(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/Cannot read properties/);
    expect(res.body.error.requestId).toBe('req-123');
  });

  it('passes AppErrors through with their status and code', () => {
    const res = run(AppError.forbidden('nope'));
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden', message: 'nope' });
  });
});

describe('redact (log scrubbing)', () => {
  it('scrubs secret-looking keys at any depth', () => {
    const out = redact({
      password: 'p',
      nested: { clientSecret: 's', refreshToken: 't', ok: 1 },
      list: [{ authorization: 'Bearer x' }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/"p"|"s"|"t"|Bearer/);
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });

  it('keeps look-alike but harmless keys', () => {
    expect(redact({ passed: 3, subscriptions: 2 })).toEqual({ passed: 3, subscriptions: 2 });
  });
});
