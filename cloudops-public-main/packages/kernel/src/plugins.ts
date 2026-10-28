/**
 * Plugin loader & registry.
 *
 * A plugin is anything registered against a typed capability slot: cloud
 * providers, recommendation rules, executors, scoring dimensions, LLM backends.
 * The core discovers plugins through this registry — adding one is dropping a
 * package and calling `register`, never editing the core.
 */

import type { Container } from './container.js';
import type { EventBus } from './events.js';
import type { LifecycleManager } from './lifecycle.js';

export interface PluginContext {
  container: Container;
  events: EventBus;
  lifecycle: LifecycleManager;
}

export interface Plugin {
  /** Unique id, e.g. 'provider:azure', 'rule:cost.idle-vm'. */
  id: string;
  /** Capability slot this plugin fills, e.g. 'provider', 'rule', 'executor'. */
  kind: string;
  /** Called once at registration to wire the plugin into the kernel. */
  register(ctx: PluginContext): void | Promise<void>;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, Plugin>();

  constructor(private readonly ctx: PluginContext) {}

  async use(plugin: Plugin): Promise<void> {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, plugin);
    await plugin.register(this.ctx);
  }

  byKind(kind: string): Plugin[] {
    return [...this.plugins.values()].filter((p) => p.kind === kind);
  }

  all(): Plugin[] {
    return [...this.plugins.values()];
  }
}
