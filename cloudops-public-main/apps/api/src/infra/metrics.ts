import { timingSafeEqual } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { withQueueTimeout } from './bullmq.js';

/**
 * Minimal Prometheus exposition (text format 0.0.4) — no client library.
 * Label values are route *templates* and status classes, never raw paths or
 * ids, so cardinality stays bounded however much traffic there is.
 */

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

const requests = new Map<string, number>();
const durations = new Map<string, Histogram>();
const counters = new Map<string, number>();
/** Guard against unbounded label sets (e.g. a scanner hitting random routes). */
const MAX_SERIES = 2_000;

const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (l: Record<string, string>) =>
  `{${Object.entries(l)
    .map(([k, v]) => `${k}="${escape(v)}"`)
    .join(',')}}`;

/** Increment a named counter with labels (e.g. job failures by queue). */
export function incCounter(name: string, l: Record<string, string>, by = 1): void {
  const key = `${name}${labels(l)}`;
  if (!counters.has(key) && counters.size >= MAX_SERIES) return;
  counters.set(key, (counters.get(key) ?? 0) + by);
}

function observeRequest(method: string, route: string, status: number, seconds: number): void {
  const statusClass = `${Math.floor(status / 100)}xx`;
  const key = labels({ method, route, status: statusClass });
  if (!requests.has(key) && requests.size >= MAX_SERIES) return;
  requests.set(key, (requests.get(key) ?? 0) + 1);
  const hKey = labels({ method, route });
  let h = durations.get(hKey);
  if (!h) {
    if (durations.size >= MAX_SERIES) return;
    h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    durations.set(hKey, h);
  }
  h.sum += seconds;
  h.count += 1;
  BUCKETS.forEach((b, i) => {
    if (seconds <= b) h!.buckets[i]! += 1;
  });
}

/** Record every API request by method, route template and status class. */
export function httpMetrics(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/health') || req.path === '/metrics') return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path as string}` : 'unmatched';
      observeRequest(
        req.method,
        route,
        res.statusCode,
        Number(process.hrtime.bigint() - start) / 1e9,
      );
    });
    next();
  };
}

async function render(queues: Queue[]): Promise<string> {
  const out: string[] = [];
  out.push('# HELP cloudops_http_requests_total API requests by method, route and status class.');
  out.push('# TYPE cloudops_http_requests_total counter');
  for (const [k, v] of requests) out.push(`cloudops_http_requests_total${k} ${v}`);

  out.push('# HELP cloudops_http_request_duration_seconds API request latency.');
  out.push('# TYPE cloudops_http_request_duration_seconds histogram');
  for (const [k, h] of durations) {
    const inner = k.slice(1, -1);
    BUCKETS.forEach((b, i) =>
      out.push(`cloudops_http_request_duration_seconds_bucket{${inner},le="${b}"} ${h.buckets[i]}`),
    );
    out.push(`cloudops_http_request_duration_seconds_bucket{${inner},le="+Inf"} ${h.count}`);
    out.push(`cloudops_http_request_duration_seconds_sum${k} ${h.sum.toFixed(6)}`);
    out.push(`cloudops_http_request_duration_seconds_count${k} ${h.count}`);
  }

  const byName = new Map<string, string[]>();
  for (const [k, v] of counters) {
    const name = k.slice(0, k.indexOf('{'));
    byName.set(name, [...(byName.get(name) ?? []), `${k} ${v}`]);
  }
  for (const [name, lines] of byName) {
    out.push(`# TYPE ${name} counter`, ...lines);
  }

  out.push('# HELP cloudops_queue_jobs Background jobs by queue and state (read at scrape time).');
  out.push('# TYPE cloudops_queue_jobs gauge');
  const counts = await Promise.all(
    queues.map((q) =>
      withQueueTimeout(q.getJobCounts('waiting', 'active', 'delayed', 'failed'), 1_500).catch(
        () => null,
      ),
    ),
  );
  queues.forEach((q, i) => {
    const c = counts[i];
    if (!c) return;
    for (const [state, n] of Object.entries(c))
      out.push(`cloudops_queue_jobs${labels({ queue: q.name, state })} ${n}`);
  });
  out.push('# HELP cloudops_queue_up 1 when the queue answered within the scrape timeout.');
  out.push('# TYPE cloudops_queue_up gauge');
  queues.forEach((q, i) =>
    out.push(`cloudops_queue_up${labels({ queue: q.name })} ${counts[i] ? 1 : 0}`),
  );

  const mem = process.memoryUsage();
  out.push(
    '# TYPE cloudops_process_resident_memory_bytes gauge',
    `cloudops_process_resident_memory_bytes ${mem.rss}`,
  );
  out.push(
    '# TYPE cloudops_process_heap_used_bytes gauge',
    `cloudops_process_heap_used_bytes ${mem.heapUsed}`,
  );
  out.push(
    '# TYPE cloudops_process_uptime_seconds gauge',
    `cloudops_process_uptime_seconds ${Math.round(process.uptime())}`,
  );
  return `${out.join('\n')}\n`;
}

/**
 * GET /metrics for Prometheus. Disabled (404) unless METRICS_TOKEN is set;
 * scrapes must send `Authorization: Bearer <token>`. The output carries no
 * estate data — only request/queue/process counters.
 */
export function createMetricsRouter(queues: Queue[], token: string | undefined): Router {
  const router = createRouter();
  router.get('/metrics', async (req, res, next) => {
    if (!token) return next();
    const given = Buffer.from((req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      res.status(401).type('text/plain').send('unauthorized\n');
      return;
    }
    try {
      res.type('text/plain; version=0.0.4').send(await render(queues));
    } catch (err) {
      next(err);
    }
  });
  return router;
}

/** For tests. */
export function resetMetrics(): void {
  requests.clear();
  durations.clear();
  counters.clear();
}
