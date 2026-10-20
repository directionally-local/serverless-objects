// The `cloudflare:workers` module for apps run by the native engine. The
// bundler inlines this file, so shared state lives on a global the engine sets.
const runtime = () => globalThis.__sobjectsNative;

export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}

const live = (key) => new Proxy({}, {
  get: (_target, property) => runtime()?.[key]?.[property],
  has: (_target, property) => property in (runtime()?.[key] ?? {}),
  ownKeys: () => Reflect.ownKeys(runtime()?.[key] ?? {}),
  getOwnPropertyDescriptor: (_target, property) => {
    const value = runtime()?.[key]?.[property];
    return value === undefined ? undefined : { value, enumerable: true, configurable: true };
  },
});

export const env = live("env");
// Loopback bindings: each exported Durable Object class as a namespace.
export const exports = live("exports");

export function waitUntil(promise) {
  Promise.resolve(promise).catch(() => {});
}
