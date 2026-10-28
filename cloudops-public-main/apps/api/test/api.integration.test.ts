/**
 * API integration suite — the real app (composition root, middleware, Prisma,
 * Redis) over HTTP. Covers the security and data-integrity guarantees that must
 * never regress: auth/session lifecycle, RBAC, ownership checks, admin guard
 * rails, error contract, rate limiting, audit trail and CSV export.
 * No workers are started and nothing talks to Azure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { prisma } from '../src/infra/prisma.js';
import { fastRedis } from '../src/infra/redis.js';
import { allQueues } from '../src/infra/queue.js';
import { compose } from '../src/composition.js';
import { createApp } from '../src/app.js';

const run = Date.now().toString(36);
const ADMIN = { email: `it-admin-${run}@cloudops.test`, password: `It-Admin-${run}-pass` };
let app: Express;

async function login(email: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.tokens as { accessToken: string; refreshToken: string };
}

beforeAll(async () => {
  for (const key of ['admin', 'operator', 'viewer']) {
    await prisma.role.upsert({ where: { key }, update: {}, create: { key } });
  }
  const admin = await prisma.role.findUniqueOrThrow({ where: { key: 'admin' } });
  await prisma.user.create({
    data: {
      email: ADMIN.email,
      name: 'IT Admin',
      passwordHash: await bcrypt.hash(ADMIN.password, 4),
      roles: { create: [{ roleId: admin.id }] },
    },
  });
  app = createApp(await compose());
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${run}@cloudops.test` } } });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await Promise.allSettled(allQueues.map((q) => q.close()));
  fastRedis.disconnect();
  await prisma.$disconnect();
});

describe('health & error contract', () => {
  it('reports liveness and dependency readiness', async () => {
    expect((await request(app).get('/health/live')).status).toBe(200);
    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.database.ok).toBe(true);
    expect(ready.body.checks.redis.ok).toBe(true);
  });

  it('answers malformed JSON with 400 invalid_json and a request id', async () => {
    const res = await request(app).post('/api/auth/login').set('content-type', 'application/json').send('{oops');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('returns a JSON 404 for unknown API routes', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('route_not_found');
  });

  it('marks API responses as non-cacheable', async () => {
    const t = await login(ADMIN.email, ADMIN.password);
    const res = await request(app).get('/api/auth/me').set('authorization', `Bearer ${t.accessToken}`);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('authentication & sessions', () => {
  it('does not allow anonymous self-registration', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: `x-${run}@cloudops.test`, password: 'whatever123', name: 'x' });
    expect(res.status).toBe(401);
  });

  it('gives the same answer for unknown emails and wrong passwords', async () => {
    const a = await request(app).post('/api/auth/login').send({ email: `ghost-${run}@cloudops.test`, password: 'nope-nope' });
    const b = await request(app).post('/api/auth/login').send({ email: ADMIN.email, password: 'nope-nope' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('rotates refresh tokens and rejects reuse of the old one', async () => {
    const t = await login(ADMIN.email, ADMIN.password);
    const rotated = await request(app).post('/api/auth/refresh').send({ refreshToken: t.refreshToken });
    expect(rotated.status).toBe(200);
    const reused = await request(app).post('/api/auth/refresh').send({ refreshToken: t.refreshToken });
    expect(reused.status).toBe(401);
  });

  it('logout revokes the session and is idempotent', async () => {
    const t = await login(ADMIN.email, ADMIN.password);
    expect((await request(app).post('/api/auth/logout').send({ refreshToken: t.refreshToken })).status).toBe(204);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: t.refreshToken })).status).toBe(401);
    expect((await request(app).post('/api/auth/logout').send({ refreshToken: t.refreshToken })).status).toBe(204);
  });

  it('password change returns a fresh session and revokes the others', async () => {
    const email = `pw-${run}@cloudops.test`;
    const admin = await login(ADMIN.email, ADMIN.password);
    await request(app)
      .post('/api/users')
      .set('authorization', `Bearer ${admin.accessToken}`)
      .send({ email, name: 'PW', password: 'first-password-1', roles: ['viewer'] })
      .expect(201);
    const other = await login(email, 'first-password-1');
    const mine = await login(email, 'first-password-1');

    const wrong = await request(app)
      .post('/api/auth/password')
      .set('authorization', `Bearer ${mine.accessToken}`)
      .send({ currentPassword: 'not-it', newPassword: 'second-password-2' });
    expect(wrong.status).toBe(400);

    const changed = await request(app)
      .post('/api/auth/password')
      .set('authorization', `Bearer ${mine.accessToken}`)
      .send({ currentPassword: 'first-password-1', newPassword: 'second-password-2' });
    expect(changed.status).toBe(200);
    expect(changed.body.tokens.accessToken).toBeTruthy();

    // The other device's refresh session is gone; the new one works.
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: other.refreshToken })).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: changed.body.tokens.refreshToken })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email, password: 'first-password-1' })).status).toBe(401);
  });
});

describe('user administration & RBAC', () => {
  let admin: { accessToken: string };
  let viewer: { accessToken: string; refreshToken: string };
  let viewerId: string;
  const viewerEmail = `viewer-${run}@cloudops.test`;

  beforeAll(async () => {
    admin = await login(ADMIN.email, ADMIN.password);
    const created = await request(app)
      .post('/api/users')
      .set('authorization', `Bearer ${admin.accessToken}`)
      .send({ email: viewerEmail, name: 'IT Viewer', password: 'viewer-password-1', roles: ['viewer'] });
    expect(created.status).toBe(201);
    viewerId = created.body.id;
    viewer = await login(viewerEmail, 'viewer-password-1');
  });

  it('enforces the password policy on new accounts', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('authorization', `Bearer ${admin.accessToken}`)
      .send({ email: `weak-${run}@cloudops.test`, name: 'Weak', password: 'short', roles: ['viewer'] });
    expect(res.status).toBe(400);
  });

  it('keeps viewers out of admin areas and write operations', async () => {
    const auth = { authorization: `Bearer ${viewer.accessToken}` };
    expect((await request(app).get('/api/users').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/audit').set(auth)).status).toBe(403);
    expect((await request(app).post('/api/sync/azure').set(auth).send({})).status).toBe(403);
    expect((await request(app).post('/api/standards/evaluate').set(auth)).status).toBe(403);
    expect((await request(app).post('/api/providers/azure/accounts').set(auth).send({})).status).toBe(403);
  });

  it('protects admins from locking themselves out', async () => {
    const me = (await request(app).get('/api/auth/me').set('authorization', `Bearer ${admin.accessToken}`)).body;
    const auth = { authorization: `Bearer ${admin.accessToken}` };
    expect((await request(app).patch(`/api/users/${me.id}`).set(auth).send({ isActive: false })).status).toBe(409);
    expect((await request(app).patch(`/api/users/${me.id}`).set(auth).send({ roles: ['viewer'] })).status).toBe(409);
  });

  it('only lets a saved view be deleted by its author or an operator/admin', async () => {
    const adminView = await request(app)
      .post('/api/views')
      .set('authorization', `Bearer ${admin.accessToken}`)
      .send({ name: `admin view ${run}`, scope: 'inventory', filters: {} });
    expect(adminView.status).toBe(201);
    const denied = await request(app).delete(`/api/views/${adminView.body.id}`).set('authorization', `Bearer ${viewer.accessToken}`);
    expect(denied.status).toBe(403);

    const own = await request(app)
      .post('/api/views')
      .set('authorization', `Bearer ${viewer.accessToken}`)
      .send({ name: `own view ${run}`, scope: 'inventory', filters: {} });
    expect((await request(app).delete(`/api/views/${own.body.id}`).set('authorization', `Bearer ${viewer.accessToken}`)).status).toBe(204);
    expect((await request(app).delete(`/api/views/${adminView.body.id}`).set('authorization', `Bearer ${admin.accessToken}`)).status).toBe(204);
  });

  it('deactivation cuts off access immediately (not at token expiry)', async () => {
    const res = await request(app)
      .patch(`/api/users/${viewerId}`)
      .set('authorization', `Bearer ${admin.accessToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('authorization', `Bearer ${viewer.accessToken}`)).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: viewer.refreshToken })).status).toBe(401);
  });

  it('records who did what in the audit log, without secrets', async () => {
    const res = await request(app).get('/api/audit?pageSize=200').set('authorization', `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
    const actions = new Set(res.body.items.map((i: { action: string }) => i.action));
    for (const a of ['auth.login', 'auth.login.failed', 'user.create', 'user.deactivate', 'view.delete', 'auth.password.change']) {
      expect(actions).toContain(a);
    }
    expect(JSON.stringify(res.body)).not.toContain('viewer-password-1');
    const entry = res.body.items.find((i: { action: string }) => i.action === 'user.create');
    expect(entry.requestId).toBeTruthy();
  });
});

describe('inventory export', () => {
  it('streams a CSV attachment with a header row', async () => {
    const t = await login(ADMIN.email, ADMIN.password);
    const res = await request(app).get('/api/inventory/resources/export.csv').set('authorization', `Bearer ${t.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text.replace(/^﻿/, '').split('\r\n')[0]).toMatch(/^name,type,location/);
  });
});

describe('abuse protection', () => {
  it('rate-limits repeated login attempts for an account', async () => {
    const email = `brute-${run}@cloudops.test`;
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await request(app).post('/api/auth/login').send({ email, password: 'guess-guess' })).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe('second-pass hardening', () => {
  let admin: { accessToken: string };
  beforeAll(async () => {
    admin = await login(ADMIN.email, ADMIN.password);
  });

  it('a refresh token is single-use even under concurrent requests', async () => {
    const email = `race-${run}@cloudops.test`;
    await request(app)
      .post('/api/users')
      .set('authorization', `Bearer ${admin.accessToken}`)
      .send({ email, name: 'Race', password: 'race-password-1', roles: ['viewer'] });
    const { refreshToken } = await login(email, 'race-password-1');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post('/api/auth/refresh').send({ refreshToken })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(4);
  });

  it('accounts created by an admin must choose their own password', async () => {
    const email = `fresh-${run}@cloudops.test`;
    const created = await request(app)
      .post('/api/users')
      .set('authorization', `Bearer ${admin.accessToken}`)
      .send({ email, name: 'Fresh', password: 'temporary-pass-1', roles: ['viewer'] });
    expect(created.body.mustChangePassword).toBe(true);
    const first = await request(app).post('/api/auth/login').send({ email, password: 'temporary-pass-1' });
    expect(first.body.user.mustChangePassword).toBe(true);
    const changed = await request(app)
      .post('/api/auth/password')
      .set('authorization', `Bearer ${first.body.tokens.accessToken}`)
      .send({ currentPassword: 'temporary-pass-1', newPassword: 'my-own-password-1' });
    expect(changed.status).toBe(200);
    expect(changed.body.user.mustChangePassword).toBe(false);
    const me = await request(app).get('/api/auth/me').set('authorization', `Bearer ${changed.body.tokens.accessToken}`);
    expect(me.body.mustChangePassword).toBe(false);
  });

  it('rejects tag names az would read as flags, and oversized tag sets', async () => {
    const put = (tags: Record<string, string>) =>
      request(app).put('/api/inventory/resources/nope/tags').set('authorization', `Bearer ${admin.accessToken}`).send({ tags });
    expect((await put({ '--operation': 'Replace' })).status).toBe(400);
    expect((await put({ 'a=b': 'c' })).status).toBe(400);
    expect((await put(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v'])))).status).toBe(400);
  });

  it('serves the on-call system status to admins only', async () => {
    const res = await request(app).get('/api/system/status').set('authorization', `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.checks.database.ok).toBe(true);
    expect(res.body.queues.map((q: { name: string }) => q.name).sort()).toEqual(['evaluation', 'finops', 'maintenance', 'remediation', 'sync', 'tags']);
    expect(res.body.migrations.pending).toEqual([]);
    expect((await request(app).get('/api/system/status')).status).toBe(401);
  });

  it('compresses JSON responses for clients that accept it', async () => {
    const res = await request(app).get('/api/openapi.json').set('accept-encoding', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.openapi).toBeDefined();
  });

  it('never reveals dependency internals on the public readiness probe', async () => {
    const res = await request(app).get('/health/ready');
    for (const check of Object.values(res.body.checks as Record<string, { error?: string }>)) {
      expect(check.error === undefined || ['timeout', 'unreachable'].includes(check.error)).toBe(true);
    }
  });
});
