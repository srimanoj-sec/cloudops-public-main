import { describe, expect, it } from 'vitest';
import { planDeletions } from './sync.engine.js';

const ids = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('planDeletions (flagging resources that vanished from the provider)', () => {
  it('flags only the expected resources that were not seen', () => {
    const plan = planDeletions(['a', 'b', 'c'], new Set(['a', 'c']), 2);
    expect(plan).toEqual({ ids: ['b'] });
  });

  it('flags nothing when everything was seen', () => {
    expect(planDeletions(['a', 'b'], new Set(['a', 'b']), 2)).toEqual({ ids: [] });
  });

  it('never flags anything when the subscription returned zero resources (likely an access problem)', () => {
    const plan = planDeletions(['a', 'b'], new Set(), 0);
    expect(plan.ids).toEqual([]);
    expect(plan.skippedReason).toMatch(/no resources/);
  });

  it('refuses a mass deletion (over half of 20+ resources vanishing at once)', () => {
    const expected = ids(40);
    const seen = new Set(expected.slice(0, 10)); // 30 of 40 missing
    const plan = planDeletions(expected, seen, 10);
    expect(plan.ids).toEqual([]);
    expect(plan.skippedReason).toMatch(/30 of 40/);
  });

  it('allows a large but plausible cleanup below the ratio', () => {
    const expected = ids(100);
    const seen = new Set(expected.slice(0, 60)); // 40% gone
    expect(planDeletions(expected, seen, 60).ids).toHaveLength(40);
  });

  it('allows small subscriptions to lose most resources (below the minimum count)', () => {
    const plan = planDeletions(['a', 'b', 'c', 'd'], new Set(['a']), 1);
    expect(plan.ids).toEqual(['b', 'c', 'd']);
  });

  it('treats a resource seen in ANOTHER subscription as alive (it moved, not deleted)', () => {
    // Global seen-set contains 'moved' even though this subscription didn't report it.
    const plan = planDeletions(['stays', 'moved'], new Set(['stays', 'moved']), 1);
    expect(plan.ids).toEqual([]);
  });
});
