// Durable writes for the native engine (--backup-mode durable). After each
// event the engine captures the transactions the object committed (from its
// SQLite WAL) and holds the event's result until they are in the bucket: an
// output gate, as on Cloudflare. Transactions from every object on this
// thread are uploaded together, one segment per flush, so a busy node makes
// few, larger uploads. Each object also gets exact-page snapshots, and a disk
// that lost an object rebuilds it from its latest snapshot plus the later
// transactions in the log.
//
// Layout under <prefix>/native/<script>/:
//   objects/<class>/<id>/snapshot-<txid>-e<epoch>.sqlite   the database file at txid
//     (snapshot-<txid>.sqlite from before epochs counts as epoch 0)
//   log/<writer>/<session>/<seq>.seg              gzipped transactions of many objects
//
// Invariants:
// - An object's transactions are numbered 1, 2, 3, ... with no reuse: numbering
//   continues from the highest txid this node or the bucket has seen.
// - A segment key is written once, with one body. Segments of a writer land in
//   order: a later one is not uploaded until the earlier one is in the bucket.
// - Object databases run with synchronous = FULL, so a transaction that was
//   captured is on disk; at start, a WAL that no longer reaches the recorded
//   position marks the local copy as untrusted, and it is restored from the bucket.
// - A segment is deleted only once every transaction in it is covered by a
//   snapshot that is older than the retention window (tuning.retentionMs), and
//   a snapshot only once a newer one of the same epoch is; inside the window,
//   any transaction can be restored (point-in-time recovery).
// - Restoring an object to an earlier transaction rebuilds it and uploads it
//   as a snapshot under a new, higher txid: later history is superseded, not
//   deleted, so it can be restored in turn.
// Single node only for now: a second node writing the same prefix is not
// detected yet (docs/design/multi-node.md).
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { inHistory } from "./cluster.js";
import { isClassName, isObjectId } from "./ids.js";
import { WalReader, applyTransactions } from "./wal.js";

const SEGMENT_FORMAT = 1;
const SNAPSHOT_RE = /objects\/([^/]+)\/([0-9a-f]{64})\/snapshot-(\d+)(?:-e(\d+))?\.sqlite$/;
const DEFAULTS = {
  // How long a write waits for the bucket before its event fails.
  gateTimeoutMs: 30_000,
  // A snapshot after this many transactions or log bytes since the last one.
  snapshotTransactions: 2_000,
  snapshotLogBytes: 16 * 1024 * 1024,
  // The engine checkpoints a WAL itself once it is this big and fully shipped.
  checkpointWalBytes: 4 * 1024 * 1024,
  compactIntervalMs: 10 * 60_000,
  // How long close() waits for the bucket before leaving writes to the next start.
  closeTimeoutMs: 30_000,
  // How far back point-in-time recovery reaches (0: only the latest state is kept).
  retentionMs: 0,
};
const pad = (value) => String(value).padStart(12, "0");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// Per-object progress, kept beside the objects (shared by engine threads;
// each object's row is written only by the thread that owns it).
export class UnsafeStore extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeStore";
  }
}

export class LogState {
  #db;

  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS objects (
        class TEXT NOT NULL, id TEXT NOT NULL,
        captured INTEGER NOT NULL DEFAULT 0, shipped INTEGER NOT NULL DEFAULT 0, snapshot INTEGER NOT NULL DEFAULT 0,
        log_bytes INTEGER NOT NULL DEFAULT 0, position TEXT, needs_snapshot INTEGER NOT NULL DEFAULT 0,
        epoch INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (class, id)) WITHOUT ROWID`);
    const columns = this.#db.prepare("PRAGMA table_info(objects)").all().map((column) => column.name);
    if (!columns.includes("epoch")) this.#db.exec("ALTER TABLE objects ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0");
    // A transaction to restore the object to when it next opens (onNextSessionRestoreBookmark).
    if (!columns.includes("restore_to")) this.#db.exec("ALTER TABLE objects ADD COLUMN restore_to INTEGER");
  }

  get(className, id) {
    return this.#db.prepare("SELECT * FROM objects WHERE class = ? AND id = ?").get(className, id) ?? null;
  }

  set(row) {
    this.#db.prepare(`INSERT INTO objects (class, id, captured, shipped, snapshot, log_bytes, position, needs_snapshot, epoch, restore_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (class, id) DO UPDATE SET captured = excluded.captured, shipped = excluded.shipped, snapshot = excluded.snapshot,
      log_bytes = excluded.log_bytes, position = excluded.position, needs_snapshot = excluded.needs_snapshot, epoch = excluded.epoch, restore_to = excluded.restore_to`)
      .run(row.class, row.id, row.captured, row.shipped, row.snapshot, row.log_bytes, row.position, row.needs_snapshot ? 1 : 0, row.epoch ?? 0, row.restore_to ?? null);
  }

  all() {
    return this.#db.prepare("SELECT * FROM objects").all();
  }

  close() {
    this.#db.close();
  }
}

export class DurableLog {
  #client;
  #root;
  #writer;
  #session = randomBytes(8).toString("hex");
  #seq = 0;
  #state;
  #rows = new Map();
  #objects = new Map();
  #waiters = [];
  #pending = [];
  #inflight = null;
  #shipping = null;
  #log;
  #timer;
  #sweeper;
  #compactTimer;
  #closed = false;
  #objectsDirectory;
  #owns;
  #tuning;
  restored = 0;
  segments = 0;

  // writer names this engine thread (stable across restarts, e.g. "t0");
  // owns(id) says which objects this thread runs (--threads); tuning
  // overrides DEFAULTS.
  #alive;
  #mayCompact;

  // alive() (with --node-name) says whether this node still holds its lease;
  // mayCompact(row) whether it may snapshot an object and drop its log.
  constructor({ client, prefix, scriptName, writer = "t0", statePath, objectsDirectory, owns = () => true, alive = () => true, mayCompact = () => true, tuning = {}, log = () => {} }) {
    this.#alive = alive;
    this.#mayCompact = mayCompact;
    if (typeof new DatabaseSync(":memory:").isTransaction !== "boolean") throw new Error("Durable mode needs Node.js 22.16 or newer.");
    this.#tuning = { ...DEFAULTS, ...tuning };
    this.#client = client;
    this.#objectsDirectory = objectsDirectory;
    this.#owns = owns;
    this.#root = [prefix, "native", scriptName].filter(Boolean).join("/");
    this.#writer = writer;
    this.#state = new LogState(statePath);
    this.#log = log;
  }

  #row(className, id) {
    const key = `${className}/${id}`;
    let row = this.#rows.get(key);
    if (!row) {
      row = this.#state.get(className, id) ?? { class: className, id, captured: 0, shipped: 0, snapshot: 0, log_bytes: 0, position: null, needs_snapshot: 0, epoch: 0, restore_to: null };
      this.#rows.set(key, row);
    }
    return row;
  }

  #save(row) {
    this.#state.set(row);
  }

  // ---- start: check the store, check local copies, restore what's missing ----

  // Durable mode and several nodes rely on the store refusing a conditional
  // write that doesn't hold. Some S3-compatible stores ignore the conditions
  // and accept everything, which would silently break both: refuse to run on them.
  async probeConditionalWrites() {
    const key = `${this.#root}/probe/${randomBytes(8).toString("hex")}`;
    const fail = (what) => {
      throw new UnsafeStore(`The bucket doesn't honor conditional writes (${what}); --backup-mode durable and --node-name need a store that does, such as AWS S3, Cloudflare R2 or SeaweedFS.`);
    };
    try {
      const first = await this.#client.put(key, "1", { ifNoneMatch: "*" });
      if (first === null) fail("a create of a new key was refused");
      if ((await this.#client.put(key, "2", { ifNoneMatch: "*" })) !== null) fail("If-None-Match: * replaced an existing key");
      const second = await this.#client.put(key, "3", { ifMatch: first });
      if (second === null) fail("If-Match with the current ETag was refused");
      if ((await this.#client.put(key, "4", { ifMatch: first })) !== null) fail("If-Match with a stale ETag was accepted");
    } finally {
      await this.#client.delete(key).catch(() => {});
    }
  }


  // Restores every object this thread owns that is missing locally, or whose
  // local copy can't be trusted, from its latest snapshot plus the log.
  async restore(objectsDirectory, alarmIndex, owns = () => true) {
    const local = (className, id) => join(objectsDirectory, className, `${id}.sqlite`);
    // A copy whose WAL lost transactions the engine already captured (power
    // loss) is behind the bucket: drop it so the bucket's copy is used.
    for (const row of this.#state.all()) {
      if (!owns(row.id) || !row.position) continue;
      const path = local(row.class, row.id);
      if (!existsSync(path) || walReaches(`${path}-wal`, JSON.parse(row.position))) continue;
      // A database closed cleanly (as when a crashed engine thread is torn
      // down) has its WAL checkpointed into the file and removed: the file
      // holds everything it committed, including writes the log may not have
      // captured, so it is kept and snapshotted before anything is acknowledged.
      if (closedCleanly(path)) {
        Object.assign(this.#row(row.class, row.id), { position: null, needs_snapshot: 1 });
        this.#save(this.#row(row.class, row.id));
        continue;
      }
      this.#log(`${row.class} ${row.id}: the local copy lost transactions it had written; restoring it from the bucket.`);
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }

    const snapshots = new Map();
    const highest = new Map();
    const seen = (objectKey, txid) => highest.set(objectKey, Math.max(highest.get(objectKey) ?? 0, txid));
    for (const { key } of await this.#client.list(`${this.#root}/objects/`)) {
      const match = SNAPSHOT_RE.exec(key);
      // The class becomes a directory under objectsDirectory: never "..".
      if (!match || !isClassName(match[1]) || !owns(match[2])) continue;
      const objectKey = `${match[1]}/${match[2]}`;
      const txid = Number(match[3]);
      seen(objectKey, txid);
      if (!snapshots.has(objectKey) || snapshots.get(objectKey).txid < txid) snapshots.set(objectKey, { key, txid });
    }
    // The log is read only if an object may need it: one missing locally,
    // unknown to this node, or with a snapshot newer than what it recorded.
    // With a retention window, the log holds days of history.
    const rows = new Map(this.#state.all().filter((row) => owns(row.id)).map((row) => [`${row.class}/${row.id}`, row]));
    const needsLog = [...snapshots.keys()].some((objectKey) => !rows.has(objectKey))
      || [...rows].some(([objectKey, row]) => !existsSync(local(row.class, row.id)) || (highest.get(objectKey) ?? 0) > row.captured);
    const entries = new Map();
    if (needsLog) {
      for (const { key, lastModified } of await this.#client.list(`${this.#root}/log/`)) {
        if (!key.endsWith(".seg")) continue;
        for (const entry of await this.#indexSegment(key, lastModified)) {
          if (!owns(entry.id)) continue;
          const objectKey = `${entry.class}/${entry.id}`;
          seen(objectKey, entry.txid);
          if (!entries.has(objectKey)) entries.set(objectKey, new Map());
          if (!entries.get(objectKey).has(entry.txid)) entries.get(objectKey).set(entry.txid, entry);
        }
      }
    }

    for (const objectKey of new Set([...snapshots.keys(), ...entries.keys(), ...this.#state.all().filter((row) => owns(row.id)).map((row) => `${row.class}/${row.id}`)])) {
      const [className, id] = objectKey.split("/");
      const path = local(className, id);
      const top = highest.get(objectKey) ?? 0;
      const row = this.#row(className, id);
      if (existsSync(path)) {
        // Numbering continues past everything the bucket has, and an object
        // the state doesn't know (for example, one written in interval mode)
        // gets a snapshot to start its history from.
        const known = this.#state.get(className, id) !== null;
        if (known && top <= row.captured) continue;
        if (top === 0) {
          // An object this mode hasn't seen (for example, from interval mode): its file is the base.
          Object.assign(row, { captured: 0, shipped: 0, needs_snapshot: 1, position: null });
          this.#save(row);
          continue;
        }
        // The bucket has history this node didn't record: its copy wins.
        this.#log(`${objectKey}: the bucket has transactions up to ${top} but this node recorded ${known ? row.captured : "none"}; restoring from the bucket.`);
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      }
      if (top === 0) continue;
      const snapshot = snapshots.get(objectKey);
      const transactions = [...(entries.get(objectKey) ?? new Map()).values()].filter((entry) => entry.txid > (snapshot?.txid ?? 0)).sort((a, b) => a.txid - b.txid);
      let txid = snapshot?.txid ?? 0;
      const usable = [];
      for (const entry of transactions) {
        if (entry.txid !== txid + 1) {
          this.#log(`restore of ${objectKey}: transactions after ${txid} are missing from the log; restoring up to ${txid}.`);
          break;
        }
        usable.push(entry);
        txid = entry.txid;
      }
      const { temporary, alarm } = await this.#build(path, snapshot ? (await this.#client.get(snapshot.key)).body : null, await this.#withPages(usable), objectKey);
      // Recorded before the file is in place: a crash in between restores again.
      // Numbering continues past everything seen; a snapshot of what was
      // restored then becomes the base for what follows.
      Object.assign(row, { captured: top, shipped: top, snapshot: snapshot?.txid ?? 0, log_bytes: 0, position: null, needs_snapshot: txid === (snapshot?.txid ?? 0) && txid === top ? 0 : 1 });
      this.#save(row);
      renameSync(temporary, path);
      fsyncPath(dirname(path));
      if (alarm !== null) alarmIndex.set(className, id, Number(alarm));
      this.restored += 1;
    }
  }

  // ---- takeover (--node-name) ------------------------------------------------

  // Segments are written once, so what each holds (which transactions of
  // which objects, and when) is kept after its first download. Pages are
  // fetched again only for the transactions a rebuild needs.
  #segmentIndex = new Map();

  // An object's snapshots and logged transactions (index records: txid,
  // epoch, at, segment) in the bucket that belong to its history (owner
  // record), across every writer.
  async #objectHistory(className, id, history) {
    const snapshots = [];
    for (const { key, lastModified } of await this.#client.list(`${this.#root}/objects/${className}/${id}/`)) {
      const match = SNAPSHOT_RE.exec(key);
      if (!match) continue;
      const txid = Number(match[3]);
      const epoch = Number(match[4] ?? 0);
      if (inHistory(history, epoch, txid, { snapshot: true })) snapshots.push({ key, txid, epoch, time: Date.parse(lastModified ?? "") || undefined });
    }
    const entries = new Map();
    const listed = (await this.#client.list(`${this.#root}/log/`)).filter(({ key }) => key.endsWith(".seg"));
    const keys = new Set(listed.map(({ key }) => key));
    for (const key of [...this.#segmentIndex.keys()]) if (!keys.has(key)) this.#segmentIndex.delete(key);
    for (const { key, lastModified } of listed) {
      for (const entry of await this.#indexSegment(key, lastModified)) {
        if (entry.class !== className || entry.id !== id || !inHistory(history, entry.epoch, entry.txid)) continue;
        if (!entries.has(entry.txid)) entries.set(entry.txid, entry);
      }
    }
    snapshots.sort((a, b) => b.txid - a.txid);
    return { snapshots, entries };
  }

  // What a segment holds, without its pages (empty if it is gone).
  async #indexSegment(key, lastModified) {
    let index = this.#segmentIndex.get(key);
    if (!index) {
      const object = await this.#client.get(key);
      if (!object) return [];
      // Entries from before capture times were recorded date from their upload.
      const uploaded = Date.parse(lastModified ?? "") || undefined;
      // Class and id name a local file on restore, so entries with anything
      // else (a bucket written by something other than this engine) are skipped.
      index = decodeSegment(object.body)
        .filter((entry) => isClassName(entry.class) && isObjectId(entry.id))
        .map((entry) => ({ class: entry.class, id: entry.id, epoch: entry.epoch ?? 0, txid: entry.txid, at: entry.at ?? uploaded, segment: key }));
      this.#segmentIndex.set(key, index);
    }
    return index;
  }

  // The full transactions (with pages) for index records, in order.
  async #withPages(records) {
    const segments = new Map();
    for (const record of records) {
      if (!segments.has(record.segment)) {
        const object = await this.#client.get(record.segment);
        if (!object) throw new Error(`log segment ${record.segment} is no longer in the bucket`);
        segments.set(record.segment, decodeSegment(object.body));
      }
    }
    return records.map((record) => {
      const entry = segments.get(record.segment).find((candidate) => candidate.class === record.class && candidate.id === record.id && candidate.txid === record.txid && (candidate.epoch ?? 0) === record.epoch);
      if (!entry) throw new Error(`transaction ${record.txid} is missing from ${record.segment}`);
      return entry;
    });
  }

  // Where an object's history ends in the bucket: the range a clean release
  // recorded, or the last contiguous transaction after its latest snapshot.
  async cutFor(className, id, record) {
    const last = record.history?.at(-1);
    if (last && last.upTo !== undefined && last.upTo !== null) return last.upTo;
    const { snapshots, entries } = await this.#objectHistory(className, id, record.history);
    let txid = snapshots[0]?.txid ?? 0;
    while (entries.has(txid + 1)) txid += 1;
    return txid;
  }

  // Runs before a newly owned object opens: reuses the local copy when it is
  // exactly the bucket's up to the cut, and otherwise rebuilds it from the
  // bucket. The object then starts its epoch from a fresh snapshot.
  async prepareObject(className, id, { record, cut, alarmIndex }) {
    const path = join(this.#objectsDirectory, className, `${id}.sqlite`);
    const row = this.#row(className, id);
    const previous = record.history.at(-2);
    const reusable = existsSync(path) && previous && row.epoch === previous.epoch && row.captured === cut && row.shipped === cut
      && (!row.position || walReaches(`${path}-wal`, JSON.parse(row.position)));
    if (!reusable) {
      // Nothing local is removed until the bucket's copy is complete.
      const { snapshots, entries } = await this.#objectHistory(className, id, record.history);
      const snapshot = snapshots.find((candidate) => candidate.txid <= cut);
      const records = [];
      for (let txid = (snapshot?.txid ?? 0) + 1; txid <= cut; txid += 1) {
        const entry = entries.get(txid);
        if (!entry) throw new Error(`${className} ${id}: transaction ${txid} is missing from the bucket; refusing to take the object over.`);
        records.push(entry);
      }
      const usable = await this.#withPages(records);
      if (snapshot || usable.length > 0) {
        const alarm = await this.#rebuild(path, snapshot ? (await this.#client.get(snapshot.key)).body : null, usable, `${className}/${id}`);
        if (alarm !== null) alarmIndex.set(className, id, Number(alarm));
      } else {
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      }
      Object.assign(row, { snapshot: snapshot?.txid ?? 0 });
    }
    // A restore requested in an earlier ownership carries over only if no
    // other node wrote since (the history ends where this node's did).
    const keepRestore = previous && row.epoch === previous.epoch && cut <= row.captured;
    Object.assign(row, { captured: cut, shipped: cut, log_bytes: 0, position: reusable ? row.position : null, needs_snapshot: 1, epoch: record.epoch, restore_to: keepRestore ? row.restore_to : null });
    this.#save(row);
  }

  // Writes snapshot + transactions to a fresh file at path (fsynced, checked)
  // and returns the object's pending alarm, if any.
  async #rebuild(path, snapshotBody, transactions, label) {
    const { temporary, alarm } = await this.#build(path, snapshotBody, transactions, label);
    install(path, temporary);
    return alarm;
  }

  // Writes snapshot + transactions to a temporary file beside path (fsynced,
  // checked); returns it and the restored state's pending alarm, if any.
  async #build(path, snapshotBody, transactions, label) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.restore`;
    rmSync(temporary, { force: true });
    if (snapshotBody) writeFileSync(temporary, snapshotBody);
    applyTransactions(temporary, transactions);
    const db = new DatabaseSync(temporary);
    let alarm = null;
    try {
      const integrity = db.prepare("PRAGMA quick_check").get().quick_check;
      if (integrity !== "ok") throw new Error(`restored ${label} failed its integrity check: ${integrity}`);
      // An empty database (restored to before its first write) has no metadata yet.
      const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_cf_METADATA'").get() !== undefined;
      const meta = (key) => (hasMeta ? db.prepare("SELECT value FROM _cf_METADATA WHERE key = ?").get(key)?.value ?? null : null);
      alarm = meta("alarm") ?? meta("alarm_running");
    } finally {
      db.close();
    }
    fsyncPath(temporary);
    return { temporary, alarm };
  }

  // The epoch this node's copy of an object belongs to.
  epochOf(className, id) {
    return this.#row(className, id).epoch ?? 0;
  }

  // An object's captured and shipped transaction numbers on this node.
  progress(className, id) {
    const row = this.#rows.get(`${className}/${id}`);
    return row ? { captured: row.captured, shipped: row.shipped } : null;
  }

  // ---- point-in-time recovery ---------------------------------------------

  // A bookmark names a transaction of one object: its txid (16 hex digits,
  // so bookmarks sort by time) and a digest of the object.
  #bookmark(className, id, txid) {
    return `${txid.toString(16).padStart(16, "0")}-${createHash("sha256").update(`${className}/${id}`).digest("hex").slice(0, 16)}`;
  }

  #parseBookmark(className, id, bookmark) {
    const match = /^([0-9a-f]{16})-([0-9a-f]{16})$/.exec(String(bookmark));
    if (!match || this.#bookmark(className, id, 0).slice(17) !== match[2]) throw new TypeError("Invalid bookmark: it isn't one of this object's.");
    return Number.parseInt(match[1], 16);
  }

  // The bookmark of the object's latest write, including writes made so far
  // in the current event.
  currentBookmark(host) {
    const object = this.#objects.get(host);
    if (object) this.#capture(object);
    const { className, id } = host.backupSource();
    return this.#bookmark(className, id, this.#row(className, id).captured);
  }

  // The bookmark of the object's state at time (ms): its last transaction
  // captured at or before then. history: the owner record's (several nodes).
  async bookmarkForTime(host, time, history) {
    const { className, id } = host.backupSource();
    const current = this.currentBookmark(host);
    if (time >= Date.now()) return current;
    const { snapshots, entries } = await this.#objectHistory(className, id, history);
    for (const { entry } of this.#queued(className, id)) if (!entries.has(entry.txid)) entries.set(entry.txid, entry);
    const times = new Map();
    for (const entry of entries.values()) if (entry.at !== undefined) times.set(entry.txid, entry.at);
    for (const snapshot of snapshots) if (snapshot.time !== undefined) times.set(snapshot.txid, Math.min(times.get(snapshot.txid) ?? Infinity, snapshot.time));
    let target = -1;
    for (const [txid, at] of times) if (at <= time && txid > target) target = txid;
    // Before its first transaction, the object was empty.
    if (target === -1 && entries.has(1) && (entries.get(1).at ?? Infinity) > time) target = 0;
    if (target === -1 || !restorable(target, snapshots, entries)) {
      throw new RangeError(`No bookmark for ${new Date(time).toISOString()}: that is older than the history the bucket keeps for this object.`);
    }
    return this.#bookmark(className, id, target);
  }

  // Records that the object is restored to bookmark when it next opens, and
  // returns the bookmark of its current state (to undo the restore).
  async requestRestore(host, bookmark, history) {
    const { className, id } = host.backupSource();
    const txid = this.#parseBookmark(className, id, bookmark);
    const current = this.currentBookmark(host);
    const row = this.#row(className, id);
    if (txid > row.captured) throw new RangeError("Invalid bookmark: it is newer than the object's latest write.");
    const { snapshots, entries } = await this.#objectHistory(className, id, history);
    for (const { entry } of this.#queued(className, id)) if (!entries.has(entry.txid)) entries.set(entry.txid, entry);
    if (!restorable(txid, snapshots, entries)) throw new RangeError("That bookmark is older than the history the bucket keeps for this object.");
    row.restore_to = txid;
    this.#save(row);
    return current;
  }

  // An object's transactions captured here and not yet in the bucket.
  #queued(className, id) {
    return [...(this.#inflight?.items ?? []), ...this.#pending].filter(({ entry }) => entry.class === className && entry.id === id);
  }

  restorePending(className, id) {
    const restoreTo = this.#row(className, id).restore_to;
    return restoreTo !== null && restoreTo !== undefined;
  }

  // Before the object opens: rebuilds it at the requested transaction from
  // the bucket, then uploads that state as a snapshot with a new txid above
  // everything seen, so it becomes the object's latest state everywhere.
  // Only then does the rebuilt file replace the local copy.
  async restorePoint(className, id, { history, alarmIndex }) {
    const row = this.#row(className, id);
    const target = row.restore_to;
    // Its queued writes reach the bucket first. (Ones lost in a crash were
    // never acknowledged.)
    const deadline = Date.now() + this.#tuning.gateTimeoutMs;
    while (this.#queued(className, id).length > 0) {
      if (this.#closed || Date.now() > deadline) throw new Error(`${className} ${id}: its writes did not reach the bucket, so it can't be restored yet.`);
      await this.#ship();
      if (this.#queued(className, id).length > 0) await sleep(100);
    }
    const { snapshots, entries } = await this.#objectHistory(className, id, history);
    if (!restorable(target, snapshots, entries)) {
      // Its history left the bucket (retention): the object opens as it is.
      // An earlier attempt may have left its snapshot above the object's
      // latest transaction: numbering continues past it, and a snapshot of
      // the current state comes first.
      this.#log(`${className} ${id}: transaction ${target} can no longer be restored from the bucket; the restore is dropped.`);
      let top = row.captured;
      for (const candidate of snapshots) top = Math.max(top, candidate.txid);
      if (top > row.captured) Object.assign(row, { captured: top, needs_snapshot: 1 });
      row.restore_to = null;
      this.#save(row);
      return;
    }
    const snapshot = snapshots.find((candidate) => candidate.txid <= target);
    const records = [];
    for (let txid = (snapshot?.txid ?? 0) + 1; txid <= target; txid += 1) records.push(entries.get(txid));
    const path = join(this.#objectsDirectory, className, `${id}.sqlite`);
    const { temporary, alarm } = await this.#build(path, snapshot ? (await this.#client.get(snapshot.key)).body : null, await this.#withPages(records), `${className}/${id}`);
    let txid = row.captured;
    for (const candidate of snapshots) txid = Math.max(txid, candidate.txid);
    for (const candidate of entries.keys()) txid = Math.max(txid, candidate);
    txid += 1;
    const body = readFileSync(temporary);
    try {
      while (!(await this.#putSnapshot(row, txid, body))) txid += 1;
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    // In place before it is recorded: a crash in between restores again.
    install(path, temporary);
    // An empty file gets its schema when it opens: a snapshot follows then.
    Object.assign(row, { captured: txid, shipped: txid, snapshot: txid, log_bytes: 0, position: null, needs_snapshot: body.length === 0 ? 1 : 0, restore_to: null });
    this.#save(row);
    alarmIndex?.set(className, id, alarm === null ? null : Number(alarm));
    this.#log(`${className} ${id}: restored to transaction ${target}.`);
  }

  // Objects whose restore was requested before the engine stopped.
  pendingRestores() {
    return this.#state.all().filter((row) => row.restore_to !== null && row.restore_to !== undefined && this.#owns(row.id)).map((row) => ({ className: row.class, id: row.id }));
  }

  // ---- objects -------------------------------------------------------------

  // Called when an object's database opens.
  attach(host) {
    const { className, id, database } = host.backupSource();
    const row = this.#row(className, id);
    const reader = new WalReader(`${database.path}-wal`, row.position ? JSON.parse(row.position) : null);
    // Transactions captured before a crash but never shipped may be gone from
    // the WAL (closing checkpoints it): a snapshot brings the bucket back in step.
    // An object with no record yet starts its history from a snapshot of its
    // file, so its log is never replayed onto anything else.
    if (this.#state.get(className, id) === null) {
      row.needs_snapshot = 1;
      this.#save(row);
    } else if (row.captured > row.shipped && !row.needs_snapshot) {
      this.#log(`${className} ${id}: ${row.captured - row.shipped} transaction(s) were not shipped before the engine stopped; taking a snapshot.`);
      row.needs_snapshot = 1;
      this.#save(row);
    }
    this.#objects.set(host, { host, className, id, database, reader, row });
  }

  // Called just before an object's database closes.
  detach(host) {
    const object = this.#objects.get(host);
    if (!object) return;
    this.#capture(object);
    // Closing checkpoints the WAL; the next reader starts from its top.
    object.row.position = null;
    this.#save(object.row);
    this.#objects.delete(host);
  }

  // Captures the object's new transactions. Returns a promise that resolves
  // once everything it has captured is durable, or null if it already is.
  commit(host) {
    const object = this.#objects.get(host);
    if (!object) return null;
    // Until the snapshot lands, shipped stays below captured, so waiters wait for it.
    if (object.row.needs_snapshot) return this.#snapshotNow(object).catch((error) => this.#log(`snapshot of ${object.className} ${object.id} failed: ${error.message}`)).then(() => this.#waitFor(object));
    if (!this.#capture(object)) return Promise.reject(new Error(`The write could not be captured: ${object.captureError}`));
    return this.#waitFor(object);
  }

  #waitFor(object) {
    const { row } = object;
    if (!this.#alive()) return Promise.reject(new Error("This node's lease expired; the write is not acknowledged."));
    if (row.shipped >= row.captured) return null;
    return new Promise((resolve, reject) => this.#waiters.push({ row, txid: row.captured, resolve, reject, at: Date.now() }));
  }

  // A node that may have lost its lease acknowledges nothing: another node
  // could already own its objects.
  #release() {
    const alive = this.#alive();
    this.#waiters = this.#waiters.filter((waiter) => {
      if (waiter.row.shipped < waiter.txid && alive) return true;
      if (alive) waiter.resolve();
      else waiter.reject(new Error("This node's lease expired; the write is not acknowledged."));
      return false;
    });
  }

  // Returns false if the WAL could not be read.
  #capture(object) {
    let transactions;
    try {
      transactions = object.reader.capture();
      object.captureError = undefined;
    } catch (error) {
      object.captureError = error.message;
      this.#log(`capturing ${object.className} ${object.id} failed: ${error.message}`);
      return false;
    }
    if (transactions.length === 0) return true;
    const { row } = object;
    for (const transaction of transactions) {
      row.captured += 1;
      this.#pending.push({ row, entry: { class: row.class, id: row.id, epoch: row.epoch ?? 0, txid: row.captured, at: Date.now(), ...transaction } });
    }
    row.position = JSON.stringify(object.reader.position);
    this.#save(row);
    this.#ship();
    return true;
  }

  // ---- shipping ------------------------------------------------------------

  start() {
    // Writes made outside an event (timers, waitUntil) are shipped too, without a gate.
    this.#timer = setInterval(() => {
      for (const object of this.#objects.values()) this.#capture(object);
    }, 200);
    this.#timer.unref?.();
    // Writes that wait too long fail; their transactions keep shipping.
    this.#sweeper = setInterval(() => {
      for (const object of this.#objects.values()) {
        if (object.row.needs_snapshot) void this.#snapshotNow(object).catch((error) => this.#log(`snapshot of ${object.className} ${object.id} failed: ${error.message}`));
      }
      const cutoff = Date.now() - this.#tuning.gateTimeoutMs;
      this.#waiters = this.#waiters.filter((waiter) => {
        if (waiter.at > cutoff) return true;
        waiter.reject(new Error(`The write could not be made durable within ${Math.round(this.#tuning.gateTimeoutMs / 1000)} s: ${this.#lastError ?? "the bucket did not answer"}`));
        return false;
      });
    }, Math.min(1_000, this.#tuning.gateTimeoutMs / 4));
    this.#sweeper.unref?.();
    this.#compactTimer = setInterval(() => void this.compact().catch((error) => this.#log(`log compaction failed: ${error.message}`)), this.#tuning.compactIntervalMs);
    this.#compactTimer.unref?.();
  }

  #lastError;

  #ship() {
    if (this.#shipping) return this.#shipping;
    this.#shipping = (async () => {
      try {
        while (!this.#closed || this.#inflight || this.#pending.length > 0) {
          if (!this.#inflight) {
            if (this.#pending.length === 0) break;
            const items = this.#pending.splice(0);
            this.#inflight = { key: this.#nextKey(), body: encodeSegment(items.map((item) => item.entry)), items };
          }
          if (await this.#uploadInflight()) await this.#afterUpload(this.#inflight.items).catch((error) => this.#log(`log maintenance failed: ${error.message}`));
          else if (this.#closed) break;
          else continue;
          this.#inflight = null;
        }
      } catch (error) {
        this.#log(`log shipping stopped: ${error?.stack ?? error}`);
      } finally {
        this.#shipping = null;
        if (!this.#closed && (this.#inflight || this.#pending.length > 0)) setTimeout(() => !this.#closed && this.#ship(), 1_000).unref?.();
      }
    })();
    return this.#shipping;
  }

  #nextKey() {
    return `${this.#root}/log/${this.#writer}/${this.#session}/${pad((this.#seq += 1))}.seg`;
  }

  // One attempt plus retries with back-off; true once the segment is in the bucket.
  async #uploadInflight() {
    const segment = this.#inflight;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const etag = await this.#client.put(segment.key, segment.body, { ifNoneMatch: "*" });
        if (etag !== null) break;
        // The key exists: an earlier attempt landed only if the body is ours.
        const existing = await this.#client.get(segment.key);
        if (existing && Buffer.compare(existing.body, segment.body) === 0) break;
        this.#log(`log segment ${segment.key} already exists with other content; writing to a new key.`);
        segment.key = this.#nextKey();
        continue;
      } catch (error) {
        this.#lastError = error.message;
        if (attempt === 0) this.#log(`log upload failed, retrying: ${error.message}`);
        if (this.#closed && Date.now() > this.#closeDeadline) return false;
        await sleep(Math.min(5_000, 100 * 2 ** Math.min(attempt, 6)));
      }
    }
    this.#lastError = undefined;
    this.segments += 1;
    return true;
  }

  async #afterUpload(items) {
    const touched = new Set();
    for (const { row, entry } of items) {
      // Contiguous: after a gap (transactions lost before they shipped), only
      // a snapshot moves shipped past it.
      if (entry.txid === row.shipped + 1) row.shipped = entry.txid;
      row.log_bytes += entry.pages.length * entry.pageSize;
      touched.add(row);
    }
    for (const row of touched) this.#save(row);
    this.#release();
    for (const object of this.#objects.values()) {
      if (!touched.has(object.row)) continue;
      try {
        await this.#maintain(object);
      } catch (error) {
        this.#log(`maintenance of ${object.className} ${object.id} failed: ${error.message}`);
      }
    }
  }

  // Checkpoints a fully shipped WAL that has grown, and snapshots an object
  // whose log since its last snapshot has grown.
  async #maintain(object) {
    const { row } = object;
    if (!this.#objects.has(object.host) || row.captured !== row.shipped || object.database.db.isTransaction !== false) return;
    if (row.shipped - row.snapshot >= this.#tuning.snapshotTransactions || row.log_bytes >= this.#tuning.snapshotLogBytes) {
      await this.#snapshotNow(object);
      return;
    }
    let walBytes = 0;
    try {
      walBytes = statSync(`${object.database.path}-wal`).size;
    } catch {}
    if (walBytes >= this.#tuning.checkpointWalBytes) this.#checkpoint(object);
  }

  // Returns false if the checkpoint could not complete.
  #checkpoint(object) {
    this.#capture(object);
    const result = object.database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result.busy !== 0) return false;
    object.row.position = null;
    object.reader = new WalReader(`${object.database.path}-wal`);
    this.#save(object.row);
    return true;
  }

  // An exact copy of the database file at its last captured transaction.
  async #snapshotNow(object) {
    if (object.snapshotting || object.database.db.isTransaction !== false) return;
    object.snapshotting = true;
    try {
      await this.#snapshotOpen(object);
    } finally {
      object.snapshotting = false;
    }
  }

  async #snapshotOpen(object) {
    if (!this.#checkpoint(object)) return;
    const { row } = object;
    // The file is the state at txid. The object keeps writing while the
    // snapshot uploads, so row.captured moves on: the snapshot covers txid only.
    const body = readFileSync(object.database.path);
    let txid = row.captured;
    // A snapshot key already taken with other content (a history this node
    // doesn't know) is never overwritten: the snapshot takes the next txid,
    // if nothing was captured meanwhile; otherwise a later snapshot covers it.
    while (!(await this.#putSnapshot(row, txid, body))) {
      if (row.captured !== txid) {
        row.needs_snapshot = 1;
        this.#save(row);
        return;
      }
      row.captured += 1;
      txid = row.captured;
      this.#save(row);
    }
    // Everything up to txid is now in the bucket, whatever the log holds.
    row.shipped = Math.max(row.shipped, txid);
    row.snapshot = Math.max(row.snapshot, txid);
    if (row.captured === txid) {
      row.log_bytes = 0;
      row.needs_snapshot = 0;
    }
    this.#save(row);
    this.#release();
  }

  // True once the snapshot is in the bucket; false if the key holds other content.
  async #putSnapshot(row, txid, body) {
    const key = `${this.#root}/objects/${row.class}/${row.id}/snapshot-${pad(txid)}-e${row.epoch ?? 0}.sqlite`;
    if ((await this.#client.put(key, body, { ifNoneMatch: "*" })) !== null) return true;
    const existing = await this.#client.get(key);
    if (existing && Buffer.compare(existing.body, body) === 0) return true;
    this.#log(`snapshot ${key} already exists with other content; using the next transaction number.`);
    return false;
  }

  // Snapshots every object of this thread with transactions newer than its
  // snapshot (open ones through their host, closed ones from their file),
  // then deletes segments whose transactions are all covered by snapshots.
  // Coverage is checked per transaction, so a segment that holds another
  // thread's object stays until that thread snapshots it. Thread 0 also
  // covers writers that no longer run (after --threads shrank).
  async compact() {
    if (this.#closed) return;
    for (const row of this.#state.all()) {
      if (!this.#owns(row.id) || row.shipped <= row.snapshot || !this.#mayCompact(row)) continue;
      const open = [...this.#objects.values()].find((object) => object.row.class === row.class && object.row.id === row.id);
      if (open) await this.#snapshotNow(open);
      else await this.#snapshotClosed(this.#row(row.class, row.id));
    }
    // Each object's base: its newest snapshot of this node's epoch that is
    // older than the retention window. Restores inside the window start from
    // it or a later snapshot, so older snapshots and transactions can go.
    const cutoff = Date.now() - this.#tuning.retentionMs;
    const snapshots = new Map();
    // Bases of other threads' objects let thread 0 compact segments that
    // stopped writers left; only an object's own thread deletes its snapshots.
    for (const { key, lastModified } of await this.#client.list(`${this.#root}/objects/`)) {
      const match = SNAPSHOT_RE.exec(key);
      if (!match) continue;
      const objectKey = `${match[1]}/${match[2]}`;
      if (!snapshots.has(objectKey)) snapshots.set(objectKey, []);
      snapshots.get(objectKey).push({ key, txid: Number(match[3]), epoch: Number(match[4] ?? 0), time: Date.parse(lastModified ?? "") || Infinity });
    }
    const bases = new Map();
    for (const [objectKey, list] of snapshots) {
      const [className, id] = objectKey.split("/");
      const row = this.#state.get(className, id);
      if (row === null || !this.#mayCompact(row)) continue;
      const old = list.filter((snapshot) => snapshot.epoch === (row.epoch ?? 0) && snapshot.txid <= row.snapshot && (this.#tuning.retentionMs === 0 || snapshot.time <= cutoff));
      if (old.length === 0) continue;
      const base = old.reduce((best, snapshot) => Math.max(best, snapshot.txid), 0);
      bases.set(objectKey, base);
      if (this.#owns(id)) for (const snapshot of list) if (snapshot.txid < base) await this.#client.delete(snapshot.key);
    }
    const scope = this.#writer === "t0" ? `${this.#root}/log/` : `${this.#root}/log/${this.#writer}/`;
    const live = this.#inflight?.key;
    for (const { key } of await this.#client.list(scope)) {
      if (!key.endsWith(".seg") || key === live) continue;
      const object = await this.#client.get(key);
      if (!object) continue;
      const covered = decodeSegment(object.body).every((entry) => {
        const row = this.#state.get(entry.class, entry.id);
        return row !== null && this.#mayCompact(row) && (bases.get(`${entry.class}/${entry.id}`) ?? -1) >= entry.txid;
      });
      if (covered) await this.#client.delete(key);
    }
  }

  async #snapshotClosed(row) {
    const path = join(this.#objectsDirectory, row.class, `${row.id}.sqlite`);
    if (!existsSync(path) || existsSync(`${path}-wal`) || row.captured !== row.shipped) return;
    const body = readFileSync(path);
    let txid = row.captured;
    while (!(await this.#putSnapshot(row, txid, body))) {
      // The object opened and wrote meanwhile: its own snapshots cover it.
      if (row.captured !== txid) return;
      row.captured += 1;
      row.shipped = row.captured;
      txid = row.captured;
      this.#save(row);
    }
    row.snapshot = Math.max(row.snapshot, txid);
    if (row.captured === txid) row.log_bytes = 0;
    this.#save(row);
  }

  #closeDeadline = Infinity;

  async close() {
    clearInterval(this.#timer);
    clearInterval(this.#sweeper);
    clearInterval(this.#compactTimer);
    for (const object of this.#objects.values()) this.#capture(object);
    this.#closeDeadline = Date.now() + this.#tuning.closeTimeoutMs;
    this.#closed = true;
    await this.#ship();
    if (this.#inflight || this.#pending.length > 0) this.#log("The bucket did not take every write before shutdown; they ship at the next start.");
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error("The engine stopped before the write was durable."));
    this.#state.close();
  }
}

// Puts a rebuilt file in place of path; the old copy's WAL must not be
// applied to it.
function install(path, temporary) {
  for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  renameSync(temporary, path);
  fsyncPath(dirname(path));
}

// Whether the bucket can rebuild txid: from a snapshot at or before it (or
// from empty) through every transaction after that snapshot.
function restorable(txid, snapshots, entries) {
  if (txid === 0) return true;
  const base = snapshots.filter((snapshot) => snapshot.txid <= txid).reduce((best, snapshot) => Math.max(best, snapshot.txid), 0);
  for (let next = base + 1; next <= txid; next += 1) if (!entries.has(next)) return false;
  return true;
}

// SQLite removes a database's WAL and shared-memory files only when its last
// connection closes after a full checkpoint (it syncs the directory when it
// creates them, so a power loss doesn't remove them).
function closedCleanly(path) {
  return existsSync(path) && !existsSync(`${path}-wal`) && !existsSync(`${path}-shm`);
}

// Whether a WAL file still holds everything up to a recorded position.
function walReaches(walPath, position) {
  let fd;
  try {
    fd = openSync(walPath, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(32);
    if (readSync(fd, header, 0, 32, 0) < 32) return false;
    return header.subarray(16, 24).toString("hex") === position.salt && statSync(walPath).size >= position.offset;
  } finally {
    closeSync(fd);
  }
}

function fsyncPath(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// [4-byte header length][header JSON][page bytes], gzipped.
function encodeSegment(entries) {
  const pages = [];
  const header = {
    format: SEGMENT_FORMAT,
    entries: entries.map((entry) => ({
      class: entry.class,
      id: entry.id,
      // Absent in segments from before epochs: read as 0.
      epoch: entry.epoch ?? 0,
      txid: entry.txid,
      // When the transaction was captured (absent before point-in-time recovery).
      ...(entry.at === undefined ? {} : { at: entry.at }),
      pageSize: entry.pageSize,
      databasePages: entry.databasePages,
      pages: entry.pages.map(([pageNumber, page]) => {
        pages.push(page);
        return pageNumber;
      }),
    })),
  };
  const headerBytes = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  return gzipSync(Buffer.concat([length, headerBytes, ...pages]), { level: 1 });
}

export function decodeSegment(body) {
  const data = gunzipSync(body);
  const headerLength = data.readUInt32BE(0);
  const header = JSON.parse(data.subarray(4, 4 + headerLength).toString("utf8"));
  if (header.format !== SEGMENT_FORMAT) throw new Error(`Unknown log segment format ${header.format}`);
  let offset = 4 + headerLength;
  return header.entries.map((entry) => ({
    ...entry,
    pages: entry.pages.map((pageNumber) => {
      const page = data.subarray(offset, offset + entry.pageSize);
      offset += entry.pageSize;
      return [pageNumber, page];
    }),
  }));
}
