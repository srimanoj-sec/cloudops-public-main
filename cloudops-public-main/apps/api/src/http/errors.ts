import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { logger } from '../infra/logger.js';

/**
 * Typed application error carrying an HTTP status.
 *
 * Error response contract (unchanged shape, additive fields):
 *   { error: { code, message, details?, requestId } }
 * `code` is a stable machine-readable identifier; `message` is safe to show a
 * user; `requestId` lets support correlate a report with the server logs.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(msg: string, details?: unknown) {
    return new AppError(400, msg, 'bad_request', details);
  }
  static unauthorized(msg = 'Unauthorized') {
    return new AppError(401, msg, 'unauthorized');
  }
  static forbidden(msg = 'Forbidden') {
    return new AppError(403, msg, 'forbidden');
  }
  static notFound(msg = 'Not found') {
    return new AppError(404, msg, 'not_found');
  }
  static conflict(msg: string) {
    return new AppError(409, msg, 'conflict');
  }
  static unavailable(msg = 'Service temporarily unavailable') {
    return new AppError(503, msg, 'service_unavailable');
  }
}

/** Errors thrown by Express's JSON body parser. */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

/** Translate known infrastructure errors into client-meaningful AppErrors. */
function normalize(err: unknown): AppError | ZodError | null {
  if (err instanceof AppError || err instanceof ZodError) return err;

  const bp = err as BodyParserError;
  if (bp?.type === 'entity.parse.failed') return new AppError(400, 'Request body is not valid JSON', 'invalid_json');
  if (bp?.type === 'entity.too.large') return new AppError(413, 'Request body is too large', 'payload_too_large');

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2025':
        return AppError.notFound('The requested record was not found');
      case 'P2002':
        return AppError.conflict('A record with this value already exists');
      case 'P2003':
        return AppError.conflict('The operation conflicts with a related record');
      case 'P1001':
      case 'P1002':
      case 'P2024':
        return AppError.unavailable('Database is temporarily unavailable');
    }
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return AppError.unavailable('Database is temporarily unavailable');
  }
  return null;
}

/** Central Express error handler — the single place errors become responses. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = res.locals.requestId as string | undefined;
  const known = normalize(err);

  if (known instanceof ZodError) {
    res.status(400).json({
      error: { code: 'validation_error', message: 'Invalid request', details: known.issues, requestId },
    });
    return;
  }
  if (known) {
    // A deliberate 503 (dependency down) carries nothing the access log line
    // doesn't already have; mapped errors (e.g. Prisma P1001) log their cause.
    const selfExplanatory = known.status === 503 && err === known;
    if (known.status >= 500 && !selfExplanatory) {
      logger.error(known.message, {
        code: known.code,
        method: req.method,
        path: req.path,
        cause: err instanceof Error && err !== known ? err.message : undefined,
      });
    }
    res
      .status(known.status)
      .json({ error: { code: known.code, message: known.message, details: known.details, requestId } });
    return;
  }

  // Unknown failure: full detail to the logs, nothing internal to the client.
  logger.error('Unhandled error', {
    method: req.method,
    path: req.path,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  if (res.headersSent) return;
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong on our side. Please try again.',
      requestId,
    },
  });
}
