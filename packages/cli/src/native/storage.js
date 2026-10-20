// DurableObjectStorage for the native engine: one SQLite file per object
// (node:sqlite). Key-value entries live in _cf_KV, encoded with V8's
// structured-clone serializer; the alarm lives in _cf_METADATA; user SQL tables
// sit beside them. node:sqlite is synchronous, so every async method resolves
// as a microtask: code that only awaits storage cannot be interleaved by
// another event, which is what Cloudflare's input gates guarantee.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";

const MAX_KEY_BYTES = 2048;
const CONTROL_STATEMENT_RE = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const INTERNAL_PREFIX = "_cf_";

export class ObjectDatabase {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS _cf_KV (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS _cf_METADATA (key TEXT PRIMARY KEY, value) WITHOUT ROWID;`);
  }

  meta(key) {
    return this.db.prepare("SELECT value FROM _cf_METADATA WHERE key = ?").get(key)?.value ?? null;
  }

  setMeta(key, value) {
    if (value === null || value === undefined) this.db.prepare("DELETE FROM _cf_METADATA WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO _cf_METADATA (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // Rows changed through this connection since it opened.
  changes() {
    return this.db.prepare("SELECT total_changes() AS changes").get().changes;
  }

  // A consistent copy of the database in one file.
  snapshotTo(path) {
    this.db.prepare("VACUUM INTO ?").run(path);
  }

  close() {
    this.db.close();
  }
}

export class DurableObjectStorage {
  #db;
  #hooks;
  #savepoints = 0;

  // hooks: { onAlarmChange(timestamp | null), holdInputGate(promise) }
  constructor(database, hooks) {
    this.#db = database;
    this.#hooks = hooks;
    this.sql = new SqlStorage(database.db);
    // The synchronous KV API of SQLite-backed objects, over the same entries.
    this.kv = {
      get: (key) => this.#read(key),
      put: (key, value) => this.#write(key, value),
      delete: (key) => Number(database.db.prepare("DELETE FROM _cf_KV WHERE key = ?").run(checkKey(key)).changes) > 0,
      list: (options = {}) => listEntries(database.db, options),
    };
  }

  async get(keyOrKeys) {
    if (Array.isArray(keyOrKeys)) {
      const result = new Map();
      for (const key of keyOrKeys) {
        const value = this.#read(key);
        if (value !== undefined) result.set(key, value);
      }
      return result;
    }
    return this.#read(keyOrKeys);
  }

  async put(keyOrEntries, value) {
    if (typeof keyOrEntries === "object" && keyOrEntries !== null) {
      this.transactionSync(() => {
        for (const [key, entry] of Object.entries(keyOrEntries)) this.#write(key, entry);
      });
      return;
    }
    this.#write(keyOrEntries, value);
  }

  async delete(keyOrKeys) {
    const statement = this.#db.db.prepare("DELETE FROM _cf_KV WHERE key = ?");
    if (Array.isArray(keyOrKeys)) {
      let deleted = 0;
      this.transactionSync(() => {
        for (const key of keyOrKeys) deleted += Number(statement.run(checkKey(key)).changes);
      });
      return deleted;
    }
    return Number(statement.run(checkKey(keyOrKeys)).changes) > 0;
  }

  async list(options = {}) {
    return new Map(listEntries(this.#db.db, options));
  }

  // Deletes every key, every SQL table and the alarm.
  async deleteAll() {
    this.transactionSync(() => {
      this.#db.db.exec("DELETE FROM _cf_KV");
      const tables = this.#db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all();
      for (const { name } of tables) this.#db.db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
    });
    await this.deleteAlarm();
  }

  transactionSync(fn) {
    const name = `sobjects_tx_${++this.#savepoints}`;
    this.#db.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      if (result && typeof result.then === "function") throw new TypeError("transactionSync() callbacks must be synchronous.");
      this.#db.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#db.db.exec(`ROLLBACK TO ${name}`);
      this.#db.db.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      this.#savepoints -= 1;
    }
  }

  // No other event starts while an async transaction is open.
  async transaction(closure) {
    const name = `sobjects_tx_${++this.#savepoints}`;
    this.#db.db.exec(`SAVEPOINT ${name}`);
    let rolledBack = false;
    const txn = {
      get: (...args) => this.get(...args),
      put: (...args) => this.put(...args),
      delete: (...args) => this.delete(...args),
      list: (...args) => this.list(...args),
      getAlarm: (...args) => this.getAlarm(...args),
      setAlarm: (...args) => this.setAlarm(...args),
      deleteAlarm: (...args) => this.deleteAlarm(...args),
      rollback: () => { rolledBack = true; },
    };
    const work = (async () => {
      try {
        const result = await closure(txn);
        if (rolledBack) this.#db.db.exec(`ROLLBACK TO ${name}`);
        this.#db.db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.#db.db.exec(`ROLLBACK TO ${name}`);
        this.#db.db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        this.#savepoints -= 1;
      }
    })();
    this.#hooks.holdInputGate(work);
    return work;
  }

  async getAlarm() {
    const value = this.#db.meta("alarm");
    return value === null ? null : Number(value);
  }

  async setAlarm(scheduledTime) {
    const at = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    if (!Number.isFinite(at)) throw new TypeError("setAlarm() takes a Date or a millisecond timestamp.");
    this.#db.setMeta("alarm", Math.trunc(at));
    this.#hooks.onAlarmChange(Math.trunc(at));
  }

  async deleteAlarm() {
    this.#db.setMeta("alarm", null);
    this.#hooks.onAlarmChange(null);
  }

  // Writes are committed as they happen, so there is nothing to wait for.
  async sync() {}

  #read(key) {
    const row = this.#db.db.prepare("SELECT value FROM _cf_KV WHERE key = ?").get(checkKey(key));
    return row ? deserialize(row.value) : undefined;
  }

  #write(key, value) {
    if (value === undefined) throw new TypeError("put() needs a value; use delete() to remove a key.");
    this.#db.db.prepare("INSERT INTO _cf_KV (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(checkKey(key), serialize(value));
  }
}

export class SqlStorage {
  #db;

  constructor(db) {
    this.#db = db;
  }

  exec(query, ...bindings) {
    if (typeof query !== "string") throw new TypeError("sql.exec() takes a query string.");
    if (CONTROL_STATEMENT_RE.test(query)) {
      throw new Error("Transactions are managed by the runtime; use ctx.storage.transactionSync() instead of BEGIN/COMMIT.");
    }
    if (query.includes(INTERNAL_PREFIX) && /\b_cf_[A-Za-z]/.test(query)) {
      throw new Error("not authorized: tables named _cf_* are internal to the runtime.");
    }
    return new SqlStorageCursor(this.#db, query, bindings.map(toSqlValue));
  }

  get databaseSize() {
    const { page_count: pages } = this.#db.prepare("PRAGMA page_count").get();
    const { page_size: size } = this.#db.prepare("PRAGMA page_size").get();
    return pages * size;
  }
}

export class SqlStorageCursor {
  #rows;
  #index = 0;

  constructor(db, query, bindings) {
    const statement = db.prepare(query);
    const columns = statement.columns();
    this.columnNames = columns.map((column) => column.name);
    if (columns.length > 0) {
      statement.setReturnArrays(true);
      this.#rows = statement.all(...bindings).map((row) => row.map(fromSqlValue));
      this.rowsRead = this.#rows.length;
      this.rowsWritten = 0;
    } else {
      const result = statement.run(...bindings);
      this.#rows = [];
      this.rowsRead = 0;
      this.rowsWritten = Number(result.changes);
    }
  }

  next() {
    if (this.#index >= this.#rows.length) return { done: true, value: undefined };
    return { done: false, value: this.#object(this.#rows[this.#index++]) };
  }

  [Symbol.iterator]() {
    return this;
  }

  toArray() {
    const rest = this.#rows.slice(this.#index).map((row) => this.#object(row));
    this.#index = this.#rows.length;
    return rest;
  }

  one() {
    const rest = this.toArray();
    if (rest.length !== 1) throw new Error(`Expected exactly one result from SQL query, but got ${rest.length === 0 ? "no results" : "multiple results"}.`);
    return rest[0];
  }

  *raw() {
    while (this.#index < this.#rows.length) yield this.#rows[this.#index++];
  }

  #object(row) {
    return Object.fromEntries(this.columnNames.map((name, column) => [name, row[column]]));
  }
}

function* listEntries(db, { start, startAfter, end, prefix, reverse = false, limit } = {}) {
  if (start !== undefined && startAfter !== undefined) throw new TypeError("list() takes start or startAfter, not both.");
  const clauses = [];
  const bindings = [];
  if (start !== undefined) { clauses.push("key >= ?"); bindings.push(start); }
  if (startAfter !== undefined) { clauses.push("key > ?"); bindings.push(startAfter); }
  if (end !== undefined) { clauses.push("key < ?"); bindings.push(end); }
  if (prefix) { clauses.push("key >= ? AND instr(key, ?) = 1"); bindings.push(prefix, prefix); }
  let query = "SELECT key, value FROM _cf_KV";
  if (clauses.length) query += ` WHERE ${clauses.join(" AND ")}`;
  query += ` ORDER BY key ${reverse ? "DESC" : "ASC"}`;
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("list() limit must be a positive integer.");
    query += " LIMIT ?";
    bindings.push(limit);
  }
  for (const row of db.prepare(query).all(...bindings)) yield [row.key, deserialize(row.value)];
}

function checkKey(key) {
  if (typeof key !== "string") throw new TypeError("Durable Object storage keys must be strings.");
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) throw new RangeError(`Keys cannot be larger than ${MAX_KEY_BYTES} bytes.`);
  return key;
}

function toSqlValue(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

// Cloudflare returns BLOB columns as ArrayBuffer.
function fromSqlValue(value) {
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return value;
}
