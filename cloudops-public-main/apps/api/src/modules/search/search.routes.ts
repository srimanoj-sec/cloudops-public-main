import { Router } from 'express';
import { searchQuerySchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import type { SearchService } from './search.service.js';

/** Global search (mounted behind requireAuth). Typed-as-you-go, so generously rate limited. */
export function createSearchRouter(search: SearchService, limit: RateLimiterFactory): Router {
  const router = Router();
  router.get(
    '/',
    limit({ name: 'search', windowMs: 60_000, max: 240, key: byUser }),
    asyncHandler(async (req, res) => {
      res.json(await search.search(parse(searchQuerySchema, req.query), { permissions: req.user?.permissions ?? [] }));
    }),
  );
  return router;
}
