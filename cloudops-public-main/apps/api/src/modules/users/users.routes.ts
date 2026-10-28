import { Router } from 'express';
import { createUserSchema, resetPasswordSchema, updateUserSchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import { actorOf } from '../audit/audit.service.js';
import type { UsersService } from './users.service.js';
import type { LocalJwtAuthProvider } from '../auth/auth.service.js';

/**
 * People directory for pickers (assignee, @mentions) — every signed-in user may
 * read it, so it carries names only: no emails, roles or account state.
 */
export function createDirectoryRouter(users: UsersService): Router {
  const router = Router();
  router.get(
    '/users',
    asyncHandler(async (_req, res) => {
      res.json(await users.directory());
    }),
  );
  return router;
}

/** User administration (mounted behind requireAuth + requirePermission('users.manage')). */
export function createUsersRouter(
  users: UsersService,
  limit: RateLimiterFactory,
  auth: LocalJwtAuthProvider,
): Router {
  const router = Router();
  const writeLimit = limit({ name: 'users-write', windowMs: 60_000, max: 30, key: byUser });

  // A user's signed-in devices, and "sign out everywhere" (takes effect immediately).
  router.get(
    '/:id/sessions',
    asyncHandler(async (req, res) => {
      res.json(await auth.listSessions(req.params.id as string));
    }),
  );

  router.post(
    '/:id/sign-out',
    writeLimit,
    asyncHandler(async (req, res) => {
      await auth.signOutEverywhere(req.params.id as string, actorOf(req));
      res.status(204).end();
    }),
  );

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(await users.list());
    }),
  );

  router.post(
    '/',
    writeLimit,
    asyncHandler(async (req, res) => {
      res.status(201).json(await users.create(parse(createUserSchema, req.body), actorOf(req)));
    }),
  );

  router.patch(
    '/:id',
    writeLimit,
    asyncHandler(async (req, res) => {
      res.json(
        await users.update(
          req.params.id as string,
          parse(updateUserSchema, req.body),
          actorOf(req),
        ),
      );
    }),
  );

  router.post(
    '/:id/reset-password',
    writeLimit,
    asyncHandler(async (req, res) => {
      const { password } = parse(resetPasswordSchema, req.body);
      await users.resetPassword(req.params.id as string, password, actorOf(req));
      res.status(204).end();
    }),
  );

  return router;
}
