import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context, propagated through async calls without threading it
 * through every function. The logger reads it so every line emitted while
 * handling a request carries its correlation id and user.
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  ip?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}
