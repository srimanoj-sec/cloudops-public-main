import { Router } from 'express';
import { topologyClusterQuerySchema, topologyNeighborhoodSchema, topologyQuerySchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import type { TopologyService } from './topology.service.js';

export function createTopologyRouter(topology: TopologyService): Router {
  const router = Router();

  // Resource graph for a scope (org / subscription / RG / type / region / category).
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json(await topology.graph(parse(topologyQuerySchema, req.query)));
    }),
  );

  // Map view: the scope aggregated into clusters with edge counts between them.
  router.get(
    '/clusters',
    asyncHandler(async (req, res) => {
      res.json(await topology.clusters(parse(topologyClusterQuerySchema, req.query)));
    }),
  );

  // Focus view: one resource and what it connects to, N hops out.
  router.get(
    '/neighborhood/:id',
    asyncHandler(async (req, res) => {
      res.json(await topology.neighborhood(req.params.id as string, parse(topologyNeighborhoodSchema, req.query)));
    }),
  );

  return router;
}
