// Conformance app: each route runs one check inside a Durable Object and
// answers {pass, detail}. The same bundle runs on Wrangler (workerd) and
// celld, so a difference in results is a difference between the engines.
import { DurableObject } from "cloudflare:workers";

const json = (body, status = 200) => Response.json(body, { status });

function check(name, condition, detail) {
  if (!condition) throw new Error(`${name}: ${detail === undefined ? "failed" : JSON.stringify(detail)}`);
}

export class Storage extends DurableObject {
  // Point-in-time recovery (run only where supported: see /pitr).
  pitrSet(value) {
    this.ctx.storage.kv.put("pitr", value);
  }

  pitrGet() {
    return this.ctx.storage.kv.get("pitr") ?? null;
  }

  pitrBookmark(time) {
    return time === undefined ? this.ctx.storage.getCurrentBookmark() : this.ctx.storage.getBookmarkForTime(time);
  }

  async pitrRestore(bookmark) {
    await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    this.ctx.abort("restoring a bookmark");
  }

  async kv() {
    const storage = this.ctx.storage;
    await storage.deleteAll();
    await storage.put("a", 1);
    await storage.put({ b: { nested: [1, 2] }, c: new Date(0), d: new Uint8Array([7]) });
    check("get", (await storage.get("a")) === 1);
    const many = await storage.get(["a", "b", "missing"]);
    check("get many", many instanceof Map && many.size === 2 && many.get("b").nested[1] === 2, [...many.keys()]);
    check("structured clone Date", (await storage.get("c")) instanceof Date);
    check("structured clone bytes", (await storage.get("d"))[0] === 7);
    const listed = await storage.list({ prefix: "", limit: 2 });
    check("list limit", [...listed.keys()].join() === "a,b", [...listed.keys()]);
    const reversed = await storage.list({ reverse: true, limit: 1 });
    check("list reverse", [...reversed.keys()][0] === "d", [...reversed.keys()]);
    const ranged = await storage.list({ start: "b", end: "d" });
    check("list range", [...ranged.keys()].join() === "b,c", [...ranged.keys()]);
    check("delete", (await storage.delete("a")) === true && (await storage.get("a")) === undefined);
    check("delete many", (await storage.delete(["b", "c", "zz"])) === 2);
    return "get/put/list/delete with structured clone values";
  }

  sql() {
    const sql = this.ctx.storage.sql;
    sql.exec("DROP TABLE IF EXISTS items");
    sql.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, score REAL)");
    for (let index = 1; index <= 3; index += 1) sql.exec("INSERT INTO items (name, score) VALUES (?, ?)", `item-${index}`, index / 2);
    const cursor = sql.exec("SELECT id, name, score FROM items ORDER BY id");
    const rows = cursor.toArray();
    check("rows", rows.length === 3 && rows[2].name === "item-3" && rows[1].score === 1, rows);
    check("columnNames", cursor.columnNames.join() === "id,name,score", cursor.columnNames);
    check("rowsRead", cursor.rowsRead >= 3, cursor.rowsRead);
    check("one", sql.exec("SELECT count(*) AS n FROM items").one().n === 3);
    const raw = [...sql.exec("SELECT id FROM items ORDER BY id DESC").raw()];
    check("raw", raw[0][0] === 3, raw);
    let threw = false;
    try {
      sql.exec("SELECT * FROM missing_table");
    } catch {
      threw = true;
    }
    check("errors throw", threw);
    check("databaseSize", typeof sql.databaseSize === "number" && sql.databaseSize > 0, sql.databaseSize);
    return "exec, cursors, raw rows, one(), errors, databaseSize";
  }

  async transactions() {
    const storage = this.ctx.storage;
    await storage.put("tx", "before");
    try {
      storage.transactionSync(() => {
        storage.sql.exec("CREATE TABLE IF NOT EXISTS tx_rows (n INTEGER)");
        storage.sql.exec("DELETE FROM tx_rows");
        storage.sql.exec("INSERT INTO tx_rows VALUES (1)");
        throw new Error("rollback");
      });
    } catch {
      // Expected.
    }
    const count = storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'tx_rows'").one().n === 0
      ? 0
      : storage.sql.exec("SELECT count(*) AS n FROM tx_rows").one().n;
    check("transactionSync rollback", count === 0, count);
    try {
      await storage.transaction(async (txn) => {
        await txn.put("tx", "inside");
        throw new Error("rollback");
      });
    } catch {
      // Expected.
    }
    check("transaction rollback", (await storage.get("tx")) === "before", await storage.get("tx"));
    await storage.transaction(async (txn) => txn.put("tx", "committed"));
    check("transaction commit", (await storage.get("tx")) === "committed");
    return "transactionSync and transaction commit/rollback";
  }

  async increment() {
    // Read, yield to the event loop, then write. Input gates keep concurrent
    // requests from interleaving between the read and the write.
    const value = ((await this.ctx.storage.get("counter")) ?? 0) + 1;
    await this.ctx.storage.put("counter", value);
    return value;
  }

  async resetCounter() {
    await this.ctx.storage.delete("counter");
  }

  async counter() {
    return (await this.ctx.storage.get("counter")) ?? 0;
  }

  // RPC surface.
  echo(value) {
    return { value, at: new Date(0) };
  }

  async fail() {
    throw new RangeError("expected failure");
  }
}

export class Alarms extends DurableObject {
  async arm(delayMs) {
    await this.ctx.storage.delete("fired");
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
    return this.ctx.storage.getAlarm();
  }

  async alarm(info) {
    await this.ctx.storage.put("fired", { at: Date.now(), retryCount: info?.retryCount ?? 0 });
  }

  async status() {
    return { fired: (await this.ctx.storage.get("fired")) ?? null, pending: await this.ctx.storage.getAlarm() };
  }

  async deleteAllClearsAlarm() {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    check("alarm set", (await this.ctx.storage.getAlarm()) !== null);
    await this.ctx.storage.deleteAll();
    const after = await this.ctx.storage.getAlarm();
    check("deleteAll cleared alarm", after === null, after);
    return "deleteAll() removes a pending alarm";
  }

  async deleteAlarm() {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    await this.ctx.storage.deleteAlarm();
    check("deleteAlarm", (await this.ctx.storage.getAlarm()) === null);
    return "setAlarm/getAlarm/deleteAlarm";
  }
}

export class Gate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.ready = true;
    });
  }

  async readyBeforeRequests() {
    return this.ready === true;
  }
}

export class Sockets extends DurableObject {
  // A new value means the runtime constructed a new instance, e.g. after hibernation.
  instance = crypto.randomUUID();

  async fetch(request) {
    const pair = new WebSocketPair();
    const tag = new URL(request.url).searchParams.get("tag") ?? "default";
    this.ctx.acceptWebSocket(pair[1], [tag]);
    pair[1].serializeAttachment({ tag, joined: 1 });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    const tags = this.ctx.getTags(socket);
    socket.send(JSON.stringify({
      echo: message,
      attachment,
      tags,
      sockets: this.ctx.getWebSockets().length,
      tagged: this.ctx.getWebSockets(tags[0]).length,
      instance: this.instance,
    }));
  }

  async webSocketClose(socket, code) {
    socket.close(code, "bye");
  }
}

const CASES = {
  async ids(env) {
    const a = env.STORAGE.idFromName("conformance");
    const b = env.STORAGE.idFromName("conformance");
    const unique = env.STORAGE.newUniqueId();
    check("idFromName deterministic", a.equals(b) && a.toString() === b.toString());
    check("id hex", /^[0-9a-f]{64}$/.test(a.toString()), a.toString());
    check("unique differs", !unique.equals(a));
    check("idFromString roundtrip", env.STORAGE.idFromString(a.toString()).equals(a));
    check("name", a.name === "conformance", a.name);
    let threw = false;
    try {
      env.STORAGE.idFromString("not-an-id");
    } catch {
      threw = true;
    }
    check("idFromString rejects", threw);
    return "idFromName, newUniqueId, idFromString, equals, name";
  },
  kv: (env) => stub(env).kv(),
  sql: (env) => stub(env).sql(),
  transactions: (env) => stub(env).transactions(),
  async rpc(env) {
    const result = await stub(env).echo({ list: [1, 2], map: new Map([["k", "v"]]) });
    check("structured args", result.value.list[1] === 2 && result.value.map.get("k") === "v", result);
    check("structured result", result.at instanceof Date);
    let error;
    try {
      await stub(env).fail();
    } catch (caught) {
      error = caught;
    }
    check("errors propagate", error?.message === "expected failure", error?.message);
    return "RPC arguments, results, and thrown errors";
  },
  async "input-gate"(env) {
    const target = stub(env, "gate-counter");
    await target.resetCounter();
    await Promise.all(Array.from({ length: 25 }, () => target.increment()));
    const value = await target.counter();
    check("no lost updates", value === 25, value);
    const gated = env.GATE.get(env.GATE.newUniqueId());
    check("blockConcurrencyWhile", await gated.readyBeforeRequests());
    return "concurrent read-modify-write and blockConcurrencyWhile";
  },
  "delete-all-alarm": (env) => alarms(env, "delete-all").deleteAllClearsAlarm(),
  "alarm-api": (env) => alarms(env, "api").deleteAlarm(),
};

// A bookmark from getCurrentBookmark() and one from getBookmarkForTime()
// each restore the state they name, after ctx.abort(). A fresh stub per call:
// an aborted object's stub is broken.
async function pointInTimeRecovery(env) {
  const name = `pitr-${crypto.randomUUID()}`;
  const object = () => stub(env, name);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 1_500));
  const restore = async (bookmark) => {
    await object().pitrRestore(bookmark).then(() => {
      throw new Error("abort() did not reject the call");
    }, () => {});
  };
  await object().pitrSet(1);
  const first = await object().pitrBookmark();
  await pause();
  await object().pitrSet(2);
  await pause();
  const second = Date.now();
  await pause();
  await object().pitrSet(3);
  check("bookmarks sort", typeof first === "string" && first < (await object().pitrBookmark()), first);
  await restore(first);
  check("restored current bookmark", (await object().pitrGet()) === 1, await object().pitrGet());
  await object().pitrSet(4);
  await restore(await object().pitrBookmark(second));
  check("restored bookmark for time", (await object().pitrGet()) === 2, await object().pitrGet());
  return "getCurrentBookmark, getBookmarkForTime, onNextSessionRestoreBookmark and abort()";
}

function stub(env, name = "conformance") {
  return env.STORAGE.get(env.STORAGE.idFromName(name));
}

function alarms(env, name) {
  return env.ALARMS.get(env.ALARMS.idFromName(name));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/cases") return json(Object.keys(CASES));
    if (url.pathname === "/pitr") return json(await pointInTimeRecovery(env).then((detail) => ({ pass: true, detail }), (error) => ({ pass: false, detail: String(error?.message ?? error) })));
    if (url.pathname === "/socket") {
      return env.SOCKETS.get(env.SOCKETS.idFromName("sockets")).fetch(request);
    }
    if (url.pathname === "/alarm/arm") {
      const pending = await alarms(env, "durable").arm(Number(url.searchParams.get("ms") ?? 1_000));
      return json({ pending });
    }
    if (url.pathname === "/alarm/status") return json(await alarms(env, "durable").status());
    const name = url.pathname.replace(/^\/case\//, "");
    if (!url.pathname.startsWith("/case/") || !CASES[name]) return json({ error: "unknown case" }, 404);
    try {
      return json({ pass: true, detail: await CASES[name](env) });
    } catch (error) {
      return json({ pass: false, detail: String(error?.message ?? error) });
    }
  },
};
