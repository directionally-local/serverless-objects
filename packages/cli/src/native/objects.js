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
import { IdIssuer } from "./ids.js";
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

  host(id) {
    const key = id.toString();
    let host = this.#hosts.get(key);
    if (!host) {
      host = new ObjectHost(this.#engine, this, this.idFromString(key), id.name);
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
  #idleTimer;
  #closed = false;

  constructor(engine, namespace, id, name) {
    this.#engine = engine;
    this.#namespace = namespace;
    this.#database = new ObjectDatabase(join(engine.objectsDirectory, namespace.className, `${id.toString()}.sqlite`));
    // Remember the name, so ctx.id.name survives addressing by idFromString() and restarts.
    if (name !== undefined && this.#database.meta("name") === null) this.#database.setMeta("name", name);
    const storedName = this.#database.meta("name");
    this.id = storedName === null ? id : new id.constructor(id.toString(), storedName);
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

  // Called when the alarm is set, deleted or due.
  scheduleAlarm(at) {
    clearTimeout(this.#alarmTimer);
    this.#alarmTimer = undefined;
    this.#engine.alarmIndex.set(this.#namespace.className, this.id.toString(), at);
    if (at === null) return;
    const delay = Math.max(0, at - Date.now());
    this.#alarmTimer = setTimeout(() => {
      this.#alarmTimer = undefined;
      if (delay > MAX_TIMER_MS) this.scheduleAlarm(at);
      else void this.#runAlarm();
    }, Math.min(delay, MAX_TIMER_MS));
    this.#alarmTimer.unref?.();
  }

  async #runAlarm() {
    const scheduled = this.#database.meta("alarm");
    if (scheduled === null) return;
    if (Number(scheduled) > Date.now()) return this.scheduleAlarm(Number(scheduled));
    const retryCount = this.#alarmRetries;
    // The alarm is cleared before the handler runs; the handler may set a new one.
    this.#database.setMeta("alarm", null);
    this.#engine.alarmIndex.set(this.#namespace.className, this.id.toString(), null);
    try {
      await this.#deliver(async (instance) => {
        if (typeof instance.alarm !== "function") throw new TypeError("This Durable Object class has no alarm handler.");
        await instance.alarm({ retryCount, isRetry: retryCount > 0 });
      });
      this.#alarmRetries = 0;
    } catch (error) {
      this.#engine.log(`alarm for ${this.#namespace.className} ${this.id} failed: ${error?.stack ?? error}`);
      if (retryCount + 1 > ALARM_RETRY_LIMIT) {
        this.#alarmRetries = 0;
        return;
      }
      this.#alarmRetries = retryCount + 1;
      if (this.#database.meta("alarm") === null) {
        const at = Date.now() + ALARM_RETRY_BASE_MS * 2 ** retryCount;
        this.#database.setMeta("alarm", at);
        this.scheduleAlarm(at);
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

  close() {
    if (this.#closed) return;
    this.#closed = true;
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

  // Drops the instance after the idle period. Hibernatable sockets and a
  // pending alarm stay with the host; a fully idle host also closes its
  // database and leaves memory.
  #maybeIdle() {
    clearTimeout(this.#idleTimer);
    const idleMs = this.#engine.idleEvictMs;
    if (!idleMs || this.#closed || !this.#instance) return;
    if (this.#running > 0 || this.#queue.length > 0 || this.#gates.size > 0 || this.#pinned.size > 0) return;
    this.#idleTimer = setTimeout(() => this.#evict(), idleMs);
    this.#idleTimer.unref?.();
  }

  #evict() {
    if (this.#running > 0 || this.#queue.length > 0 || this.#gates.size > 0 || this.#pinned.size > 0) return;
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
      event.resolve(await currentHost.run(this, () => event.run(instance)));
    } catch (error) {
      event.reject(error);
    } finally {
      this.#running -= 1;
      this.#maybeIdle();
    }
  }

  #ensureInstance() {
    if (this.#instance) return this.#instance;
    const storage = new DurableObjectStorage(this.#database, {
      onAlarmChange: (at) => this.scheduleAlarm(at),
      holdInputGate: (promise) => this.holdInputGate(promise),
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
    Promise.resolve(promise).catch(() => {});
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
    this.#db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS alarms (class TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (class, id)) WITHOUT ROWID");
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
