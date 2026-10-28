/** Pure tag helpers — no infra imports, so they're unit-testable in isolation. */

export type TagMap = Record<string, string>;

/** Heuristic: does this Azure error mean the resource type simply can't be tagged? */
export function isUntaggable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const stderr = (err as { stderr?: string }).stderr ?? '';
  return /not support.*tag|tag.*not.*support|cannot be tagged|does not support tags|TagsNotSupported|TagsOperationNotSupported|InvalidResourceType/i.test(
    `${msg} ${stderr}`,
  );
}

export function asMap(v: unknown): TagMap {
  return (v as TagMap) ?? {};
}

/** Diff current → desired into upserts (add/changed) and removed keys. */
export function diffTags(current: TagMap, desired: TagMap): { upserts: TagMap; removes: string[] } {
  const upserts: TagMap = {};
  for (const [k, v] of Object.entries(desired)) if (current[k] !== v) upserts[k] = v;
  const removes = Object.keys(current).filter((k) => !(k in desired));
  return { upserts, removes };
}
