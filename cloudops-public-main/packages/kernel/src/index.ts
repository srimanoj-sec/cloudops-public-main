/**
 * @cloudops/kernel — the Platform Kernel.
 *
 * Dependency-free primitives every module and plugin builds on: DI container,
 * typed config, lifecycle management, plugin loader, event bus, scheduler, and
 * logging contracts. New capabilities are kernel plugins — the core never
 * imports a feature engine concretely.
 */

export { Container, createToken, type Token } from './container.js';
export { EventBus, type EventHandler, type KernelEventMap } from './events.js';
export { LifecycleManager, type LifecycleHooks } from './lifecycle.js';
export { PluginRegistry, type Plugin, type PluginContext } from './plugins.js';
export { type Scheduler, type ScheduleOptions } from './scheduler.js';
export { type Logger, noopLogger } from './logger.js';
export { loadConfig, type ConfigValidator } from './config.js';

import { Container } from './container.js';
import { EventBus } from './events.js';
import { LifecycleManager } from './lifecycle.js';
import { PluginRegistry, type PluginContext } from './plugins.js';

/** The assembled kernel — created once at application boot. */
export interface Kernel {
  container: Container;
  events: EventBus;
  lifecycle: LifecycleManager;
  plugins: PluginRegistry;
}

export function createKernel(): Kernel {
  const container = new Container();
  const events = new EventBus();
  const lifecycle = new LifecycleManager();
  const ctx: PluginContext = { container, events, lifecycle };
  const plugins = new PluginRegistry(ctx);
  return { container, events, lifecycle, plugins };
}
