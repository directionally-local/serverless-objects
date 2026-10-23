// Bundled into apps by `sobjects deploy`. It wraps the app's default handler
// and Durable Object classes so the supervisor can read an object's storage.
// Requests must carry a token whose SHA-256 matches the hash baked in at
// deploy time; anything else falls through to the app unchanged.

export const INSPECT_HEADER = "x-sobjects-inspect";
const MAX_ROWS = 500;
const MAX_EXPORT_ROWS = 10_000;
const MAX_VALUE_BYTES = 64 * 1024;
const STATE = Symbol("sobjects.state");

export function wrapDefault(handler, { tokenHash, classes }) {
  const inspect = (request, env) => routeToObject(request, env, { tokenHash, classes });
  if (typeof handler === "function") {
    // A WorkerEntrypoint class.
    return keepName(class extends handler {
      fetch(request) {
        if (request.headers.has(INSPECT_HEADER)) return inspect(request, this.env);
        return super.fetch(request);
      }
    }, handler);
  }
  return {
    ...handler,
    fetch(request, env, ctx) {
      if (request.headers.has(INSPECT_HEADER)) return inspect(request, env);
      if (typeof handler?.fetch !== "function") return new Response("Not found", { status: 404 });
      return handler.fetch.call(handler, request, env, ctx);
    },
  };
}

export function wrapObjectClass(Base, { tokenHash }) {
  return keepName(class extends Base {
    constructor(state, env) {
      super(state, env);
      this[STATE] = state;
    }

    async fetch(request) {
      if (request.headers.has(INSPECT_HEADER)) {
        if (!(await tokenMatches(request.headers.get(INSPECT_HEADER), tokenHash))) return unauthorized();
        try {
          return json(200, await inspectStorage(this[STATE], await request.json()));
        } catch (error) {
          return json(error instanceof RangeError ? 400 : 500, { error: String(error?.message ?? error) });
        }
      }
      if (typeof super.fetch !== "function") throw new TypeError("This Durable Object class has no fetch handler.");
      return super.fetch(request);
    }
  }, Base);
}

// Apps read constructor.name (the Agents SDK derives the agent name from it),
// so the wrapper must not show up as an anonymous class.
function keepName(Wrapped, Base) {
  Object.defineProperty(Wrapped, "name", { value: Base.name, configurable: true });
  return Wrapped;
}

async function routeToObject(request, env, { tokenHash, classes }) {
  if (!(await tokenMatches(request.headers.get(INSPECT_HEADER), tokenHash))) return unauthorized();
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Expected a JSON body." });
  }
  const binding = classes[body?.className];
  if (!binding || !env[binding]) return json(404, { error: `Unknown Durable Object class ${body?.className}.` });
  if (!/^[0-9a-f]{64}$/.test(String(body.id))) return json(400, { error: "Expected a 64-character hex object id." });
  const namespace = env[binding];
  const stub = namespace.get(namespace.idFromString(body.id));
  return stub.fetch("https://sobjects.inspect/", {
    method: "POST",
    headers: { [INSPECT_HEADER]: request.headers.get(INSPECT_HEADER), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function inspectStorage(state, { op, prefix, startAfter, limit = 100, query }) {
  const storage = state.storage;
  if (op === "summary") {
    // Engine-internal tables (_cf_*, celld's _litestream_*) are not readable
    // from object code, so only the app's own tables are listed.
    const tables = storage.sql
      ? storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '_litestream_*' ORDER BY name",
      ).toArray().map(({ name }) => ({ name, rows: countRows(storage.sql, name) }))
      : [];
    const alarm = await storage.getAlarm();
    const sockets = typeof state.getWebSockets === "function" ? state.getWebSockets() : [];
    return {
      tables,
      alarm: alarm === null ? null : new Date(alarm).toISOString(),
      websockets: {
        count: sockets.length,
        tags: [...new Set(sockets.flatMap((socket) => safeTags(state, socket)))].slice(0, 100),
      },
    };
  }
  if (op === "kv") {
    const count = clampLimit(limit);
    const options = { limit: count + 1 };
    if (prefix) options.prefix = String(prefix);
    if (startAfter) options.startAfter = String(startAfter);
    const entries = [...(await storage.list(options))];
    const page = entries.slice(0, count);
    return {
      entries: page.map(([key, value]) => ({ key, value: encodeValue(value) })),
      next: entries.length > count ? page.at(-1)[0] : undefined,
    };
  }
  if (op === "sql") {
    if (!storage.sql) throw new RangeError("This object does not use SQLite storage.");
    const text = String(query ?? "").trim();
    if (!isReadOnly(text)) {
      throw new RangeError("The inspector runs read-only SELECT, WITH, EXPLAIN, and PRAGMA queries only.");
    }
    const cursor = storage.sql.exec(text);
    const rows = [];
    for (const row of cursor) {
      if (rows.length === MAX_ROWS) break;
      rows.push(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encodeValue(value)])));
    }
    return { columns: cursor.columnNames, rows, truncated: rows.length === MAX_ROWS };
  }
  if (op === "export") {
    // A logical backup: every key-value entry and every app table, bounded so
    // one request cannot exhaust the isolate.
    const entries = [];
    let truncated = false;
    let cursor;
    for (;;) {
      const page = [...(await storage.list({ limit: 1_000, ...(cursor ? { startAfter: cursor } : {}) }))];
      for (const [key, value] of page) entries.push({ key, value: encodeValue(value) });
      if (page.length < 1_000) break;
      cursor = page.at(-1)[0];
      if (entries.length >= MAX_EXPORT_ROWS) {
        truncated = true;
        break;
      }
    }
    const tables = [];
    if (storage.sql) {
      const names = storage.sql.exec(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '_litestream_*' ORDER BY name",
      ).toArray();
      for (const { name, sql } of names) {
        const rows = [];
        const result = storage.sql.exec(`SELECT * FROM "${String(name).replace(/"/g, '""')}"`);
        for (const row of result) {
          if (rows.length === MAX_EXPORT_ROWS) {
            truncated = true;
            break;
          }
          rows.push(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encodeValue(value)])));
        }
        tables.push({ name, schema: sql, columns: result.columnNames, rows });
      }
    }
    const alarm = await storage.getAlarm();
    return {
      format: "sobjects-object-export/v1",
      exportedAt: new Date().toISOString(),
      alarm: alarm === null ? null : new Date(alarm).toISOString(),
      kv: entries,
      tables,
      truncated,
    };
  }
  throw new RangeError(`Unknown inspector operation ${op}.`);
}

// PRAGMAs whose parenthesized argument names what to read rather than a new
// value: `PRAGMA name(value)` sets a value just like `PRAGMA name = value`.
const QUERY_PRAGMAS = new Set([
  "foreign_key_check", "foreign_key_list", "index_info", "index_list", "index_xinfo",
  "integrity_check", "quick_check", "table_info", "table_list", "table_xinfo",
]);
// PRAGMAs that write or checkpoint even without an argument.
const ACTING_PRAGMAS = new Set(["incremental_vacuum", "optimize", "shrink_memory", "wal_checkpoint"]);

// A guard against accidents in the console, not a security boundary: callers
// already hold the inspector token.
export function isReadOnly(query) {
  const statements = query.replace(/;\s*$/, "");
  if (statements.includes(";")) return false;
  const keyword = /^\s*(\w+)/.exec(statements)?.[1]?.toUpperCase();
  if (keyword === "PRAGMA") {
    if (statements.includes("=")) return false;
    const pragma = /^\s*PRAGMA\s+(?:\w+\s*\.\s*)?(\w+)\s*([\s\S]*)$/i.exec(statements);
    if (!pragma) return false;
    const name = pragma[1].toLowerCase();
    if (pragma[2] === "") return !ACTING_PRAGMAS.has(name);
    return pragma[2].startsWith("(") && QUERY_PRAGMAS.has(name);
  }
  if (keyword === "SELECT" || keyword === "EXPLAIN") return true;
  if (keyword === "WITH") return !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(statements);
  return false;
}

export function encodeValue(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "string" && value.length > MAX_VALUE_BYTES) {
      return { $type: "string", truncated: true, value: value.slice(0, MAX_VALUE_BYTES) };
    }
    return value;
  }
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (value instanceof Date) return { $type: "Date", value: value.toISOString() };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = "";
    for (const byte of bytes.subarray(0, MAX_VALUE_BYTES)) binary += String.fromCharCode(byte);
    return { $type: "bytes", length: bytes.length, base64: btoa(binary), truncated: bytes.length > MAX_VALUE_BYTES };
  }
  if (value instanceof Map) return { $type: "Map", value: [...value].map(([k, v]) => [encodeValue(k), encodeValue(v)]) };
  if (value instanceof Set) return { $type: "Set", value: [...value].map(encodeValue) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]));
  }
  return { $type: typeof value, value: String(value) };
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tokenMatches(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const actual = await sha256Hex(token);
  let difference = actual.length ^ expectedHash.length;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expectedHash.charCodeAt(index % expectedHash.length);
  }
  return difference === 0;
}

function countRows(sql, name) {
  try {
    return sql.exec(`SELECT count(*) AS n FROM "${String(name).replace(/"/g, '""')}"`).one().n;
  } catch {
    return null;
  }
}

function safeTags(state, socket) {
  try {
    return state.getTags(socket);
  } catch {
    return [];
  }
}

function clampLimit(limit) {
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 1 || value > MAX_ROWS) throw new RangeError(`limit must be from 1 to ${MAX_ROWS}.`);
  return value;
}

function unauthorized() {
  return json(401, { error: "Invalid inspector token." });
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
