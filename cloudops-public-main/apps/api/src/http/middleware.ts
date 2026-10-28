import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../infra/logger.js';
import { runWithContext } from '../infra/request-context.js';
import { AppError } from './errors.js';

/** Accept a caller-supplied correlation id only if it looks like one (no log injection). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Assign every request a correlation id (honouring a well-formed incoming
 * `X-Request-Id`), echo it back, and run the rest of the pipeline inside an
 * async context so logs and error responses can reference it.
 */
export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    runWithContext({ requestId, ip: req.ip }, () => next());
  };
}

/** One structured line per request: method, route, status, latency, user. */
export function accessLog(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/health')) return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const meta = {
        requestId: res.locals.requestId as string | undefined,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        route: req.route?.path ? `${req.baseUrl}${req.route.path as string}` : undefined,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        userId: req.user?.id,
        ip: req.ip,
      };
      if (res.statusCode >= 500) logger.error('request failed', meta);
      else logger.info('request', meta);
    });
    next();
  };
}

/** API responses carry user/estate data — never let a shared cache store them. */
export function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

/** JSON 404 for unknown API routes (instead of Express's HTML page). */
export function apiNotFound(): RequestHandler {
  return (req, _res, next) => next(new AppError(404, `No route for ${req.method} ${req.path}`, 'route_not_found'));
}
