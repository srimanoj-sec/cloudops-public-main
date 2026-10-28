import type { ZodTypeAny, z } from 'zod';

/** Parse+validate a request part, throwing ZodError (handled centrally). */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}
