// Durable Object namespaces, stubs and per-object hosts for the native engine.
//
// Each object has one host. Every incoming event (an RPC call, a fetch, an
// alarm) starts in its own macrotask, after the previous event's microtasks
// have run, so code that only awaits storage is never interleaved. An event
// that awaits real I/O lets the next one start, as on Cloudflare.
// blockConcurrencyWhile() and async transactions close the input gate until
// they settle.
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OwnedElsewhere } from "./cluster.js";
import { IdIssuer } from "./ids.js";
import { NotOwner } from "./peers.js";
import { decodeRequest, decodeResponse, encodeRequest, encodeResponse, shardOf } from "./ports.js";
import { DurableObjectStorage, ObjectDatabase } from "./storage.js";
import { READY_STATE, WebSocketRequestResponsePair, WorkersWebSocket } from "./websocket.js";

const MAX_TIMER_MS = 2 ** 31 - 1;
// The object whose event is running, so a socket accepted with accept() keeps
// that object in memory.
const currentHost = new AsyncLocalStorage();
WorkersWebSocket.ownerOf = () => currentHost.getStore();
const ALARM_RETRY_LIMIT = 6;
const ALARM_RETRY_BASE_MS = 2_000;

export class DurableObjectNamespace {
  #engine;
  #issuer;
  #hosts = new Map();

  constructor(engine, { binding, className, objectClass }) {
    this.#engine = engine;
    this.binding = binding;
    this.className = className;
    this.objectClass = objectClass;
    this.#issuer = new IdIssuer(engine.scriptName, className);
  }

  idFromName(name) {
    return this.#issuer.fromName(name);
  }

  newUniqueId() {
    return this.#issuer.unique();
  }

  idFromString(hex) {
    return this.#issuer.fromString(hex);
  }

  get(id) {
    if (!id || typeof id.toString !== "function") throw new TypeError("get() takes a DurableObjectId.");
    const host = this.host(id);
    return createStub(() => this.host(id), host.id);
  }

  getByName(name) {
    return this.get(this.idFromName(name));
  }

  jurisdiction() {
    return this;
  }

  // The object's host: here, or a relay to the thread that owns it
  // (--threads), or, with several nodes, a router to whichever node runs it.
  host(id) {
    if (this.#engine.fenced) throw new Error(`This node stopped serving: ${this.#engine.fenced}.`);
    if (this.#engine.cluster) return new RoutedHost(this.#engine, this, id);
    const key = id.toString();
    const shard = this.#engine.shard;
    if (shard && shardOf(key, shard.count) !== shard.index) return new RemoteHost(this.#engine, this.className, id);
    return this.localHost(key, id.name);
  }

  localHost(key, name) {
    let host = this.#hosts.get(key);
    if (!host) {
      host = new ObjectHost(this.#engine, this, this.idFromString(key), name);
      this.#hosts.set(key, host);
    }
    return host;
  }

  hosts() {
    return this.#hosts.values();
  }

  release(host) {
    if (this.#hosts.get(host.id.toString()) === host) this.#hosts.delete(host.id.toString());
  }
}

// An object owned by another thread. Arguments, results, errors and bodies
// cross as they do for any RPC call: structured clones and streams.
class RemoteHost {
  #engine;
  #className;

  constructor(engine, className, id) {
    this.#engine = engine;
    this.#className = className;
    this.id = id;
  }

  #owner() {
    return this.#engine.shard.peer(shardOf(this.id.toString(), this.#engine.shard.count));
  }

  call(method, args) {
    return this.#owner().request("call", { className: this.#className, id: this.id.toString(), name: this.id.name, method, args });
  }

  async fetch(request) {
    const { value, transfer } = encodeRequest(request);
    const response = await this.#owner().request("fetch", { className: this.#className, id: this.id.toString(), name: this.id.name, request: value }, transfer);
    return decodeResponse(response);
  }
}

// With several nodes: runs a call here if this node can claim the object, and
// otherwise on the node that runs it (through its peer listener). A request
// that may have reached a node is never sent again; one the other node
// refused (it no longer runs the object) is routed once more.
class RoutedHost {
  #engine;
  #namespace;

  constructor(engine, namespace, id) {
    this.#engine = engine;
    this.#namespace = namespace;
    this.id = id;
  }

  call(method, args) {
    return this.#route((host) => host.call(method, args), (route, target) => this.#engine.peerClient.call(route.addr, target, method, args), true);
  }

  fetch(request) {
    return this.#route((host) => host.fetch(request), (route, target) => this.#engine.peerClient.fetch(route.addr, target, request), !request.body);
  }

  async #route(local, remote, retryable) {
    const engine = this.#engine;
    const className = this.#namespace.className;
    const id = this.id.toString();
    const key = `${className}/${id}`;
    const target = { className, id, name: this.id.name };
    for (let attempt = 0; ; attempt += 1) {
      let route = engine.routes.get(key);
      if (route && route.until < Date.now()) {
        engine.routes.delete(key);
        route = undefined;
      }
      if (!route) {
        const host = this.#namespace.localHost(id, this.id.name);
        try {
          await host.whenReady();
        } catch (error) {
          if (!(error instanceof OwnedElsewhere) || !error.addr || !engine.peerClient) throw error;
          route = { node: error.node, addr: error.addr, until: Date.now() + Math.floor(engine.cluster.ttlMs / 2) };
          engine.routes.set(key, route);
        }
        if (!route) return local(host);
      }
      try {
        return await remote(route, target);
      } catch (error) {
        engine.routes.delete(key);
        if ((error instanceof NotOwner || error.notSent) && retryable && attempt === 0) continue;
        throw error;
      }
    }
  }
}

// Runs a call or fetch that another node forwarded: only here, and only if
// this node runs (or can claim) the object.
export async function servePeer(engine, { className, id, name }, run) {
  const namespace = engine.namespaces.find((candidate) => candidate.className === className);
  if (!namespace) throw new Error(`No Durable Object class ${className} in this Worker.`);
  // A draining node hands its objects off: once they are released, the
  // caller routes the request again and another node claims the object.
  // An object still busy here keeps serving, since the call may be part of
  // an event it is running (a call back into it, or a chain through it).
  const open = [...namespace.hosts()].find((candidate) => candidate.id.toString() === id);
  if (engine.handoff && !open?.busy()) {
    await engine.handoff;
    throw Object.assign(new NotOwner("This node is shutting down and has released its objects."), { beforeRun: true });
  }
  const host = namespace.localHost(id, name);
  try {
    await host.whenReady();
  } catch (error) {
    // Only this refusal, before anything ran, lets the caller try another node.
    if (error instanceof OwnedElsewhere) throw Object.assign(new NotOwner(error.message), { beforeRun: true });
    throw error;
  }
  return run(host);
}

// Answers another thread's call or fetch for an object this thread owns.
export async function servePeerRequest(engine, type, { className, id, name, method, args, request }) {
  const namespace = engine.namespaces.find((candidate) => candidate.className === className);
  if (!namespace) throw new Error(`No Durable Object class ${className} in this Worker.`);
  const host = namespace.localHost(id, name);
  if (type === "call") return host.call(method, args);
  if (type === "fetch") return encodeResponse(await host.fetch(decodeRequest(request)));
  throw new Error(`Unknown request ${type}`);
}

export class ObjectHost {
  #engine;
  #namespace;
  #database;
  #instance;
  #state;
  #queue = [];
  #scheduled = false;
  #gates = new Set();
  #alarmTimer;
  #alarmRetries = 0;
  // Hibernatable sockets belong to the host, not the instance.
  #sockets = new Map();
  #autoResponse = null;
  #running = 0;
  #pinned = new Set();
  #lifetimes = new Set();
  #idleTimer;
  #closed = false;
  #alarmActive = false;

  #ready = null;
  #claiming = false;

  constructor(engine, namespace, id, name) {
    this.#engine = engine;
    this.#namespace = namespace;
    this.id = id;
    // With several nodes the object is claimed (and, if its owner changed,
    // restored from the bucket) before it opens; events wait for that.
    // An object asked to restore a bookmark (onNextSessionRestoreBookmark)
    // is rebuilt first, too.
    if (engine.cluster) {
      this.#ready = this.#claim(name);
      // Events see the error; nothing else waits on it.
      this.#ready.catch(() => {});
    } else if (engine.durable?.restorePending(namespace.className, id.toString())) {
      this.#ready = this.#restoreThenOpen(name);
      this.#ready.catch(() => {});
    } else {
      this.#open(name);
      // A host that reopens an object (after ctx.abort(), say) runs its alarm.
      const alarm = this.#database.meta("alarm") ?? this.#database.meta("alarm_running");
      if (alarm !== null) this.scheduleAlarm(Number(alarm));
    }
  }

  async #restoreThenOpen(name, history) {
    this.#claiming = true;
    try {
      await this.#engine.durable.restorePoint(this.#namespace.className, this.id.toString(), { history, alarmIndex: this.#engine.alarmIndex });
      if (this.#closed) return;
      this.#open(name);
      const alarm = this.#database.meta("alarm") ?? this.#database.meta("alarm_running");
      this.scheduleAlarm(alarm === null ? null : Number(alarm));
    } catch (error) {
      // The next call tries again.
      this.#closed = true;
      this.#namespace.release(this);
      throw error;
    } finally {
      this.#claiming = false;
    }
  }

  #open(name) {
    const id = this.id;
    this.#database = new ObjectDatabase(join(this.#engine.objectsDirectory, this.#namespace.className, `${id.toString()}.sqlite`), { durable: Boolean(this.#engine.durable) });
    // Remember the name, so ctx.id.name survives addressing by idFromString() and restarts.
    if (name !== undefined && this.#database.meta("name") === null) this.#database.setMeta("name", name);
    const storedName = this.#database.meta("name");
    this.id = storedName === null ? id : new id.constructor(id.toString(), storedName);
    this.#engine.durable?.attach(this);
  }

  // One mirror write at a time, each writing the latest value, with retries.
  #mirror = { value: undefined, chain: Promise.resolve() };

  #mirrorAlarm(value) {
    this.#mirror.value = value;
    this.#mirror.chain = this.#mirror.chain.then(async () => {
      const value = this.#mirror.value;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          return await this.#engine.cluster.setAlarm(this.#namespace.className, this.id.toString(), value);
        } catch (error) {
          if (attempt === 4) this.#engine.log(`alarm mirror for ${this.#namespace.className} ${this.id} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
        }
      }
    });
  }

  // Resolves once the object is open here (with several nodes, once claimed).
  whenReady() {
    return this.#ready ?? Promise.resolve();
  }

  async #claim(name) {
    const engine = this.#engine;
    const className = this.#namespace.className;
    const id = this.id.toString();
    this.#claiming = true;
    try {
      const { record, cut, changed } = await engine.cluster.acquire(className, id, { cutFor: (owner) => engine.durable.cutFor(className, id, owner) });
      // Kept after eviction (and if this host closed meanwhile): the object
      // stays this node's until it is released.
      engine.owned.set(`${className}/${id}`, { className, id, record });
      // A claim whose preparation failed earlier is prepared again: the local
      // copy is only right once its epoch is the record's.
      if (changed || engine.durable.epochOf(className, id) !== record.epoch) {
        await engine.durable.prepareObject(className, id, { record, cut: changed ? cut : record.history.at(-1).from, alarmIndex: engine.alarmIndex });
      }
      if (this.#closed) return;
      this.owner = record;
      if (engine.durable.restorePending(className, id)) {
        await engine.durable.restorePoint(className, id, { history: record.history, alarmIndex: engine.alarmIndex });
        if (this.#closed) return;
      }
      this.#open(name);
      const alarm = this.#database.meta("alarm") ?? this.#database.meta("alarm_running");
      if (alarm !== null) this.scheduleAlarm(Number(alarm));
    } catch (error) {
      // The next call claims it again (its owner may since have gone).
      this.#closed = true;
      this.#namespace.release(this);
      throw error;
    } finally {
      this.#claiming = false;
    }
  }

  call(method, args) {
    const cloned = structuredClone(args);
    return this.#deliver(async (instance) => {
      const fn = instance[method];
      if (typeof fn !== "function") throw new TypeError(`The RPC receiver does not implement the method "${String(method)}".`);
      return structuredClone(await fn.apply(instance, cloned));
    }).catch((error) => { throw crossBoundary(error); });
  }

  fetch(request) {
    return this.#deliver(async (instance) => {
      if (typeof instance.fetch !== "function") throw new TypeError("This Durable Object class has no fetch handler.");
      return instance.fetch(request);
    });
  }

  // Called when the alarm is set, deleted or due. The index keeps an alarm
  // that is running until it finishes, so a restart delivers it again.
  scheduleAlarm(at) {
    clearTimeout(this.#alarmTimer);
    this.#alarmTimer = undefined;
    const running = this.#database.meta("alarm_running");
    const indexed = at ?? (running === null ? null : Number(running));
    this.#engine.alarmIndex.set(this.#namespace.className, this.id.toString(), indexed);
    // Mirrored to the bucket, so another node runs it if this one dies.
    if (this.#engine.cluster) this.#mirrorAlarm(indexed);
    if (at === null) return;
    const delay = Math.max(0, at - Date.now());
    this.#alarmTimer = setTimeout(() => {
      this.#alarmTimer = undefined;
      if (delay > MAX_TIMER_MS) this.scheduleAlarm(at);
      else void this.#runAlarm().catch((error) => this.#engine.log(`alarm for ${this.#namespace.className} ${this.id} failed: ${error?.stack ?? error}`));
    }, Math.min(delay, MAX_TIMER_MS));
    this.#alarmTimer.unref?.();
  }

  async #runAlarm() {
    // One alarm run at a time; a new alarm set meanwhile is scheduled after.
    if (this.#alarmActive) return;
    // An alarm whose handler was cut off (the engine stopped) runs again first.
    const interrupted = this.#database.meta("alarm_running");
    const pending = this.#database.meta("alarm");
    const scheduled = interrupted ?? pending;
    if (scheduled === null) return;
    if (interrupted === null && Number(pending) > Date.now()) return this.scheduleAlarm(Number(pending));
    const retryCount = this.#alarmRetries;
    this.#alarmActive = true;
    // The alarm is cleared before the handler runs (the handler may set a new
    // one) and marked running until the handler succeeds or gives up.
    if (interrupted === null) {
      this.#database.transact(() => {
        this.#database.setMeta("alarm", null);
        this.#database.setMeta("alarm_running", scheduled);
      });
    }
    try {
      await this.#deliver(async (instance) => {
        if (typeof instance.alarm !== "function") throw new TypeError("This Durable Object class has no alarm handler.");
        await instance.alarm({ retryCount, isRetry: retryCount > 0 || interrupted !== null });
      });
      if (this.#closed) return;
      this.#alarmRetries = 0;
      this.#database.setMeta("alarm_running", null);
    } catch (error) {
      this.#engine.log(`alarm for ${this.#namespace.className} ${this.id} failed: ${error?.stack ?? error}`);
      // Reset or stopped meanwhile (ctx.abort()): the alarm stays marked
      // running, so the next host runs it again.
      if (this.#closed) return;
      if (retryCount + 1 > ALARM_RETRY_LIMIT) {
        this.#alarmRetries = 0;
        this.#database.setMeta("alarm_running", null);
      } else {
        this.#alarmRetries = retryCount + 1;
        this.#database.transact(() => {
          if (this.#database.meta("alarm") === null) this.#database.setMeta("alarm", Date.now() + ALARM_RETRY_BASE_MS * 2 ** retryCount);
          this.#database.setMeta("alarm_running", null);
        });
      }
    } finally {
      this.#alarmActive = false;
      // A handler still running when the engine stopped finds its database closed.
      if (!this.#closed) {
        const next = this.#database.meta("alarm");
        this.scheduleAlarm(next === null ? null : Number(next));
      }
    }
  }

  acceptWebSocket(socket, tags = []) {
    if (!(socket instanceof WorkersWebSocket)) throw new TypeError("acceptWebSocket() takes the server end of a WebSocketPair.");
    if (this.#sockets.has(socket)) throw new TypeError("This WebSocket was already accepted.");
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw new TypeError("WebSocket tags must be an array of strings.");
    if (tags.length > 10) throw new RangeError("A WebSocket can have at most 10 tags.");
    this.#sockets.set(socket, { tags: [...tags], autoResponseAt: null });
    socket.takeOver((target, event) => this.#socketEvent(target, event));
  }

  webSockets(tag) {
    return [...this.#sockets].filter(([socket, record]) => socket.readyState !== READY_STATE.CLOSED && (tag === undefined || record.tags.includes(tag))).map(([socket]) => socket);
  }

  tags(socket) {
    const record = this.#sockets.get(socket);
    if (!record) throw new TypeError("This WebSocket was not accepted with acceptWebSocket().");
    return [...record.tags];
  }

  setAutoResponse(pair) {
    if (pair !== undefined && pair !== null && !(pair instanceof WebSocketRequestResponsePair)) throw new TypeError("setWebSocketAutoResponse() takes a WebSocketRequestResponsePair.");
    this.#autoResponse = pair ?? null;
  }

  autoResponse() {
    return this.#autoResponse;
  }

  autoResponseTimestamp(socket) {
    return this.#sockets.get(socket)?.autoResponseAt ?? null;
  }

  // Socket events reach the object's handlers through its event queue. An
  // auto-response is answered without waking the object.
  #socketEvent(socket, event) {
    const record = this.#sockets.get(socket);
    if (event.type === "message" && this.#autoResponse && event.data === this.#autoResponse.request && socket.readyState === READY_STATE.OPEN) {
      socket.send(this.#autoResponse.response);
      if (record) record.autoResponseAt = new Date();
      return;
    }
    const handler = { message: "webSocketMessage", close: "webSocketClose", error: "webSocketError" }[event.type];
    const args = event.type === "message" ? [event.data]
      : event.type === "close" ? [event.code ?? 1005, event.reason ?? "", event.clean !== false]
        : [event.error];
    this.#deliver(async (instance) => {
      if (typeof instance[handler] === "function") await instance[handler](socket, ...args);
    }).catch((error) => this.#engine.log(`${handler} failed: ${error?.stack ?? error}`)).finally(() => {
      if (event.type === "close") this.#sockets.delete(socket);
    });
  }

  holdInputGate(promise) {
    const gate = Promise.resolve(promise).then(() => {}, () => {});
    this.#gates.add(gate);
    gate.then(() => {
      this.#gates.delete(gate);
      this.#schedule();
    });
  }

  // Whether an event is queued or running, or the object asked to stay up.
  busy() {
    return this.#claiming || this.#running > 0 || this.#queue.length > 0 || this.#gates.size > 0 || this.#lifetimes.size > 0 || this.#alarmActive;
  }

  backupSource() {
    return { className: this.#namespace.className, id: this.id.toString(), database: this.#database };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#database) return;
    this.#engine.backup?.capture(this);
    this.#engine.durable?.detach(this);
    clearTimeout(this.#alarmTimer);
    clearTimeout(this.#idleTimer);
    this.#database.close();
  }

  // A socket accepted with accept() and listeners keeps the object in memory.
  pinSocket(socket) {
    this.#pinned.add(socket);
    clearTimeout(this.#idleTimer);
  }

  unpinSocket(socket) {
    this.#pinned.delete(socket);
    this.#maybeIdle();
  }

  // ctx.waitUntil(): the object stays in memory until the promise settles.
  keepAlive(promise) {
    const lifetime = Promise.resolve(promise).then(() => {}, (error) => this.#engine.log(`waitUntil promise rejected: ${error?.stack ?? error}`));
    this.#lifetimes.add(lifetime);
    clearTimeout(this.#idleTimer);
    lifetime.then(() => {
      this.#lifetimes.delete(lifetime);
      this.#maybeIdle();
    });
  }

  // Drops the instance after the idle period. Hibernatable sockets and a
  // pending alarm stay with the host; a fully idle host also closes its
  // database and leaves memory.
  #maybeIdle() {
    clearTimeout(this.#idleTimer);
    const idleMs = this.#engine.idleEvictMs;
    if (!idleMs || this.#closed || !this.#instance) return;
    if (this.#running > 0 || this.#queue.length > 0 || this.#gates.size > 0 || this.#pinned.size > 0 || this.#lifetimes.size > 0) return;
    this.#idleTimer = setTimeout(() => this.#evict(), idleMs);
    this.#idleTimer.unref?.();
  }

  #evict() {
    if (this.#running > 0 || this.#queue.length > 0 || this.#gates.size > 0 || this.#pinned.size > 0 || this.#lifetimes.size > 0) return;
    this.#instance = undefined;
    this.#state = undefined;
    this.#engine.evictions += 1;
    if (this.#sockets.size === 0 && this.#alarmTimer === undefined) {
      this.close();
      this.#namespace.release(this);
    }
  }

  #deliver(run) {
    clearTimeout(this.#idleTimer);
    return new Promise((resolve, reject) => {
      this.#queue.push({ run, resolve, reject });
      this.#schedule();
    });
  }

  #schedule() {
    if (this.#scheduled || this.#queue.length === 0) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      void this.#pump();
    });
  }

  async #pump() {
    if (this.#gates.size > 0 || this.#queue.length === 0) return;
    if (this.#ready) {
      const ready = this.#ready;
      try {
        await ready;
      } catch (error) {
        for (const event of this.#queue.splice(0)) event.reject(crossBoundary(error));
        return;
      }
      if (this.#ready === ready) this.#ready = null;
      if (this.#gates.size > 0 || this.#queue.length === 0) return;
    }
    let instance;
    try {
      instance = currentHost.run(this, () => this.#ensureInstance());
    } catch (error) {
      for (const event of this.#queue.splice(0)) event.reject(error);
      return;
    }
    // A constructor may have closed the gate with blockConcurrencyWhile().
    if (this.#gates.size > 0) return;
    const event = this.#queue.shift();
    this.#schedule();
    this.#running += 1;
    try {
      const result = await currentHost.run(this, () => event.run(instance));
      // The output gate: the result waits until the writes it may reflect are durable.
      await this.#outputGate();
      event.resolve(result);
    } catch (error) {
      await this.#outputGate().catch(() => {});
      event.reject(error);
    } finally {
      this.#running -= 1;
      this.#maybeIdle();
    }
  }

  // If the writes can't be made durable, the instance is dropped, as on
  // Cloudflare, so its memory doesn't run ahead of what storage promises.
  async #outputGate() {
    const gate = this.#engine.durable?.commit(this);
    if (!gate) return;
    try {
      await gate;
    } catch (error) {
      this.#instance = undefined;
      this.#state = undefined;
      throw error;
    }
  }

  // Point-in-time recovery, which needs the bucket's log (durable mode).
  #bookmarks() {
    const durable = this.#engine.durable;
    const unavailable = () => {
      throw new Error("Point-in-time recovery needs --backup-mode durable: bookmarks name transactions in the bucket's log.");
    };
    if (!durable) return { current: unavailable, forTime: unavailable, restore: unavailable };
    const history = () => this.#engine.owned?.get(`${this.#namespace.className}/${this.id}`)?.record.history;
    return {
      current: () => durable.currentBookmark(this),
      forTime: (time) => durable.bookmarkForTime(this, time, history()),
      restore: (bookmark) => durable.requestRestore(this, bookmark, history()),
    };
  }

  // ctx.abort(): the instance is reset. Queued events and the caller fail
  // with the reason; the next event starts a new instance (and applies a
  // bookmark restore, if one was requested).
  abort(reason) {
    const error = reason instanceof Error ? reason : new Error(reason === undefined ? "The Durable Object was aborted." : String(reason));
    if (!this.#closed) {
      const alarm = this.#database ? this.#database.meta("alarm") ?? this.#database.meta("alarm_running") : null;
      for (const event of this.#queue.splice(0)) event.reject(error);
      for (const socket of this.#sockets.keys()) {
        try {
          socket.close(1011, "Durable Object reset");
        } catch {}
      }
      this.#sockets.clear();
      this.#instance = undefined;
      this.#state = undefined;
      this.close();
      this.#namespace.release(this);
      // A pending alarm opens the object again, so it still runs.
      if (alarm !== null) setImmediate(() => !this.#engine.closing && this.#namespace.localHost(this.id.toString(), this.id.name));
    }
    throw error;
  }

  #ensureInstance() {
    if (this.#instance) return this.#instance;
    const storage = new DurableObjectStorage(this.#database, {
      onAlarmChange: (at) => this.scheduleAlarm(at),
      holdInputGate: (promise) => this.holdInputGate(promise),
      bookmarks: this.#bookmarks(),
    });
    this.#state = new DurableObjectState(this, this.id, storage, this.#engine.exports);
    this.#instance = new this.#namespace.objectClass(this.#state, this.#engine.env);
    return this.#instance;
  }
}

export class DurableObjectState {
  #host;

  constructor(host, id, storage, exports) {
    this.#host = host;
    this.id = id;
    this.storage = storage;
    this.exports = exports;
  }

  blockConcurrencyWhile(callback) {
    const result = (async () => callback())();
    this.#host.holdInputGate(result);
    return result;
  }

  waitUntil(promise) {
    this.#host.keepAlive(promise);
  }

  abort(reason) {
    this.#host.abort(reason);
  }

  acceptWebSocket(socket, tags) {
    this.#host.acceptWebSocket(socket, tags);
  }

  getWebSockets(tag) {
    return this.#host.webSockets(tag);
  }

  getTags(socket) {
    return this.#host.tags(socket);
  }

  setWebSocketAutoResponse(pair) {
    this.#host.setAutoResponse(pair);
  }

  getWebSocketAutoResponse() {
    return this.#host.autoResponse();
  }

  getWebSocketAutoResponseTimestamp(socket) {
    return this.#host.autoResponseTimestamp(socket);
  }

  setHibernatableWebSocketEventTimeout() {}

  getHibernatableWebSocketEventTimeout() {
    return null;
  }
}

// Which objects have a pending alarm, so alarms fire after a restart.
export class AlarmIndex {
  #db;

  constructor(path) {
    this.#db = new DatabaseSync(path);
    // Every engine thread (--threads) opens this index.
    this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS alarms (class TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (class, id)) WITHOUT ROWID");
  }

  set(className, id, at) {
    if (at === null) this.#db.prepare("DELETE FROM alarms WHERE class = ? AND id = ?").run(className, id);
    else this.#db.prepare("INSERT INTO alarms (class, id, at) VALUES (?, ?, ?) ON CONFLICT(class, id) DO UPDATE SET at = excluded.at").run(className, id, at);
  }

  pending() {
    return this.#db.prepare("SELECT class, id, at FROM alarms").all();
  }

  close() {
    this.#db.close();
  }
}

// The host is looked up per call: an idle object's host may have been released.
function createStub(resolveHost, id) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "then" || typeof property === "symbol") return undefined;
      if (property === "id") return id;
      if (property === "name") return id.name;
      if (property === "fetch") return (input, init) => resolveHost().fetch(input instanceof Request && init === undefined ? input : new Request(input, init));
      return (...args) => resolveHost().call(property, args);
    },
  });
}

// Errors cross an RPC boundary as a structured clone, keeping name and message.
function crossBoundary(error) {
  try {
    return structuredClone(error);
  } catch {
    return new Error(String(error?.message ?? error));
  }
}
