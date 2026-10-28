import { Router } from 'express';
import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
} from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { AppError } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import { byIp, byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import { actorOf } from '../audit/audit.service.js';
import { requireAuth, requirePermission } from './auth.middleware.js';
import type { LocalJwtAuthProvider } from './auth.service.js';

const FIFTEEN_MIN = 15 * 60 * 1000;

export function createAuthRouter(auth: LocalJwtAuthProvider, limit: RateLimiterFactory): Router {
  const router = Router();

  // Brute-force protection: per account+IP (targeted guessing) and per IP (spraying).
  const loginLimits = [
    limit({
      name: 'login-account',
      windowMs: FIFTEEN_MIN,
      max: 10,
      key: (req) =>
        `${byIp(req)}:${String((req.body as { email?: unknown })?.email ?? '')
          .toLowerCase()
          .slice(0, 200)}`,
    }),
    limit({ name: 'login-ip', windowMs: FIFTEEN_MIN, max: 100 }),
  ];

  /**
   * Create a user (viewer role). Admin-only: accounts are managed by admins —
   * see /api/users for full user administration. Request/response unchanged.
   */
  router.post(
    '/register',
    requireAuth(auth),
    requirePermission('users.manage'),
    asyncHandler(async (req, res) => {
      const input = parse(registerSchema, req.body);
      const user = await auth.register(input, actorOf(req));
      res.status(201).json(user);
    }),
  );

  router.post(
    '/login',
    ...loginLimits,
    asyncHandler(async (req, res) => {
      const input = parse(loginSchema, req.body);
      const result = await auth.login(input, req.headers['user-agent']);
      res.json(result);
    }),
  );

  router.post(
    '/refresh',
    limit({ name: 'refresh', windowMs: 60_000, max: 60 }),
    asyncHandler(async (req, res) => {
      const { refreshToken } = parse(refreshSchema, req.body);
      const tokens = await auth.refresh(refreshToken, req.headers['user-agent']);
      res.json(tokens);
    }),
  );

  /** Revoke the session behind a refresh token. Always 204 (idempotent). */
  router.post(
    '/logout',
    limit({ name: 'logout', windowMs: 60_000, max: 60 }),
    asyncHandler(async (req, res) => {
      const { refreshToken } = parse(logoutSchema, req.body);
      await auth.logout(refreshToken);
      res.status(204).end();
    }),
  );

  router.get(
    '/me',
    requireAuth(auth),
    asyncHandler(async (req, res) => {
      if (!req.user) throw AppError.unauthorized();
      const user = await auth.me(req.user.id);
      res.json(user);
    }),
  );

  // ── Your sessions (signed-in devices) ──
  router.get(
    '/sessions',
    requireAuth(auth),
    asyncHandler(async (req, res) => {
      if (!req.user) throw AppError.unauthorized();
      res.json(await auth.listSessions(req.user.id, req.user.sessionId));
    }),
  );

  router.post(
    '/sessions/:id/revoke',
    requireAuth(auth),
    limit({ name: 'session-revoke', windowMs: 60_000, max: 30, key: byUser }),
    asyncHandler(async (req, res) => {
      if (!req.user) throw AppError.unauthorized();
      if (req.params.id === req.user.sessionId)
        throw AppError.badRequest('That’s this browser — use Sign out instead.');
      await auth.revokeOwnSession(req.user.id, req.params.id as string, actorOf(req));
      res.status(204).end();
    }),
  );

  /** Sign out every other device, immediately; returns a fresh session for this browser. */
  router.post(
    '/sessions/revoke-others',
    requireAuth(auth),
    limit({ name: 'session-revoke', windowMs: 60_000, max: 30, key: byUser }),
    asyncHandler(async (req, res) => {
      if (!req.user) throw AppError.unauthorized();
      res.json(
        await auth.signOutEverywhere(req.user.id, actorOf(req), {
          userAgent: req.headers['user-agent'],
        }),
      );
    }),
  );

  /** Change your own password; returns a fresh session (all others are revoked). */
  router.post(
    '/password',
    requireAuth(auth),
    limit({ name: 'password-change', windowMs: FIFTEEN_MIN, max: 10, key: byUser }),
    asyncHandler(async (req, res) => {
      if (!req.user) throw AppError.unauthorized();
      const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
      res.json(
        await auth.changePassword(
          req.user.id,
          currentPassword,
          newPassword,
          req.headers['user-agent'],
        ),
      );
    }),
  );

  return router;
}
