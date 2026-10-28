import { describe, expect, it, vi } from 'vitest';
import type { AutomationMatchDto } from '@cloudops/core';
import { AutomationEngine, MAX_MATCHES_PER_RUN, parseRule } from './automation.engine.js';

const rule = {
  id: 'rule1',
  name: 'Findings to work',
  trigger: 'compliance.new-failures',
  conditions: {},
  actions: [],
};

const match = (i: number): AutomationMatchDto => ({
  key: `compliance:r${i}`,
  title: `Rule ${i}`,
  detail: 'failing',
  severity: 'high',
  link: `/standards?rule=r${i}`,
  resourceIds: [`res${i}`],
});

/** Just enough of Prisma / notifications / work for the engine's execute path. */
function harness(openSourceIds: string[] = []) {
  const runs: unknown[] = [];
  const prisma = {
    workItem: { findMany: vi.fn(async () => openSourceIds.map((sourceId) => ({ sourceId }))) },
    automationRun: { create: vi.fn((args: { data: unknown }) => ({ args })) },
    automationRule: { update: vi.fn((args: unknown) => args) },
    $transaction: vi.fn(async (ops: { args?: { data: unknown } }[]) => {
      runs.push(ops[0]!.args!.data);
      return [{ id: `run${runs.length}` }, {}];
    }),
  };
  const notifications = { publish: vi.fn(async () => undefined) };
  const work = { create: vi.fn(async () => ({})) };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  const engine = new AutomationEngine(
    prisma as never,
    notifications as never,
    work as never,
    {} as never,
    logger as never,
  );
  return { engine, prisma, notifications, work, runs };
}

describe('parseRule', () => {
  it('accepts valid stored settings', () => {
    const parsed = parseRule({
      ...rule,
      conditions: { minSeverity: 'high' },
      actions: [{ type: 'notify', audience: null, severity: 'high' }],
    });
    expect(parsed?.conditions.minSeverity).toBe('high');
    expect(parsed?.actions).toHaveLength(1);
  });

  it('rejects settings edited into an invalid shape instead of crashing', () => {
    expect(
      parseRule({ ...rule, conditions: { minSeverity: 'catastrophic' }, actions: [] }),
    ).toBeNull();
    expect(
      parseRule({ ...rule, conditions: {}, actions: [{ type: 'delete-everything' }] }),
    ).toBeNull();
    expect(parseRule({ ...rule, conditions: { unknownKey: 1 }, actions: [] })).toBeNull();
  });
});

describe('AutomationEngine.execute', () => {
  it('records a skipped run and does nothing when nothing matched', async () => {
    const h = harness();
    await h.engine.execute(
      rule,
      rule.trigger,
      [{ type: 'create-work-item', workType: 'task', priority: 3 }],
      [],
      'occ',
    );
    expect(h.work.create).not.toHaveBeenCalled();
    expect(h.runs[0]).toMatchObject({ status: 'skipped' });
  });

  it('raises one work item per match, never duplicating one that is still open', async () => {
    const h = harness(['rule1:compliance:r1']);
    await h.engine.execute(
      rule,
      rule.trigger,
      [{ type: 'create-work-item', workType: 'security', priority: 2, dueInDays: 7 }],
      [match(1), match(2)],
      'occ',
    );
    expect(h.work.create).toHaveBeenCalledTimes(1);
    const [input, actor] = h.work.create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { name: string },
    ];
    expect(input).toMatchObject({
      title: 'Rule 2',
      type: 'security',
      priority: 2,
      source: { type: 'automation', id: 'rule1:compliance:r2' },
    });
    expect(input.scopes).toEqual([{ scopeType: 'resource', scopeId: 'res2' }]);
    expect(actor.name).toBe('Automation: Findings to work');
    expect(h.runs[0]).toMatchObject({
      status: 'succeeded',
      detail: {
        matched: 2,
        actions: [
          { type: 'create-work-item', count: 1, message: '1 already had an open work item' },
        ],
      },
    });
  });

  it('caps a flood and says so', async () => {
    const h = harness();
    const many = Array.from({ length: MAX_MATCHES_PER_RUN + 10 }, (_, i) => match(i));
    await h.engine.execute(
      rule,
      rule.trigger,
      [{ type: 'notify', audience: 'remediation.request', severity: 'high' }],
      many,
      'occ',
    );
    // 10 individual notifications plus one "and N more" summary.
    expect(h.notifications.publish).toHaveBeenCalledTimes(11);
    expect(h.runs[0]).toMatchObject({ detail: { matched: MAX_MATCHES_PER_RUN, truncated: true } });
  });

  it('keeps going when one action fails, and reports a partial run', async () => {
    const h = harness();
    h.work.create.mockRejectedValueOnce(new Error('db down'));
    await h.engine.execute(
      rule,
      rule.trigger,
      [
        { type: 'create-work-item', workType: 'task', priority: 3 },
        { type: 'notify', audience: null, severity: 'medium' },
      ],
      [match(1)],
      'occ',
    );
    expect(h.notifications.publish).toHaveBeenCalledTimes(1);
    // Internal error text stays in the log; run history (readable by everyone) gets a summary.
    expect(h.runs[0]).toMatchObject({
      status: 'partial',
      detail: {
        actions: [
          { outcome: 'failed', message: 'Unexpected error — the details are in the API log.' },
          { outcome: 'done' },
        ],
      },
    });
  });
});
