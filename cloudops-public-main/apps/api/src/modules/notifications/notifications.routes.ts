import { Router } from 'express';
import { markNotificationsReadSchema, notificationQuerySchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { AppError } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import type { NotificationService, Reader } from './notifications.service.js';

/** The caller's notification inbox (mounted behind requireAuth). */
export function createNotificationsRouter(notifications: NotificationService): Router {
  const router = Router();
  const reader = (user: Express.Request['user']): Reader => {
    if (!user) throw AppError.unauthorized();
    return { id: user.id, permissions: user.permissions };
  };

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json(await notifications.list(reader(req.user), parse(notificationQuerySchema, req.query)));
    }),
  );

  // Cheap poll for the header bell.
  router.get(
    '/unread-count',
    asyncHandler(async (req, res) => {
      res.json({ unread: await notifications.unreadCount(reader(req.user)) });
    }),
  );

  router.post(
    '/read',
    asyncHandler(async (req, res) => {
      const { ids } = parse(markNotificationsReadSchema, req.body);
      await notifications.markRead(reader(req.user), ids);
      res.status(204).end();
    }),
  );

  router.post(
    '/read-all',
    asyncHandler(async (req, res) => {
      await notifications.markAllRead(reader(req.user));
      res.status(204).end();
    }),
  );

  return router;
}
