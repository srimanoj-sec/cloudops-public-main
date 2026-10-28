import { describe, expect, it, vi } from 'vitest';
import { describeUserAgent } from './auth/auth.service.js';
import { AuditService } from './audit/audit.service.js';
import { scorePriority } from './dashboard/priority.js';
import { resolveOwner } from './sync/sync.engine.js';
import { describeActivity } from './work/work.service.js';

describe('describeUserAgent', () => {
  it('names common browsers and systems', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15')).toBe('Safari on macOS');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('Edge on Windows');
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe('Firefox on Linux');
  });

  it('recognises API clients and unknowns', () => {
    expect(describeUserAgent('curl/8.4.0')).toBe('API client');
    expect(describeUserAgent('node')).toBe('API client');
    expect(describeUserAgent(null)).toBe('Unknown device');
    expect(describeUserAgent('SomethingElse/1.0')).toBe('Unknown device');
  });
});

describe('AuditService.exportCsv', () => {
  const row = (over: Record<string, unknown>) => ({
    createdAt: new Date('2026-09-28T10:00:00Z'),
    actor: 'Ana',
    actorId: 'u1',
    action: 'user.update',
    entity: 'user',
    entityId: 'u2',
    ip: '10.0.0.1',
    requestId: 'req-1',
    metadata: null,
    ...over,
  });

  function service(rows: unknown[]) {
    const prisma = { auditLog: { findMany: vi.fn(async () => rows) } };
      return new AuditService(prisma as never, { warn: vi.fn() } as never);
  }

  it('neutralises cells a spreadsheet would run as a formula', async () => {
    const { csv } = await service([row({ actor: '=HYPERLINK("http://evil")' }), row({ actor: '+1', entityId: '-2', ip: '@x' })]).exportCsv({});
    const [, first, second] = csv.split('\r\n');
    expect(first).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(second).toContain("'+1");
    expect(second).toContain("'-2");
    expect(second).toContain("'@x");
  });

  it('quotes commas and newlines, and serialises details as JSON', async () => {
    const { csv } = await service([row({ actor: 'Doe, Jane', metadata: { note: 'a\nb' } })]).exportCsv({});
    const line = csv.split('\r\n')[1]!;
    expect(line).toContain('"Doe, Jane"');
    expect(line).toContain('"{""note"":""a\\nb""}"');
  });

  it('says when the export was truncated', async () => {
    const rows = Array.from({ length: 10_001 }, () => row({}));
    const out = await service(rows).exportCsv({});
    expect(out.truncated).toBe(true);
    expect(out.rows).toBe(10_000);
  });
});

describe('scorePriority (transparent factors)', () => {
  const money = (n: number) => `₹${n}`;

  it('is the severity base alone for a single low-impact item', () => {
    expect(scorePriority({ severity: 'high', affected: 1 }, money)).toEqual({ score: 40, factors: [{ label: 'high severity', points: 40 }] });
  });

  it('adds named, capped factors', () => {
    const s = scorePriority({ severity: 'medium', affected: 8, production: 2, costImpact: 5000, estateMonthly: 100_000, overdueDays: 30 }, money);
    expect(s.factors.map((f) => f.points)).toEqual([25, 15, 15, 10, 10]);
    expect(s.score).toBe(75);
  });

  it('never exceeds 100', () => {
    expect(scorePriority({ severity: 'critical', affected: 1000, production: 5, costImpact: 1e6, estateMonthly: 1e6, overdueDays: 99 }, money).score).toBe(100);
  });
});

describe('resolveOwner', () => {
  it('prefers the provider’s owner tag', () => {
    expect(resolveOwner('alice', { Owner: 'bob' })).toBe('alice');
  });

  it('falls back to a CloudOps-only owner tag, case-insensitively', () => {
    expect(resolveOwner(undefined, { owner: 'bob' })).toBe('bob');
    expect(resolveOwner(undefined, { TeamOwner: 'x', CostCentre: 'y' }, 'teamowner')).toBe('x');
    expect(resolveOwner(undefined, null)).toBeNull();
    expect(resolveOwner(undefined, { Owner: '' })).toBeNull();
  });
});

describe('describeActivity', () => {
  it('summarises a work item update in words', () => {
    expect(
      describeActivity('work.item.update', {
        changes: { state: { from: 'todo', to: 'in_progress' }, assignee: { from: null, to: 'Ana' }, priority: { from: 3, to: 1 } },
      }),
    ).toBe('moved from To do to In progress, assigned to Ana, changed priority P3 → P1');
  });

  it('names where an item came from', () => {
    expect(describeActivity('work.item.create', { source: { type: 'automation', label: 'Findings to work' } })).toBe('created from Findings to work');
    expect(describeActivity('work.item.create', {})).toBe('created this item');
  });
});
