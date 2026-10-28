/**
 * Integration suite for the operations platform: remediation (four-eyes,
 * RBAC, write guard), notifications, sessions, automation, audit export,
 * document history, job monitoring, sync center and search — the real app over
 * HTTP against a disposable DB. Azure is never reached (writes are off and no
 * organizations are configured). Fixtures are removed afterwards.
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

const run = `ops${Date.now().toString(36)}`;
const PASSWORD = `It-Ops-${run}-pass`;
const people = {
  admin: { email: `it-admin-${run}@cloudops.test`, role: 'admin' },
  operator: { email: `it-operator-${run}@cloudops.test`, role: 'operator' },
  viewer: { email: `it-viewer-${run}@cloudops.test`, role: 'viewer' },
} as const;
type Who = keyof typeof people;

let app: Express;
const tokens: Record<Who, string> = { admin: '', operator: '', viewer: '' };
const ids: Record<Who, string> = { admin: '', operator: '', viewer: '' };
const as = (who: Who) => ({ authorization: `Bearer ${tokens[who]}` });

const subExt = `it-${run}`;
const rgExt = `/subscriptions/${subExt}/resourcegroups/rg-${run}`;
let subId = '';
let siteId = '';
const ruleIds: string[] = [];
const remediationIds: string[] = [];

async function login(who: Who, userAgent = 'integration-test') {
  const res = await request(app).post('/api/auth/login').set('user-agent', userAgent).send({ email: people[who].email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.tokens as { accessToken: string; refreshToken: string };
}

beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const who of Object.keys(people) as Who[]) {
    const role = await prisma.role.upsert({ where: { key: people[who].role }, update: {}, create: { key: people[who].role } });
    const u = await prisma.user.create({ data: { email: people[who].email, name: `IT ${who} ${run}`, passwordHash: hash, roles: { create: [{ roleId: role.id }] } } });
    ids[who] = u.id;
  }
  app = createApp(await compose());
  for (const who of Object.keys(people) as Who[]) tokens[who] = (await login(who)).accessToken;

  const s = await prisma.subscription.create({ data: { externalId: subExt, name: `IT sub ${run}` } });
  subId = s.id;
  const rg = await prisma.resourceGroup.create({ data: { externalId: rgExt, name: `rg-${run}`, subscriptionId: s.id } });
  const site = await prisma.resource.create({
    data: {
      externalId: `${rgExt}/providers/microsoft.web/sites/app-${run}`,
      name: `app-${run}`,
      type: 'microsoft.web/sites',
      location: 'centralindia',
      properties: { httpsOnly: false },
      subscriptionId: s.id,
      resourceGroupId: rg.id,
    },
  });
  siteId = site.id;
  await request(app).post('/api/standards/evaluate').set(as('admin'));
});

afterAll(async () => {
  await prisma.workItem.deleteMany({ where: { OR: [{ sourceType: 'automation', sourceId: { startsWith: ruleIds[0] ?? '__none__' } }, { links: { some: { scopeId: siteId } } }] } });
  await prisma.automationRule.deleteMany({ where: { id: { in: ruleIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ entityId: { in: [...remediationIds, ...ruleIds] } }, { userId: { in: Object.values(ids) } }] } });
  await prisma.remediationRun.deleteMany({ where: { id: { in: remediationIds } } });
  await prisma.workspace.deleteMany({ where: { scopeType: 'subscription', scopeId: subId } });
  await prisma.resource.deleteMany({ where: { subscriptionId: subId } });
  await prisma.resourceGroup.deleteMany({ where: { subscriptionId: subId } });
  await prisma.subscription.deleteMany({ where: { id: subId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await Promise.allSettled(allQueues.map((q) => q.close()));
  fastRedis.disconnect();
  await prisma.$disconnect();
});

describe('remediation', () => {
  it('plans a change with the exact provider call, without changing anything', async () => {
    const res = await request(app).post('/api/remediation/plan').set(as('operator')).send({ actionKey: 'azure.webapp.https-only', resourceIds: [siteId] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ willChange: 1, requiresApproval: true });
    expect(res.body.targets[0].command).toContain('az resource update');
    expect(res.body.targets[0].command).toContain('httpsOnly=true');
  });

  it('keeps viewers out, needs a second person to approve, and refuses to run while writes are off', async () => {
    const body = { actionKey: 'azure.webapp.https-only', resourceIds: [siteId], note: 'IT' };
    expect((await request(app).post('/api/remediation/runs').set(as('viewer')).send(body)).status).toBe(403);

    const created = await request(app).post('/api/remediation/runs').set(as('operator')).send(body);
    expect(created.status).toBe(201);
    remediationIds.push(created.body.id);
    expect(created.body.status).toBe('pending_approval');

    // Four-eyes: the requester can't approve their own medium-risk change.
    const self = await request(app).post(`/api/remediation/runs/${created.body.id}/decision`).set(as('operator')).send({ approve: true });
    expect(self.status).toBe(403);

    // The approver is told; the requester isn't told about their own request.
    const adminInbox = await request(app).get('/api/notifications').set(as('admin'));
    expect((adminInbox.body.items as { entityId: string }[]).some((n) => n.entityId === created.body.id)).toBe(true);
    const operatorInbox = await request(app).get('/api/notifications').set(as('operator'));
    expect((operatorInbox.body.items as { entityId: string }[]).some((n) => n.entityId === created.body.id)).toBe(false);

    const approved = await request(app).post(`/api/remediation/runs/${created.body.id}/decision`).set(as('admin')).send({ approve: true });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const exec = await request(app).post(`/api/remediation/runs/${created.body.id}/execute`).set(as('admin'));
    expect(exec.status).toBe(403);
    expect(exec.body.error.message).toMatch(/write/i);

    const cancelled = await request(app).post(`/api/remediation/runs/${created.body.id}/cancel`).set(as('operator'));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
  });
});

describe('sessions', () => {
  it('lists signed-in devices and signs the others out immediately', async () => {
    const other = await login('operator', 'curl/8.4.0');
    const me = await login('operator', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36');
    const list = await request(app).get('/api/auth/sessions').set({ authorization: `Bearer ${me.accessToken}` });
    expect(list.status).toBe(200);
    expect(list.body.find((s: { current: boolean }) => s.current)).toMatchObject({ device: 'Chrome on Windows' });

    const out = await request(app).post('/api/auth/sessions/revoke-others').set({ authorization: `Bearer ${me.accessToken}` });
    expect(out.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set({ authorization: `Bearer ${other.accessToken}` })).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: other.refreshToken })).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set({ authorization: `Bearer ${out.body.tokens.accessToken}` })).status).toBe(200);
    tokens.operator = out.body.tokens.accessToken;
  });

  it('lets an admin see a user’s devices; others cannot', async () => {
    expect((await request(app).get(`/api/users/${ids.operator}/sessions`).set(as('admin'))).status).toBe(200);
    expect((await request(app).get(`/api/users/${ids.operator}/sessions`).set(as('operator'))).status).toBe(403);
  });
});

describe('automation', () => {
  const rule = {
    name: `IT rule ${run}`,
    trigger: 'compliance.new-failures',
    conditions: { ruleIds: [] as string[] },
    actions: [{ type: 'create-work-item', workType: 'security', priority: 2 }],
  };

  it('only lets automation managers create rules, and validates them', async () => {
    expect((await request(app).post('/api/automation/rules').set(as('viewer')).send(rule)).status).toBe(403);
    const bad = await request(app).post('/api/automation/rules').set(as('admin')).send({ ...rule, actions: [{ type: 'delete-resources' }] });
    expect(bad.status).toBe(400);
  });

  it('previews against today’s data, runs, and never raises the same work twice', async () => {
    const summary = (await request(app).get('/api/standards').set(as('admin'))).body as { standards: { rules: { id: string; key: string }[] }[] };
    const https = summary.standards.flatMap((s) => s.rules).find((r) => r.key === 'https-only')!;
    const scoped = { ...rule, conditions: { ruleIds: [https.id] } };

    const preview = await request(app).post('/api/automation/preview').set(as('operator')).send(scoped);
    expect(preview.status).toBe(200);
    expect(preview.body.total).toBe(1);
    expect(preview.body.wouldDo[0]).toMatch(/Create 1 security work item/);

    const created = await request(app).post('/api/automation/rules').set(as('operator')).send(scoped);
    expect(created.status).toBe(201);
    ruleIds.push(created.body.id);

    const first = await request(app).post(`/api/automation/rules/${created.body.id}/run`).set(as('operator'));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'succeeded', matched: 1, actions: [{ type: 'create-work-item', count: 1 }] });
    const second = await request(app).post(`/api/automation/rules/${created.body.id}/run`).set(as('operator'));
    expect(second.body.actions[0]).toMatchObject({ outcome: 'skipped', count: 0 });

    const runs = await request(app).get(`/api/automation/runs?ruleId=${created.body.id}`).set(as('viewer'));
    expect(runs.body).toHaveLength(2);
  });
});

describe('audit export', () => {
  it('exports the filtered log as CSV for auditors only, and records the export', async () => {
    expect((await request(app).get('/api/audit/export').set(as('viewer'))).status).toBe(403);
    const res = await request(app).get(`/api/audit/export?actorId=${ids.operator}`).set(as('admin'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('time,actor,actor_id,action');
    expect(res.text).toContain('automation.rule.create');
    const log = await request(app).get(`/api/audit?action=audit.export&actorId=${ids.admin}`).set(as('admin'));
    expect(log.body.total).toBeGreaterThanOrEqual(1);
  });
});

describe('document history', () => {
  it('keeps every earlier version with its author and can restore one', async () => {
    const doc = await request(app).post(`/api/workspaces/scope/subscription/${subId}/documents`).set(as('operator')).send({ title: 'Runbook', kind: 'runbook', body: 'v1' });
    expect(doc.status).toBe(201);
    expect(doc.body.createdBy).toBe(`IT operator ${run}`);
    await request(app).patch(`/api/workspaces/documents/${doc.body.id}`).set(as('admin')).send({ body: 'v2' });
    await request(app).patch(`/api/workspaces/documents/${doc.body.id}`).set(as('admin')).send({ body: 'v2' }); // no change → no revision
    const revs = await request(app).get(`/api/workspaces/documents/${doc.body.id}/revisions`).set(as('viewer'));
    expect(revs.body).toHaveLength(1);
    expect(revs.body[0]).toMatchObject({ author: `IT operator ${run}` });

    expect((await request(app).post(`/api/workspaces/documents/${doc.body.id}/revisions/${revs.body[0].id}/restore`).set(as('viewer'))).status).toBe(403);
    const restored = await request(app).post(`/api/workspaces/documents/${doc.body.id}/revisions/${revs.body[0].id}/restore`).set(as('admin'));
    expect(restored.body.body).toBe('v1');
  });
});

describe('operations console', () => {
  it('lists jobs for admins only, and never retries a remediation from there', async () => {
    expect((await request(app).get('/api/system/queues/sync/jobs?state=failed').set(as('admin'))).status).toBe(200);
    expect((await request(app).get('/api/system/queues/sync/jobs').set(as('operator'))).status).toBe(403);
    expect((await request(app).get('/api/system/queues/nope/jobs').set(as('admin'))).status).toBe(404);
    expect((await request(app).post('/api/system/queues/remediation/jobs/x/retry').set(as('admin'))).status).toBe(400);
  });

  it('serves sync history and drift with filters', async () => {
    const runs = await request(app).get('/api/sync/runs?limit=5').set(as('viewer'));
    expect(runs.status).toBe(200);
    expect(Array.isArray(runs.body)).toBe(true);
    const drift = await request(app).get('/api/drift?syncRunId=none&pageSize=5').set(as('viewer'));
    expect(drift.status).toBe(200);
    expect(drift.body).toMatchObject({ total: 0, items: [] });
    expect((await request(app).get('/api/sync/runs/does-not-exist').set(as('viewer'))).status).toBe(404);
  });

  it('finds resources by name from global search', async () => {
    const res = await request(app).get(`/api/search?q=app-${run}`).set(as('viewer'));
    expect(res.status).toBe(200);
    const hits = (res.body.groups as { items: { id: string }[] }[]).flatMap((g) => g.items);
    expect(hits.map((h) => h.id)).toContain(siteId);
  });
});
