import { describe, expect, it } from 'vitest';
import { diffTags, isUntaggable } from './tags.util.js';

describe('diffTags', () => {
  it('detects additions, changes, and removals', () => {
    const current = { env: 'prod', owner: 'a', keep: 'x' };
    const desired = { env: 'staging', keep: 'x', team: 'core' };
    const { upserts, removes } = diffTags(current, desired);
    expect(upserts).toEqual({ env: 'staging', team: 'core' }); // changed + new (keep unchanged omitted)
    expect(removes).toEqual(['owner']);
  });

  it('is a no-op when nothing changes', () => {
    const tags = { a: '1', b: '2' };
    const { upserts, removes } = diffTags(tags, { ...tags });
    expect(Object.keys(upserts)).toHaveLength(0);
    expect(removes).toHaveLength(0);
  });

  it('treats an empty desired set as removing everything', () => {
    const { upserts, removes } = diffTags({ a: '1', b: '2' }, {});
    expect(Object.keys(upserts)).toHaveLength(0);
    expect(removes.sort()).toEqual(['a', 'b']);
  });
});

describe('isUntaggable', () => {
  it('classifies "does not support tags" errors as untaggable', () => {
    expect(isUntaggable(new Error("Resource type 'x' does not support tags"))).toBe(true);
    expect(isUntaggable(new Error('TagsOperationNotSupported'))).toBe(true);
    expect(isUntaggable({ stderr: 'The resource cannot be tagged' })).toBe(true);
  });

  it('does not misclassify permission / transient errors', () => {
    expect(isUntaggable(new Error('AuthorizationFailed: does not have permission'))).toBe(false);
    expect(isUntaggable(new Error('Request timed out'))).toBe(false);
  });
});
