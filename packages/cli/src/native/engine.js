// The native engine: runs a Wrangler project's Worker and Durable Objects in
// this Node process, with each object's storage in its own SQLite file. It is
// for trusted code; there is no isolate between the app and the engine.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AlarmIndex, DurableObjectNamespace } from "./objects.js";
import { readProjectConfig } from "./project.js";
import { WebSocketPair, WebSocketRequestResponsePair, WorkersWebSocket, connect } from "./websocket.js";

const SHIMS = {
  "cloudflare:workers": fileURLToPath(new URL("./workers-shim.js", import.meta.url)),
  "cloudflare:email": fileURLToPath(new URL("./email-shim.js", import.meta.url)),
};
// Keys the engine understands; anything else that declares a binding is refused.
const SUPPORTED_KEYS = new Set([
  "$schema", "name", "main", "compatibility_date", "compatibility_flags", "durable_objects", "migrations", "vars",
  "observability", "upload_source_maps", "workers_dev", "preview_urls", "account_id", "routes", "route", "minify",
  "keep_vars", "logpush", "placement", "limits", "define",
]);

export async function loadProjectConfig(projectDirectory) {
  const config = await readProjectConfig(projectDirectory);
  const unsupported = Object.keys(config).filter((key) => !SUPPORTED_KEYS.has(key) && key !== "path" && key !== "directory");
  if (unsupported.length > 0) {
    throw new Error(`The native engine does not support these Wrangler settings yet: ${unsupported.join(", ")}. Use the celld engine for this project.`);
  }
  return config;
}

export class NativeEngine {
  // idleEvictMs: drop an idle object's instance after this long (0 keeps it).
  constructor({ config, persistDirectory, idleEvictMs = 60_000, log = (message) => console.error(message) }) {
    this.idleEvictMs = idleEvictMs;
    this.evictions = 0;
    this.config = config;
    this.scriptName = config.name ?? "worker";
    this.persistDirectory = persistDirectory;
    this.objectsDirectory = join(persistDirectory, "objects");
    this.log = log;
    this.namespaces = [];
    this.env = {};
    this.exports = {};
  }

  async start() {
    installWorkersGlobals();
    mkdirSync(this.persistDirectory, { recursive: true });
    this.alarmIndex = new AlarmIndex(join(this.persistDirectory, "alarms.sqlite"));
    const module = await this.#load();
    Object.assign(this.env, this.config.vars ?? {});
    for (const binding of this.config.durable_objects?.bindings ?? []) {
      if (binding.script_name) throw new Error(`Durable Object binding ${binding.name} points at another script (${binding.script_name}); the native engine runs one script.`);
      const objectClass = module[binding.class_name];
      if (typeof objectClass !== "function") throw new Error(`The Worker does not export the Durable Object class ${binding.class_name}.`);
      const namespace = new DurableObjectNamespace(this, { binding: binding.name, className: binding.class_name, objectClass });
      this.namespaces.push(namespace);
      this.env[binding.name] = namespace;
      this.exports[binding.class_name] = namespace;
    }
    globalThis.__sobjectsNative = { env: this.env, exports: this.exports };
    this.handler = module.default;
    if (!this.handler) throw new Error("The Worker has no default export.");
    // Alarms that were pending when the engine last stopped.
    for (const { class: className, id, at } of this.alarmIndex.pending()) {
      const namespace = this.namespaces.find((candidate) => candidate.className === className);
      if (namespace) namespace.host(namespace.idFromString(id)).scheduleAlarm(at);
    }
  }

  // Handles one request with the Worker's default export.
  async fetch(request) {
    const ctx = { waitUntil: (promise) => Promise.resolve(promise).catch(() => {}), passThroughOnException() {} };
    if (typeof this.handler === "function") {
      const entrypoint = new this.handler(ctx, this.env);
      return entrypoint.fetch(request);
    }
    if (typeof this.handler.fetch !== "function") throw new Error("The Worker's default export has no fetch handler.");
    return this.handler.fetch(request, this.env, ctx);
  }

  listen({ host = "127.0.0.1", port = 8787 } = {}) {
    this.server = createServer((req, res) => void this.#serve(req, res));
    this.server.on("upgrade", (req, socket, head) => void this.#upgrade(req, socket, head));
    return new Promise((resolveListen, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolveListen(this.server.address());
      });
    });
  }

  async close() {
    await new Promise((resolveClose) => (this.server ? this.server.close(() => resolveClose()) : resolveClose()));
    for (const namespace of this.namespaces) for (const host of namespace.hosts()) host.close();
    this.alarmIndex?.close();
  }

  async #upgrade(req, socket, head) {
    socket.on("error", () => {});
    try {
      const request = toRequest(req, false);
      const response = await this.fetch(request);
      if (response?.status === 101 && response.webSocket) return connect(socket, head, request, response);
      const body = response ? Buffer.from(await response.arrayBuffer()) : Buffer.from("Worker returned no response\n");
      const status = response?.status ?? 500;
      socket.end(`HTTP/1.1 ${status} ${response?.statusText || "Error"}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    } catch (error) {
      this.log(`upgrade failed: ${error?.stack ?? error}`);
      socket.end("HTTP/1.1 500 Internal Server Error\r\nconnection: close\r\n\r\n");
    }
  }

  async #serve(req, res) {
    try {
      const request = toRequest(req, req.method !== "GET" && req.method !== "HEAD");
      const response = await this.fetch(request);
      if (!response || typeof response.status !== "number" || !response.headers) throw new TypeError("The Worker's fetch handler must return a Response.");
      if (response.status === 101) throw new TypeError("A 101 response needs a WebSocket upgrade request.");
      const headers = {};
      for (const [name, value] of response.headers) if (name !== "set-cookie") headers[name] = value;
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(response.status, response.statusText, headers);
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (error) {
      this.log(`request failed: ${error?.stack ?? error}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`Worker threw: ${error?.message ?? error}\n`);
    }
  }

  async #load() {
    const { build } = await import("esbuild");
    const entry = resolve(this.config.directory, this.config.main);
    const outfile = join(this.persistDirectory, "bundle", `worker-${Date.now()}.mjs`);
    mkdirSync(dirname(outfile), { recursive: true });
    await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      conditions: ["workerd", "worker"],
      alias: SHIMS,
      define: this.config.define ?? {},
      outfile,
      logLevel: "silent",
      // Packages that ship CommonJS need require() inside an ES module bundle.
      banner: { js: "import { createRequire as __sobjectsCreateRequire } from 'node:module'; const require = __sobjectsCreateRequire(import.meta.url);" },
    });
    return import(pathToFileURL(outfile).href);
  }
}

function toRequest(req, hasBody) {
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([name, value]) => (Array.isArray(value) ? value.map((item) => [name, item]) : [[name, value]])),
    ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
  });
}

// Workers globals Node lacks. Response is wrapped so `new Response(null,
// { status: 101, webSocket })` works; instanceof and static methods are unchanged.
function installWorkersGlobals() {
  globalThis.WebSocketPair ??= WebSocketPair;
  globalThis.WebSocketRequestResponsePair ??= WebSocketRequestResponsePair;
  // In Workers the global WebSocket is also the class of WebSocketPair ends,
  // and libraries call its prototype methods directly. Node's global is the
  // outbound client, which keeps working; pair ends answer instanceof too.
  const ClientWebSocket = globalThis.WebSocket;
  if (ClientWebSocket && !ClientWebSocket[RESPONSE_PATCHED]) {
    for (const name of ["accept", "serializeAttachment", "deserializeAttachment"]) {
      Object.defineProperty(ClientWebSocket.prototype, name, {
        value(...args) {
          if (!(this instanceof WorkersWebSocket)) throw new TypeError(`${name}() is only available on server-side WebSockets.`);
          return WorkersWebSocket.prototype[name].apply(this, args);
        },
        configurable: true,
        writable: true,
      });
    }
    const nativeHasInstance = Function.prototype[Symbol.hasInstance];
    Object.defineProperty(ClientWebSocket, Symbol.hasInstance, {
      value: (value) => value instanceof WorkersWebSocket || nativeHasInstance.call(ClientWebSocket, value),
      configurable: true,
    });
    Object.defineProperty(ClientWebSocket, RESPONSE_PATCHED, { value: true });
  }
  if (globalThis.Response[RESPONSE_PATCHED]) return;
  const NativeResponse = globalThis.Response;
  globalThis.Response = new Proxy(NativeResponse, {
    construct(target, [body, init], newTarget) {
      const constructor = newTarget === globalThis.Response ? target : newTarget;
      if (init?.status === 101) {
        const response = Reflect.construct(target, [null, { ...init, status: 200 }], constructor);
        Object.defineProperty(response, "status", { value: 101 });
        Object.defineProperty(response, "webSocket", { value: init.webSocket ?? null });
        return response;
      }
      return Reflect.construct(target, [body, init], constructor);
    },
    get(target, property) {
      if (property === RESPONSE_PATCHED) return true;
      return Reflect.get(target, property, target);
    },
  });
}

const RESPONSE_PATCHED = Symbol.for("sobjects.native.response101");
