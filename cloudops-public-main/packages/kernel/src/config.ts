/**
 * Typed configuration loader.
 *
 * Validates process environment against a schema-like validator at boot, failing
 * fast with a readable error. Kept dependency-free: the api passes a Zod-backed
 * validator, but any `(env) => T` works.
 */

export type ConfigValidator<T> = (env: NodeJS.ProcessEnv) => T;

export function loadConfig<T>(validate: ConfigValidator<T>, env: NodeJS.ProcessEnv = process.env): T {
  try {
    return validate(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid configuration:\n${message}`);
  }
}
