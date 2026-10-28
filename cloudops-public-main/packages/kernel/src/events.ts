/**
 * In-process, typed pub/sub event bus.
 *
 * Modules react to domain events (`resource.discovered`, `sync.completed`,
 * `recommendation.created`, ...) without importing each other. The event map is
 * open for extension: declare additional events by augmenting `KernelEventMap`
 * from a consuming package.
 */

export interface KernelEventMap {
  'sync.started': { runId: string; providerKey: string; scope?: string };
  'sync.completed': {
    runId: string;
    providerKey: string;
    created: number;
    updated: number;
    changes: number;
    deleted?: number;
  };
  'sync.failed': { runId: string; providerKey: string; error: string };
  'resource.discovered': { resourceId: string; providerKey: string; type: string };
  'resource.changed': { resourceId: string; field: string };
  'resource.deleted': { resourceId: string };
  // Extended by later phases (recommendation.created, execution.finished, ...)
  [key: string]: unknown;
}

export type EventHandler<T> = (payload: T) => void | Promise<void>;

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler<unknown>>>();
  private readonly onError: (event: string, err: unknown) => void;

  constructor(onError?: (event: string, err: unknown) => void) {
    this.onError = onError ?? ((event, err) => console.error(`[eventbus] handler for "${event}" failed`, err));
  }

  on<K extends keyof KernelEventMap>(event: K, handler: EventHandler<KernelEventMap[K]>): () => void {
    const set = this.handlers.get(event as string) ?? new Set();
    set.add(handler as EventHandler<unknown>);
    this.handlers.set(event as string, set);
    return () => set.delete(handler as EventHandler<unknown>);
  }

  /** Emit an event; handlers run concurrently, failures are isolated. */
  async emit<K extends keyof KernelEventMap>(event: K, payload: KernelEventMap[K]): Promise<void> {
    const set = this.handlers.get(event as string);
    if (!set || set.size === 0) return;
    await Promise.all(
      [...set].map(async (handler) => {
        try {
          await handler(payload);
        } catch (err) {
          this.onError(event as string, err);
        }
      }),
    );
  }
}
