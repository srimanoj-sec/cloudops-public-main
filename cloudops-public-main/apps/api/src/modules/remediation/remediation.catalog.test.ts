import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_INDEX,
  actionsForTemplate,
  isTagsJson,
  missingActionParams,
  parseTagsParam,
  type PlanResource,
} from './remediation.catalog.js';

const resource = (type: string, properties: Record<string, unknown> = {}): PlanResource => ({
  id: 'r1',
  externalId: `/subscriptions/s/resourceGroups/rg/providers/${type}/thing`,
  name: 'thing',
  type: type.toLowerCase(),
  state: 'active',
  owner: null,
  tags: { env: 'prod' },
  properties,
});

describe('remediation catalog', () => {
  it('explains every action: risk and why, rollback, disruption, what it applies to', () => {
    for (const a of ACTIONS) {
      expect(a.riskReason.length, a.key).toBeGreaterThan(5);
      expect(a.rollback.length, a.key).toBeGreaterThan(3);
      expect(a.disruption.length, a.key).toBeGreaterThan(3);
      expect(a.appliesTo.length, a.key).toBeGreaterThan(3);
    }
    expect(ACTION_INDEX.size).toBe(ACTIONS.length);
  });

  it('never deletes data stores, and every delete is irreversible and at least medium risk (so it needs a second approver)', () => {
    for (const a of ACTIONS.filter((x) => x.mode === 'provider')) {
      const build = a.build(resource(a.types?.[0] ?? 'Microsoft.Web/sites'), {});
      if (build.kind !== 'delete') continue;
      expect(a.reversible, a.key).toBe(false);
      expect(a.risk, a.key).not.toBe('low');
      for (const t of a.types ?? [])
        expect(t, a.key).not.toMatch(/disks|databases|sql|storageaccounts|vaults|cosmos/i);
    }
  });

  it('only sets plain property paths and simple values (the executor refuses anything else)', () => {
    for (const a of ACTIONS.filter((x) => x.mode === 'provider')) {
      const built = a.build(resource(a.types?.[0] ?? 'Microsoft.Web/sites'), {});
      if (built.kind !== 'set-property') continue;
      expect(built.path, a.key).toMatch(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){0,4}$/);
      expect(String(built.value), a.key).not.toMatch(/[\s"'`]/);
    }
  });

  it('finds the actions that fix a rule template', () => {
    expect(actionsForTemplate('https-only').map((a) => a.key)).toContain('azure.webapp.https-only');
    expect(actionsForTemplate('no-such-template')).toEqual([]);
    expect(actionsForTemplate(null)).toEqual([]);
  });

  it('requires parameters and rejects a malformed tag set instead of wiping tags', () => {
    const owner = ACTION_INDEX.get('tags.assign-owner')!;
    expect(missingActionParams(owner, {})).toEqual(['Owner']);
    expect(missingActionParams(owner, { owner: 'team-a' })).toEqual([]);

    const restore = ACTION_INDEX.get('tags.restore')!;
    expect(restore.validate?.({ tags: 'not json' })).toMatch(/JSON object/);
    expect(restore.validate?.({ tags: '["a"]' })).toMatch(/JSON object/);
    expect(restore.validate?.({ tags: '{"env":"prod"}' })).toBeNull();
    expect(isTagsJson('{}')).toBe(true);
    expect(parseTagsParam('{"env":"prod","n":1}')).toEqual({ env: 'prod', n: '1' });
  });
});
