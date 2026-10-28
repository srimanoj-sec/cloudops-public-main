/**
 * Minimal, dependency-free typed DI container.
 *
 * Services are registered under a typed token and resolved lazily. Factories
 * receive the container so they can resolve their own dependencies. This is the
 * seam every module and plugin wires through — no service constructs another
 * concrete dependency directly.
 */

export interface Token<T> {
  readonly key: symbol;
  /** phantom type marker — never read at runtime */
  readonly _type?: T;
}

export function createToken<T>(description: string): Token<T> {
  return { key: Symbol(description) };
}

type Factory<T> = (container: Container) => T;

interface Registration<T> {
  factory: Factory<T>;
  singleton: boolean;
  instance?: T;
}

export class Container {
  private readonly registrations = new Map<symbol, Registration<unknown>>();

  /** Register a singleton (created once, memoised). */
  register<T>(token: Token<T>, factory: Factory<T>): void {
    this.registrations.set(token.key, { factory, singleton: true });
  }

  /** Register a transient (created on every resolve). */
  registerTransient<T>(token: Token<T>, factory: Factory<T>): void {
    this.registrations.set(token.key, { factory, singleton: false });
  }

  /** Register an already-constructed value. */
  registerValue<T>(token: Token<T>, value: T): void {
    this.registrations.set(token.key, { factory: () => value, singleton: true, instance: value });
  }

  has<T>(token: Token<T>): boolean {
    return this.registrations.has(token.key);
  }

  resolve<T>(token: Token<T>): T {
    const reg = this.registrations.get(token.key) as Registration<T> | undefined;
    if (!reg) {
      throw new Error(`No registration for token: ${token.key.description ?? '<anonymous>'}`);
    }
    if (reg.singleton) {
      if (reg.instance === undefined) {
        reg.instance = reg.factory(this);
      }
      return reg.instance;
    }
    return reg.factory(this);
  }

  /** Create a child scope that inherits parent registrations. */
  createScope(): Container {
    const child = new Container();
    for (const [key, reg] of this.registrations) {
      child.registrations.set(key, { ...reg });
    }
    return child;
  }
}
