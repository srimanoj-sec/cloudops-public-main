/**
 * Integration suite for Standards v2, Inventory v2, FinOps v2 and the
 * duplicate-resource merge — the real app over HTTP against a disposable DB.
 * Fixtures are created under a unique subscription and removed afterwards.
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

const run = `v2${Date.now().toString(36)}`;
const ADMIN = { email: `it-admin-${run}@cloudops.test`, password: `It-Admin-${run}-pass` };
let app: Express;
let token = '';
const auth = () => ({ authorization: `Bearer ${token}` });

const subExt = `it-${run}`;
const rgExt = `/subscriptions/${subExt}/resourcegroups/rg-it-${run}`;
let subId = '';
let siteId = '';

type Rule = { id: string; key: string; template: string | null };
type Std = { id: string; name: string; rules: Rule[] };

beforeAll(async () => {
  for (const key of ['admin', 'operator', 'viewer']) {
    await prisma.role.upsert({ where: { key }, update: {}, create: { key } });
  }
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'admin' } });
  await prisma.user.create({
    data: { email: ADMIN.email, name: 'IT Admin', passwordHash: await bcrypt.hash(ADMIN.password, 4), roles: { create: [{ roleId: adminRole.id }] } },
  });
  app = createApp(await compose());
  const res = await request(app).post('/api/auth/login').send(ADMIN);
  token = res.body.tokens.accessToken;

  const s = await prisma.subscription.create({ data: { externalId: subExt, name: `IT sub ${run}` } });
  subId = s.id;
  const rg = await prisma.resourceGroup.create({ data: { externalId: rgExt, name: `rg-it-${run}`, subscriptionId: s.id } });
  const site = await prisma.resource.create({
    data: {
      externalId: `${rgExt}/providers/Microsoft.Web/sites/app-it-${run}`,
      name: `app-it-${run}`,
      type: 'Microsoft.Web/sites',
      location: 'centralindia',
      properties: { httpsOnly: false },
      subscriptionId: s.id,
      resourceGroupId: rg.id,
    },
  });
  siteId = site.id;
});

afterAll(async () => {
  await prisma.costRecord.deleteMany({ where: { subscriptionExternalId: subExt } });
  await prisma.resource.deleteMany({ where: { subscriptionId: subId } });
  await prisma.resourceGroup.deleteMany({ where: { subscriptionId: subId } });
  await prisma.subscription.deleteMany({ where: { id: subId } });
  await prisma.standard.deleteMany({ where: { source: 'custom', name: { endsWith: run } } });
  await prisma.budget.deleteMany({ where: { name: { endsWith: run } } });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await Promise.allSettled(allQueues.map((q) => q.close()));
  fastRedis.disconnect();
  await prisma.$disconnect();
});

describe('standards v2', () => {
  it('serves a rule library where every rule explains itself and its fix', async () => {
    const res = await request(app).get('/api/standards/library').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(40);
    for (const r of res.body) expect(r.remediation.length).toBeGreaterThan(10);
  });

  it('fails a web app with HTTPS off, and an exemption takes it out of the score', async () => {
    const summary = (await request(app).post('/api/standards/evaluate').set(auth())).body as { standards: Std[] };
    const https = summary.standards.flatMap((s) => s.rules).find((r) => r.key === 'https-only')!;
    const failing = (await request(app).get(`/api/standards/results?ruleId=${https.id}&passed=false`).set(auth())).body as { scopeId: string }[];
    expect(failing.map((f) => f.scopeId)).toContain(siteId);

    const ex = await request(app).post('/api/standards/exemptions').set(auth()).send({ ruleId: https.id, resourceId: siteId, reason: 'IT exemption' });
    expect(ex.status).toBe(201);
    const compliance = (await request(app).get(`/api/standards/resources/${siteId}`).set(auth())).body as { results: { ruleKey: string }[] };
    expect(compliance.results.find((r) => r.ruleKey === 'https-only')).toMatchObject({ passed: false, exempt: true });
    expect((await request(app).delete(`/api/standards/exemptions/${ex.body.id}`).set(auth())).status).toBe(200);

    const unknown = await request(app).post('/api/standards/exemptions').set(auth()).send({ ruleId: https.id, resourceId: 'nope', reason: 'x y z' });
    expect(unknown.status).toBe(404);
  });

  it('builds custom rules from templates or conditions — validated — with a live preview', async () => {
    const created = await request(app).post('/api/standards/custom').set(auth()).send({ name: `IT std ${run}`, templates: ['https-only'] });
    expect(created.status).toBe(201);
    const custom = (created.body.standards as Std[]).find((s) => s.name === `IT std ${run}`)!;
    expect(custom.rules.map((r) => r.template)).toEqual(['https-only']);

    const badRegex = await request(app)
      .post(`/api/standards/${custom.id}/rules`)
      .set(auth())
      .send({ name: 'bad', definition: { match: 'all', conditions: [{ field: 'name', operator: 'matches', value: '([' }] } });
    expect(badRegex.status).toBe(400);
    const needsParams = await request(app).post(`/api/standards/${custom.id}/rules`).set(auth()).send({ name: 'regions', template: 'allowed-locations' });
    expect(needsParams.status).toBe(400);

    const preview = await request(app)
      .post('/api/standards/rules/preview')
      .set(auth())
      .send({ definition: { match: 'all', conditions: [{ field: 'property', key: 'httpsOnly', operator: 'is_true' }] }, scope: { types: ['microsoft.web/sites'] } });
    expect(preview.status).toBe(200);
    expect((preview.body.samples as { id: string }[]).find((x) => x.id === siteId)).toMatchObject({ passed: false });
  });
});

describe('inventory v2', () => {
  it('shows where every resource lives, groups the inventory and builds the scope tree', async () => {
    const list = await request(app).get(`/api/inventory/resources?subscriptionIds=${subId}`).set(auth());
    expect(list.body.items[0]).toMatchObject({ subscriptionName: `IT sub ${run}`, resourceGroupName: `rg-it-${run}`, category: 'Web/App' });
    const groups = await request(app).get('/api/inventory/resources/groups?groupBy=category').set(auth());
    expect((groups.body.groups as { key: string }[]).some((g) => g.key === 'Web/App')).toBe(true);
    expect((await request(app).get('/api/inventory/resources/groups?groupBy=nonsense').set(auth())).status).toBe(400);
    const tree = await request(app).get('/api/inventory/tree').set(auth());
    const node = (tree.body.organizations as { subscriptions: { id: string; count: number }[] }[])
      .flatMap((o) => o.subscriptions)
      .find((s) => s.id === subId);
    expect(node?.count).toBe(1);
  });
});

describe('data integrity', () => {
  it('merges duplicate resource rows (same Azure id, different case) and keeps their cost', async () => {
    const lower = `${rgExt}/providers/microsoft.compute/disks/disk-it-${run}`;
    const active = await prisma.resource.create({
      data: {
        externalId: lower.replace('microsoft.compute/disks', 'Microsoft.Compute/disks'),
        name: 'disk',
        type: 'Microsoft.Compute/disks',
        subscriptionId: subId,
        lastSyncedAt: new Date(),
      },
    });
    const stale = await prisma.resource.create({
      data: {
        externalId: lower.toUpperCase(),
        name: 'DISK',
        type: 'Microsoft.Compute/disks',
        state: 'deleted',
        subscriptionId: subId,
        lastSyncedAt: new Date(Date.now() - 86_400_000),
      },
    });
    await prisma.costRecord.create({
      data: { resourceExternalId: lower, subscriptionExternalId: subExt, resourceId: stale.id, date: new Date(), cost: 42, currency: 'INR' },
    });

    const preview = await request(app).get('/api/system/duplicates').set(auth());
    const group = (preview.body.groups as { keep: { id: string }; remove: { id: string }[] }[]).find((g) => g.keep.id === active.id)!;
    expect(group.remove.map((r) => r.id)).toEqual([stale.id]);

    expect((await request(app).post('/api/system/duplicates/merge').set(auth())).status).toBe(200);
    expect(await prisma.resource.findUnique({ where: { id: stale.id } })).toBeNull();
    expect((await prisma.costRecord.findFirst({ where: { resourceExternalId: lower } }))?.resourceId).toBe(active.id);
  });
});

describe('finops v2', () => {
  it('reports the month in the reporting currency and manages budgets', async () => {
    const overview = await request(app).get('/api/finops/overview').set(auth());
    expect(overview.status).toBe(200);
    expect(overview.body.currency).toBe('INR');
    const noScope = await request(app).post('/api/finops/budgets').set(auth()).send({ name: `x ${run}`, scopeType: 'subscription', amount: 100 });
    expect(noScope.status).toBe(400);
    const b = await request(app).post('/api/finops/budgets').set(auth()).send({ name: `All ${run}`, scopeType: 'all', amount: 1000 });
    expect(b.status).toBe(201);
    const after = await request(app).get('/api/finops/overview').set(auth());
    expect((after.body.budgets as { id: string }[]).some((x) => x.id === b.body.id)).toBe(true);
    expect((await request(app).delete(`/api/finops/budgets/${b.body.id}`).set(auth())).status).toBe(204);
  });

  it('reports cost data coverage per subscription', async () => {
    const res = await request(app).get('/api/finops/coverage').set(auth());
    expect(res.status).toBe(200);
    const mine = (res.body as { id: string; lastCostDate: string | null; organization: string | null }[]).find((c) => c.id === subId);
    // The data-integrity test above stored cost for this subscription today.
    expect(mine?.lastCostDate).toBe(new Date().toISOString().slice(0, 10));
  });

  it('breaks cost down by service, category, owner and tag', async () => {
    for (const groupBy of ['service', 'category', 'owner']) {
      expect((await request(app).get(`/api/finops/query?preset=30d&groupBy=${groupBy}`).set(auth())).status).toBe(200);
    }
    expect((await request(app).get('/api/finops/query?preset=30d&groupBy=tag&tagKey=environment').set(auth())).status).toBe(200);
  });
});
