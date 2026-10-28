/**
 * Ordered lifecycle manager.
 *
 * Modules and plugins register lifecycle hooks; the manager drives them through
 * `init -> start -> stop` so boot and graceful shutdown are deterministic.
 */

export interface LifecycleHooks {
  name: string;
  /** Wire dependencies, register routes/handlers. Runs before start. */
  init?: () => void | Promise<void>;
  /** Begin doing work (open connections, start workers). */
  start?: () => void | Promise<void>;
  /** Release resources. Called in reverse registration order. */
  stop?: () => void | Promise<void>;
}

export class LifecycleManager {
  private readonly hooks: LifecycleHooks[] = [];
  private started = false;

  register(hooks: LifecycleHooks): void {
    this.hooks.push(hooks);
  }

  async init(): Promise<void> {
    for (const h of this.hooks) {
      await h.init?.();
    }
  }

  async start(): Promise<void> {
    for (const h of this.hooks) {
      await h.start?.();
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started && this.hooks.length === 0) return;
    // Stop in reverse order so dependents shut down before their dependencies.
    for (const h of [...this.hooks].reverse()) {
      try {
        await h.stop?.();
      } catch (err) {
        console.error(`[lifecycle] stop hook "${h.name}" failed`, err);
      }
    }
    this.started = false;
  }
}
