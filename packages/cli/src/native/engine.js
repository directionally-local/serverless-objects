// The native engine: runs a Wrangler project's Worker and Durable Objects in
// this Node process, with each object's storage in its own SQLite file. It is
// for trusted code; there is no isolate between the app and the engine.
import { createServer } from "node:http";
import nodeModule from "node:module";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { BucketBackup } from "./backup.js";
import { Cluster } from "./cluster.js";
import { PeerClient, PeerServer } from "./peers.js";
import { DurableLog, UnsafeStore } from "./durable.js";
import { AlarmIndex, DurableObjectNamespace, servePeer } from "./objects.js";
import { shardOf } from "./ports.js";
import { readProjectConfig } from "./project.js";
import { WebSocketPair, WebSocketRequestResponsePair, WorkersWebSocket, connect, socketGone } from "./websocket.js";

// cloudflare:* modules resolve to these shims, for the app and for packages.
const SHIMS = {
  "cloudflare:workers": new URL("./workers-shim.js", import.meta.url).href,
  "cloudflare:email": new URL("./email-shim.js", import.meta.url).href,
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
  // backup: { client, prefix, intervalMs, mode, retentionMs } puts objects in
  // an S3 bucket: copies every interval ("interval"), or every write before it
  // is acknowledged ("durable", restorable to any point within retentionMs).
  // shard: { index, count, peer(index) } when this engine is one of several
  // threads (--threads); it then runs only the objects whose IDs map to it.
  // cluster: { name, ttlMs, onFence } makes this node one of several sharing
  // the bucket (durable mode only); objects are claimed as they are used.
  // drainMs: how long close() waits for requests and events in progress.
  constructor({ config, persistDirectory, idleEvictMs = 60_000, backup, shard, cluster, trustForwardedHeaders = false, drainMs = 30_000, log = (message) => console.error(message) }) {
    this.shard = shard;
    if (cluster && backup?.mode !== "durable") throw new Error("Running several nodes needs --backup-mode durable.");
    if (cluster && shard) throw new Error("--node-name can't be combined with --threads yet.");
    this.idleEvictMs = idleEvictMs;
    this.trustForwardedHeaders = trustForwardedHeaders;
    this.drainMs = drainMs;
    this.evictions = 0;
    this.config = config;
    this.scriptName = config.name ?? "worker";
    this.persistDirectory = persistDirectory;
    this.objectsDirectory = join(persistDirectory, "objects");
    this.log = log;
    this.namespaces = [];
    this.env = {};
    this.exports = {};
    if (backup?.mode === "durable") {
      this.durable = new DurableLog({
        client: backup.client,
        prefix: backup.prefix,
        scriptName: this.scriptName,
        writer: cluster ? cluster.name : shard ? `t${shard.index}` : "t0",
        statePath: join(persistDirectory, "log-state.sqlite"),
        objectsDirectory: this.objectsDirectory,
        owns: (id) => this.owns(id),
        alive: () => !this.cluster || this.cluster.alive(),
        // With several nodes, only objects this node owns now, in their current epoch.
        mayCompact: (row) => !this.cluster || (this.cluster.alive() && this.owned.get(`${row.class}/${row.id}`)?.record.epoch === row.epoch),
        tuning: { ...(backup.retentionMs === undefined ? {} : { retentionMs: backup.retentionMs }), ...backup.tuning },
        log,
      });
    } else if (backup) {
      this.backup = new BucketBackup({ ...backup, scriptName: this.scriptName, tempDirectory: join(persistDirectory, "backup-tmp"), log });
    }
    if (cluster) {
      this.cluster = new Cluster({
        client: backup.client, prefix: backup.prefix, scriptName: this.scriptName, name: cluster.name, addr: cluster.addr, ttlMs: cluster.ttlMs, log,
        onFence: (reason) => {
          this.#stopServing(reason);
          cluster.onFence?.(reason);
        },
      });
      this.owned = new Map();
      this.routes = new Map();
      this.clusterOptions = cluster;
    }
  }

  async start() {
    installModuleHooks();
    installWorkersGlobals();
    mkdirSync(this.objectsDirectory, { recursive: true });
    this.alarmIndex = new AlarmIndex(join(this.persistDirectory, "alarms.sqlite"));
    if (this.durable) await this.#probeStore();
    // With several nodes, objects are restored as they are claimed. Forwarded
    // calls arrive on the peer listener, whose address goes in the lease.
    if (this.cluster) {
      const peer = this.clusterOptions.peer;
      if (peer) {
        this.peerClient = new PeerClient({ secret: peer.secret });
        this.peerServer = new PeerServer({
          secret: peer.secret,
          log: this.log,
          serve: {
            call: (target, method, args) => servePeer(this, target, (host) => host.call(method, args)),
            fetch: (target, request) => servePeer(this, target, (host) => host.fetch(request)),
          },
        });
        const address = await this.peerServer.listen(peer.listen);
        this.cluster.addr = peer.advertise ?? `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
      }
      await this.cluster.start();
    }
    else if (this.backup || this.durable) await this.#restore();
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
    globalThis.__sobjectsNative = { env: this.env, exports: this.exports, projectImport: globalThis.__sobjectsProjectImport };
    this.handler = module.default;
    if (!this.handler) throw new Error("The Worker has no default export.");
    this.backup?.start(() => this.namespaces.flatMap((namespace) => [...namespace.hosts()]));
    // Restores requested before the engine stopped run as those objects open.
    const restoring = new Set(this.cluster ? [] : (this.durable?.pendingRestores() ?? []).map(({ className, id }) => `${className}/${id}`));
    this.durable?.start();
    // Alarms that were pending when the engine last stopped.
    for (const { class: className, id, at } of this.alarmIndex.pending()) {
      if (!this.owns(id)) continue;
      const namespace = this.namespaces.find((candidate) => candidate.className === className);
      if (!namespace) continue;
      // Opening it restores it, then schedules the restored state's alarm.
      if (restoring.has(`${className}/${id}`)) {
        namespace.host(namespace.idFromString(id));
        continue;
      }
      // A claimed object schedules its own alarm once it opens.
      if (this.cluster) namespace.localHost(id);
      else namespace.host(namespace.idFromString(id)).scheduleAlarm(at);
    }
    if (this.cluster) {
      // Runs alarms of objects whose node is gone: claiming the object takes it over.
      this.waker = setInterval(() => void this.#wake(), this.clusterOptions.wakeMs ?? 5_000);
      this.waker.unref?.();
    }
  }

  #wakeSkip = new Map();
  // Client requests in progress, and open client WebSockets (for draining).
  #inflight = 0;
  #connections = new Set();

  async #wake() {
    if (this.fenced) return;
    for (const [key, route] of this.routes) if (route.until < Date.now()) this.routes.delete(key);
    try {
      for (const { className, id } of await this.cluster.dueAlarms()) {
        const key = `${className}/${id}`;
        if (this.owned.has(key) || (this.#wakeSkip.get(key) ?? 0) > Date.now()) continue;
        const namespace = this.namespaces.find((candidate) => candidate.className === className);
        if (!namespace) continue;
        // A live node runs it: look again after a lease period.
        await namespace.localHost(id).whenReady().catch(() => this.#wakeSkip.set(key, Date.now() + this.cluster.ttlMs));
      }
    } catch (error) {
      this.log(`alarm waker failed: ${error.message}`);
    }
  }

  // Once fenced, the node serves nothing: another node may own its objects.
  #stopServing(reason) {
    this.fenced = reason;
    clearInterval(this.waker);
    for (const namespace of this.namespaces) for (const host of [...namespace.hosts()]) host.close();
  }

  // Waits for the bucket if it can't be reached; fails at once if it answers
  // but doesn't honor conditional writes.
  async #probeStore() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.durable.probeConditionalWrites();
      } catch (error) {
        if (error instanceof UnsafeStore) throw error;
        if (attempt === 0) this.log(`The bucket is unreachable (${error.message}); waiting for it before starting.`);
        await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(30_000, 1_000 * 2 ** attempt)));
      }
    }
  }

  // Objects missing locally come back from the bucket. If the bucket can't
  // be reached, a node that has local state starts from it (restoring only
  // matters for a disk that lost objects); a node with none waits for the
  // bucket, because starting empty would fork the objects' data.
  async #restore() {
    const hasLocalState = readdirSync(this.objectsDirectory, { withFileTypes: true }).some((entry) => entry.isDirectory());
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await (this.backup ?? this.durable).restore(this.objectsDirectory, this.alarmIndex, (id) => this.owns(id));
      } catch (error) {
        // In durable mode the bucket holds the latest copy of every object, so
        // a node never starts without it.
        if (hasLocalState && !this.durable) {
          this.log(`The backup bucket is unreachable (${error.message}); starting from local state without restoring.`);
          return;
        }
        if (attempt === 0) this.log(`The backup bucket is unreachable (${error.message}) and there is no local state; waiting for the bucket before starting.`);
        await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(30_000, 1_000 * 2 ** attempt)));
      }
    }
  }

  get restoredObjects() {
    return (this.backup ?? this.durable)?.restored ?? 0;
  }

  owns(id) {
    return !this.shard || shardOf(id, this.shard.count) === this.shard.index;
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

  // Drains, then stops: no new connections; requests in progress finish
  // (up to drainMs); clients' WebSockets close with 1001; objects finish their
  // events, upload their writes and, with several nodes, are released, while
  // calls other nodes forward meanwhile wait and then go to another node.
  close() {
    this.closing ??= this.#close();
    return this.closing;
  }

  async #close() {
    clearInterval(this.waker);
    const deadline = Date.now() + this.drainMs;
    // Events such as a socket's close reach objects a macrotask later, so
    // each check waits for at least one.
    const settle = async (done) => {
      do await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      while (!done() && Date.now() < deadline);
    };
    const serverClosed = this.server ? new Promise((resolveClose) => this.server.close(() => resolveClose())) : Promise.resolve();
    this.server?.closeIdleConnections();
    for (const connection of [...this.#connections]) connection.goAway();
    await settle(() => this.#inflight === 0);
    // Including any that finished their handshake meanwhile.
    for (const connection of [...this.#connections]) connection.goAway();
    await settle(() => this.#connections.size === 0);
    this.server?.closeAllConnections();
    let handedOff;
    this.handoff = new Promise((resolveHandoff) => { handedOff = resolveHandoff; });
    const hosts = () => this.namespaces.flatMap((namespace) => [...namespace.hosts()]);
    await settle(() => !hosts().some((host) => host.busy()));
    for (const host of hosts()) host.close();
    await this.backup?.close();
    await this.durable?.close();
    if (this.cluster) {
      // Hand objects back so other nodes take them at once, but only those
      // whose writes all reached the bucket; the rest wait out the lease.
      for (const { className, id, record } of this.cluster.fenced ? [] : this.owned.values()) {
        // An object never prepared here (its claim failed) has no writes in
        // this epoch: its history ends where the epoch began.
        let cut = record.history.at(-1).from;
        if (this.durable.epochOf(className, id) === record.epoch) {
          const progress = this.durable.progress(className, id);
          if (!progress || progress.captured !== progress.shipped) continue;
          cut = progress.shipped;
        }
        await this.cluster.release(className, id, record, cut).catch((error) => this.log(`releasing ${className} ${id} failed: ${error.message}`));
      }
    }
    // Forwarded calls that waited now hear that the objects moved.
    handedOff();
    await this.peerServer?.close({ graceMs: 2_000 });
    await this.cluster?.stop();
    await Promise.race([serverClosed, new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]);
    this.alarmIndex?.close();
  }

  async #upgrade(req, socket, head) {
    socket.on("error", () => {});
    this.#inflight += 1;
    try {
      const request = toRequest(req, false, this.trustForwardedHeaders);
      const response = await this.fetch(request);
      if (response?.status === 101 && response.webSocket) {
        // The client left while the object was accepting: the object sees a lost connection.
        if (socketGone(socket)) {
          socket.destroy();
          return void response.webSocket.fail?.(new Error("connection lost"));
        }
        return connect(socket, head, request, response, this.#connections);
      }
      const body = response ? Buffer.from(await response.arrayBuffer()) : Buffer.from("Worker returned no response\n");
      const status = response?.status ?? 500;
      socket.end(`HTTP/1.1 ${status} ${response?.statusText || "Error"}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    } catch (error) {
      this.log(`upgrade failed: ${error?.stack ?? error}`);
      socket.end("HTTP/1.1 500 Internal Server Error\r\nconnection: close\r\n\r\n");
    } finally {
      this.#inflight -= 1;
    }
  }

  async #serve(req, res) {
    this.#inflight += 1;
    res.once("close", () => { this.#inflight -= 1; });
    try {
      const request = toRequest(req, req.method !== "GET" && req.method !== "HEAD", this.trustForwardedHeaders);
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

  // The app's own code is bundled (TypeScript, `define`); its packages load
  // from node_modules as in any Node program, so native addons work. The
  // bundle sits in the project so Node finds the project's node_modules.
  async #load() {
    const { build } = await import("esbuild");
    const entry = resolve(this.config.directory, this.config.main);
    // One bundle per engine thread, so threads starting together don't race on it.
    const outfile = join(this.config.directory, ".sobjects", "bundle", this.shard ? `worker-${this.shard.index}.mjs` : "worker.mjs");
    mkdirSync(dirname(outfile), { recursive: true });
    await build({
      entryPoints: [entry],
      bundle: true,
      packages: "external",
      external: ["cloudflare:*"],
      format: "esm",
      platform: "node",
      target: "node22",
      define: this.config.define ?? {},
      outfile,
      logLevel: "silent",
      // projectImport() resolves packages from the project, for engine-side
      // modules (such as serverless-objects/autopilot/native) that may be linked
      // or hoisted elsewhere.
      banner: { js: "import { createRequire as __sobjectsCreateRequire } from 'node:module'; const require = __sobjectsCreateRequire(import.meta.url); globalThis.__sobjectsProjectImport = (specifier) => import(specifier);" },
    });
    return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
  }

}

// With trustForwarded (only when nothing but a local ingress can reach this
// listener), request.url takes the scheme and host the client used.
export function toRequest(req, hasBody, trustForwarded = false) {
  let scheme = "http";
  let host = req.headers.host ?? "localhost";
  if (trustForwarded) {
    const proto = String(req.headers["x-forwarded-proto"] ?? "").toLowerCase();
    if (proto === "https" || proto === "http") scheme = proto;
    const forwardedHost = req.headers["x-forwarded-host"];
    if (typeof forwardedHost === "string" && /^[A-Za-z0-9.:[\]-]+$/.test(forwardedHost)) host = forwardedHost;
  }
  return new Request(`${scheme}://${host}${req.url}`, {
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

let hooksInstalled = false;

function installModuleHooks() {
  if (hooksInstalled) return;
  if (typeof nodeModule.registerHooks !== "function") throw new Error("The native engine needs Node.js 22.16 or newer.");
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(SHIMS, specifier)) return { url: SHIMS[specifier], shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  hooksInstalled = true;
}
