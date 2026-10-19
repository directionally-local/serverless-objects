// Drop-in for the @cloudflare/sandbox 0.x entry points:
//
//   import { getSandbox, Sandbox } from "@serverless-objects/hotcell";
//   export { Sandbox };
//   const sandbox = getSandbox(env.Sandbox, "user-123");
//   await sandbox.exec("python3 -c 'print(2 + 2)'");
//
// The Durable Object talks to a Hotcell daemon at HOTCELL_ENDPOINT
// (default http://127.0.0.1:4750) with HOTCELL_API_KEY from the Worker env.
import { DurableObject } from "cloudflare:workers";
import { HotcellSandbox, SANDBOX_METHODS, sandboxName } from "./sandbox.js";

const CORE = Symbol("sobjects.hotcell.core");

export class Sandbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this[CORE] = new HotcellSandbox({ storage: ctx.storage, env });
  }

  invoke(method, args, options) {
    return this[CORE].invoke(method, args, options);
  }
}

for (const method of SANDBOX_METHODS) {
  Sandbox.prototype[method] = function (...args) {
    return this[CORE][method](...args);
  };
}

// Returns a stub whose Sandbox methods are RPC calls on the named object.
// Options are sent with the first call and apply when Hotcell creates the
// sandbox; the stub's own members (fetch, id, ...) pass through.
export function getSandbox(ns, id, options) {
  const name = sandboxName(id, options);
  const stub = typeof ns.getByName === "function" ? ns.getByName(name) : ns.get(ns.idFromName(name));
  let pendingOptions = options;
  return new Proxy(stub, {
    get(target, property) {
      if (typeof property === "string" && SANDBOX_METHODS.includes(property)) {
        return (...args) => {
          const sent = pendingOptions;
          pendingOptions = undefined;
          return target.invoke(property, args, sent);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Hotcell serves preview URLs from its own proxy, so there is nothing to
// route here. Kept so a Cloudflare Worker's fetch handler ports unchanged.
export async function proxyToSandbox() {
  return null;
}
