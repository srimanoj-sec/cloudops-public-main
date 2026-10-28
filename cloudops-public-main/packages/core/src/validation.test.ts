import { describe, expect, it } from 'vitest';
import { applyResourceGroupTagsSchema, MAX_TAGS, setResourceTagsSchema } from './inventory.js';
import { passwordSchema, utf8Length } from './auth.js';

describe('tag schemas — values reach `az` as argv', () => {
  const ok = (tags: Record<string, string>) => setResourceTagsSchema.safeParse({ tags }).success;

  it('accepts ordinary tags', () => {
    expect(ok({ Owner: 'platform-team', 'cost-center': '42', env: '' })).toBe(true);
  });

  it('rejects names az would parse as a flag or cannot express', () => {
    expect(ok({ '--operation': 'Replace' })).toBe(false);
    expect(ok({ '-x': '1' })).toBe(false);
    expect(ok({ 'a=b': 'c' })).toBe(false);
  });

  it('keeps Azure’s own restricted characters out', () => {
    for (const name of ['a<b', 'a>b', 'a%b', 'a&b', 'a\\b', 'a?b', 'a/b']) expect(ok({ [name]: 'v' })).toBe(false);
  });

  it(`caps a request at ${MAX_TAGS} tags`, () => {
    const make = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
    expect(ok(make(MAX_TAGS))).toBe(true);
    expect(ok(make(MAX_TAGS + 1))).toBe(false);
    expect(applyResourceGroupTagsSchema.safeParse({ tags: make(MAX_TAGS + 1) }).success).toBe(false);
  });
});

describe('passwordSchema — bcrypt reads only 72 bytes', () => {
  it('counts UTF-8 bytes like bcrypt sees them', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
  });

  it('accepts 10–72 byte passwords and rejects the rest', () => {
    expect(passwordSchema.safeParse('a'.repeat(10)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(72)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(9)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(73)).success).toBe(false);
    // 18 emoji = 18 characters but 72 bytes (ok); 19 = 76 bytes (silently truncated by bcrypt → rejected).
    expect(passwordSchema.safeParse('😀'.repeat(18)).success).toBe(true);
    expect(passwordSchema.safeParse('😀'.repeat(19)).success).toBe(false);
  });
});
