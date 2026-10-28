import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMetricsRouter, httpMetrics, incCounter, resetMetrics } from './metrics.js';

const TOKEN = 'a-long-enough-metrics-token';

function app(token?: string) {
  const a = express();
  a.use(httpMetrics());
  a.use(createMetricsRouter([], token));
  a.get('/api/things/:id', (_req, res) => {
    res.json({ ok: true });
  });
  return a;
}

describe('/metrics', () => {
  beforeEach(() => resetMetrics());

  it('does not exist unless a token is configured', async () => {
    await request(app()).get('/metrics').expect(404);
  });

  it('rejects a missing or wrong token', async () => {
    await request(app(TOKEN)).get('/metrics').expect(401);
    await request(app(TOKEN)).get('/metrics').set('Authorization', 'Bearer nope').expect(401);
  });

  it('labels requests by route template, not raw path (bounded cardinality)', async () => {
    const a = app(TOKEN);
    await request(a).get('/api/things/123').expect(200);
    await request(a).get('/api/things/456').expect(200);
    incCounter('cloudops_jobs_failed_total', { queue: 'sync' });
    const res = await request(a).get('/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.text).toContain('cloudops_http_requests_total{method="GET",route="/api/things/:id",status="2xx"} 2');
    expect(res.text).not.toContain('/api/things/123');
    expect(res.text).toContain('cloudops_http_request_duration_seconds_count{method="GET",route="/api/things/:id"} 2');
    expect(res.text).toContain('cloudops_jobs_failed_total{queue="sync"} 1');
    expect(res.text).toContain('cloudops_process_uptime_seconds');
  });
});
