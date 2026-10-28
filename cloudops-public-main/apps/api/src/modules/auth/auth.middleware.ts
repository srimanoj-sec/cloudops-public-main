import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Permission } from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import { currentContext } from '../../infra/request-context.js';
import type { AuthProvider, AuthenticatedUser } from './auth.provider.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/** Requires a valid Bearer access token for an active user; attaches req.user. */
export function requireAuth(auth: AuthProvider): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return next(AppError.unauthorized('Missing bearer token'));
    }
    const token = header.slice('Bearer '.length);
    auth
      .verifyAccessToken(token)
      .then((user) => {
        req.user = user;
        const ctx = currentContext();
        if (ctx) ctx.userId = user.id; // every later log line carries the user
        next();
      })
      .catch(next);
  };
}

/** Requires the authenticated user to hold at least one of the given roles. */
export function requireRole(...roles: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(AppError.unauthorized());
    const has = req.user.roles.some((r) => roles.includes(r));
    if (!has) return next(AppError.forbidden('Insufficient role'));
    next();
  };
}

/**
 * Requires the caller to hold at least one of the given permissions (from the
 * role → permission map in @cloudops/core). Prefer this over requireRole: routes
 * say what they do, roles stay a bundling concern.
 */
export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(AppError.unauthorized());
    const has = permissions.some((p) => req.user!.permissions.includes(p));
    if (!has) return next(AppError.forbidden('You don’t have permission to do this'));
    next();
  };
}

/** True when the caller holds the permission. */
export function can(req: Request, permission: Permission): boolean {
  return Boolean(req.user?.permissions.includes(permission));
}
