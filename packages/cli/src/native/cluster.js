// Several native-engine nodes sharing one bucket (--node-name). Each node
// holds a lease it renews; each object has an owner record naming the node
// that runs it and an epoch that grows with every change of owner. A node
// takes over an object only when its owner's lease has expired or the owner
// released it, and records where the old owner's history ends (the cut), so
// anything a stale owner uploads afterwards is ignored by every restore.
//
// Layout under <prefix>/native/<script>/:
//   nodes/<name>.json            { name, session, addr, ttlMs, released, revoked, revokedBy }
//   owners/<class>/<id>.json     { node, session, epoch, history: [{ epoch, from, upTo }] }
//   alarms/<class>/<id>.json     { at }   (so another node can run a dead node's alarms)
// See docs/design/multi-node.md.
import { randomBytes } from "node:crypto";
import { isClassName } from "./ids.js";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Safety margin for clock skew and pauses: a quarter of the lease, at most 2 s.
const margin = (ttlMs) => Math.min(2_000, Math.floor(ttlMs / 4));

export class OwnedElsewhere extends Error {
  constructor(className, id, node, addr) {
    super(`${className} ${id} is running on node ${node}; this node does not forward calls yet.`);
    this.name = "OwnedElsewhere";
    this.node = node;
    this.addr = addr;
  }
}

export class Cluster {
  #client;
  #root;
  #ttlMs;
  #log;
  #onFence;
  #leaseEtag = null;
  #lastRenew = null;
  #renewTimer;
  #observed = new Map();
  #stopped = false;
  fenced = false;

  // name must be unique per node and stable across its restarts.
  constructor({ client, prefix, scriptName, name, addr = null, ttlMs = 10_000, log = () => {}, onFence = () => {} }) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name ?? "")) throw new Error("The node name must be 1-64 letters, digits, '.', '_' or '-'.");
    this.#client = client;
    this.#root = [prefix, "native", scriptName].filter(Boolean).join("/");
    this.name = name;
    this.session = randomBytes(6).toString("hex");
    this.addr = addr;
    this.#ttlMs = ttlMs;
    this.#log = log;
    this.#onFence = onFence;
  }

  get ttlMs() {
    return this.#ttlMs;
  }

  // ---- this node's lease ----------------------------------------------------

  // Takes this node's lease. Another session holding the name (a previous
  // incarnation, or a second process by mistake) must release it, be
  // revoked, or go stale first: two processes never hold the name at once.
  async start() {
    const key = this.#nodeKey(this.name);
    let warned = false;
    for (;;) {
      const current = await this.#client.get(key);
      const body = current ? JSON.parse(current.body.toString("utf8")) : null;
      if (body && body.session !== this.session && !(await this.#leaseGone(this.name, current))) {
        if (!warned || Date.now() - warned > 60_000) this.#log(`Waiting for node name ${this.name} to be free: another process holds its lease.`);
        if (!warned || Date.now() - warned > 60_000) warned = Date.now();
        await sleep(Math.max(100, Math.floor(this.#ttlMs / 4)));
        continue;
      }
      const sent = { mono: performance.now(), wall: Date.now() };
      const etag = await this.#client.put(key, JSON.stringify(this.#leaseBody()), current ? { ifMatch: current.etag } : { ifNoneMatch: "*" });
      if (etag !== null) {
        this.#leaseEtag = etag;
        this.#lastRenew = sent;
        break;
      }
    }
    this.#renewTimer = setInterval(() => void this.#renew(), Math.max(200, Math.floor(this.#ttlMs / 3)));
    this.#renewTimer.unref?.();
  }

  #leaseBody(released = false) {
    return { name: this.name, session: this.session, addr: this.addr, ttlMs: this.#ttlMs, released };
  }

  #renewing = false;

  async #renew() {
    if (this.#stopped || this.fenced) return;
    // Checked even while a renewal hangs, so a stuck request can't delay the fence.
    if (!this.alive()) return this.#fence("the lease could not be renewed in time");
    if (this.#renewing) return;
    this.#renewing = true;
    const sent = { mono: performance.now(), wall: Date.now() };
    const key = this.#nodeKey(this.name);
    try {
      // A renewal that takes a third of the lease is given up (it may still
      // land; the next one then sees a new etag and checks whose it is).
      const etag = await withTimeout(this.#client.put(key, JSON.stringify(this.#leaseBody()), { ifMatch: this.#leaseEtag }), Math.floor(this.#ttlMs / 3));
      if (etag !== null) {
        this.#leaseEtag = etag;
        this.#lastRenew = sent;
        return;
      }
      // The lease changed under us: still ours (an earlier write landed late), or taken.
      const current = await this.#client.get(key);
      const body = current ? JSON.parse(current.body.toString("utf8")) : null;
      if (body && body.session === this.session && !body.revoked && !body.released) {
        this.#leaseEtag = current.etag;
        return;
      }
      this.#fence(body?.revoked ? `node ${body.revokedBy} took over this node's objects` : "another process took this node's lease (is the node name in use twice?)");
    } catch (error) {
      this.#log(`lease renewal failed: ${error.message}`);
      if (!this.alive()) this.#fence("the lease could not be renewed in time");
    } finally {
      this.#renewing = false;
    }
  }

  // Whether this node may still act as the owner of its objects: its last
  // successful renewal was sent less than a TTL (minus a margin) ago, by both
  // the monotonic clock and the wall clock (which keeps running while a VM is
  // suspended).
  alive() {
    if (this.fenced || this.#stopped || !this.#lastRenew) return false;
    const limit = this.#ttlMs - margin(this.#ttlMs);
    return performance.now() - this.#lastRenew.mono < limit && Date.now() - this.#lastRenew.wall < limit;
  }

  #fence(reason) {
    if (this.fenced) return;
    this.fenced = true;
    clearInterval(this.#renewTimer);
    this.#log(`This node stopped serving its objects: ${reason}.`);
    this.#onFence(reason);
  }

  // Whether a lease (as last read) is no longer held: released, revoked, or
  // unchanged for a TTL plus a margin by this node's own monotonic clock.
  // No other node's clock is trusted.
  async #leaseGone(name, object) {
    if (!object) return true;
    const body = JSON.parse(object.body.toString("utf8"));
    if (body.released || body.revoked) return true;
    const seen = this.#observed.get(name);
    if (!seen || seen.etag !== object.etag) {
      this.#observed.set(name, { etag: object.etag, at: performance.now() });
      return false;
    }
    const ttl = body.ttlMs ?? this.#ttlMs;
    return performance.now() - seen.at > ttl + margin(ttl);
  }

  // ---- owners ---------------------------------------------------------------

  // Makes this node the owner of an object. prepare({ previous, cut }) runs
  // once the record is ours and before it is returned: it restores the object
  // up to `cut` when the owner changed. cutFor(record) computes where the
  // previous owner's history ends. Throws OwnedElsewhere if a live node owns it.
  async acquire(className, id, { cutFor }) {
    const key = this.#ownerKey(className, id);
    for (;;) {
      if (!this.alive()) throw new Error("This node has no valid lease.");
      const current = await this.#client.get(key);
      const record = current ? JSON.parse(current.body.toString("utf8")) : null;
      if (record && record.node === this.name && record.session === this.session) return { record, changed: false };
      if (record && record.node && !(await this.#ownerGone(record))) {
        const lease = await this.#readLease(record.node);
        throw new OwnedElsewhere(className, id, record.node, lease?.addr ?? null);
      }
      // New, released, or its owner's lease ran out (or it was this node before a restart).
      // An object without a record may still have history from a single node
      // (epoch 0, durable mode without --node-name): it is kept.
      const base = record ?? { epoch: 0, history: [{ epoch: 0, from: 0 }] };
      const cut = await cutFor(base);
      const epoch = base.epoch + 1;
      const history = [...base.history.map((range) => (range.upTo === undefined || range.upTo === null ? { ...range, upTo: cut } : range)), { epoch, from: cut }];
      const next = { node: this.name, session: this.session, epoch, history };
      const etag = await this.#client.put(key, JSON.stringify(next), current ? { ifMatch: current.etag } : { ifNoneMatch: "*" });
      if (etag !== null) return { record: next, previous: record, cut, changed: true, etag };
    }
  }

  // Hands an object back on a clean shutdown, so another node takes it at once.
  async release(className, id, record, cut) {
    if (this.fenced) return;
    const from = record.history.at(-1).from;
    if (cut < from) throw new Error(`refusing to release ${className} ${id} at ${cut}, before its epoch began (${from})`);
    const key = this.#ownerKey(className, id);
    const current = await this.#client.get(key);
    if (!current) return;
    const live = JSON.parse(current.body.toString("utf8"));
    if (live.node !== this.name || live.session !== this.session || live.epoch !== record.epoch) return;
    const history = live.history.map((range) => (range.epoch === record.epoch ? { ...range, upTo: cut } : range));
    await this.#client.put(key, JSON.stringify({ node: "", session: "", epoch: live.epoch, history }), { ifMatch: current.etag });
  }

  // Whether an object's owner is gone. A stale lease is revoked (a
  // conditional write), so the old node's next renewal fails and it fences
  // itself instead of running on.
  async #ownerGone(record) {
    // This node's name: start() waited for any earlier session to be gone.
    if (record.node === this.name) return true;
    const key = this.#nodeKey(record.node);
    const object = await this.#client.get(key);
    if (!object) return true;
    const body = JSON.parse(object.body.toString("utf8"));
    // The node restarted under a new session, which waited for the old one to be gone.
    if (body.session !== record.session) return true;
    if (!(await this.#leaseGone(record.node, object))) return false;
    if (body.released || body.revoked) return true;
    const revoked = await this.#client.put(key, JSON.stringify({ ...body, revoked: true, revokedBy: this.name }), { ifMatch: object.etag });
    return revoked !== null;
  }

  async #readLease(name, withEtag = false) {
    const object = await this.#client.get(this.#nodeKey(name));
    if (!object) return null;
    const body = JSON.parse(object.body.toString("utf8"));
    return withEtag ? { body, etag: object.etag } : body;
  }

  // ---- alarms ---------------------------------------------------------------

  async setAlarm(className, id, at) {
    const key = `${this.#root}/alarms/${className}/${id}.json`;
    if (at === null) await this.#client.delete(key);
    else await this.#client.put(key, JSON.stringify({ at }));
  }

  // Alarms due within `aheadMs` whose objects aren't running here.
  async dueAlarms(aheadMs = 5_000) {
    const due = [];
    for (const { key } of await this.#client.list(`${this.#root}/alarms/`)) {
      const match = /alarms\/([^/]+)\/([0-9a-f]{64})\.json$/.exec(key);
      if (!match || !isClassName(match[1])) continue;
      const object = await this.#client.get(key);
      if (!object) continue;
      const { at } = JSON.parse(object.body.toString("utf8"));
      if (at <= Date.now() + aheadMs) due.push({ className: match[1], id: match[2], at });
    }
    return due;
  }

  async stop() {
    if (this.#stopped) return;
    clearInterval(this.#renewTimer);
    if (!this.fenced && this.#leaseEtag) {
      await this.#client.put(this.#nodeKey(this.name), JSON.stringify(this.#leaseBody(true)), { ifMatch: this.#leaseEtag }).catch(() => {});
    }
    this.#stopped = true;
  }

  #nodeKey(name) {
    return `${this.#root}/nodes/${name}.json`;
  }

  #ownerKey(className, id) {
    return `${this.#root}/owners/${className}/${id}.json`;
  }
}

// Whether a logged transaction (epoch, txid) belongs to an object's history:
// within its epoch's range (from, upTo]. A snapshot may also sit at `from`,
// the epoch's base. Without a history (one node), everything belongs.
export function inHistory(history, epoch, txid, { snapshot = false } = {}) {
  if (!history) return true;
  const range = history.find((candidate) => candidate.epoch === epoch);
  if (!range) return false;
  const afterFrom = snapshot ? txid >= range.from : txid > range.from;
  return afterFrom && (range.upTo === undefined || range.upTo === null || txid <= range.upTo);
}
