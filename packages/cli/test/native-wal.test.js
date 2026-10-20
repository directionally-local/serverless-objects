import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { WalReader, applyTransactions } from "../src/native/wal.js";

const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

async function database() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-wal-"));
  directories.push(directory);
  const path = join(directory, "a.sqlite");
  const db = new DatabaseSync(path);
  // A small page cache makes big transactions spill uncommitted pages into the WAL.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA cache_size = 8; PRAGMA synchronous = NORMAL;");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE u (v BLOB)");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(path, join(directory, "snapshot.sqlite"));
  return { db, path, snapshot: join(directory, "snapshot.sqlite") };
}

function dump(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  return JSON.stringify(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]), (_key, value) => (value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value));
}

test("a database rebuilt from a snapshot plus captured transactions matches the original", async () => {
  const { db, path, snapshot } = await database();
  const reader = new WalReader(`${path}-wal`);
  const shipped = [];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let step = 0; step < 1500; step += 1) {
    const roll = random();
    if (roll < 0.5) db.prepare("INSERT INTO t (v) VALUES (?)").run("x".repeat(Math.floor(random() * 900)));
    else if (roll < 0.6) db.prepare("DELETE FROM t WHERE id % 7 = ?").run(step % 7);
    else if (roll < 0.7) db.prepare("UPDATE t SET v = ? WHERE id % 5 = ?").run(`u${step}`, step % 5);
    else if (roll < 0.75) {
      // A big transaction that spills to the WAL, then rolls back.
      db.exec("BEGIN");
      for (let row = 0; row < 200; row += 1) db.prepare("INSERT INTO u VALUES (?)").run(Buffer.alloc(3000, step));
      shipped.push(...reader.capture());
      db.exec("ROLLBACK");
    } else if (roll < 0.8) {
      // A big transaction that commits.
      db.exec("BEGIN");
      for (let row = 0; row < 120; row += 1) db.prepare("INSERT INTO u VALUES (?)").run(Buffer.alloc(2500, step));
      // Captured mid-transaction: nothing uncommitted is shipped.
      shipped.push(...reader.capture());
      db.exec("COMMIT");
    } else if (roll < 0.82) db.exec(`CREATE TABLE IF NOT EXISTS t${step % 4} (a, b)`);
    else if (roll < 0.83) db.exec("DELETE FROM u");
    if (random() < 0.7) shipped.push(...reader.capture());
    if (random() < 0.02) {
      shipped.push(...reader.capture());
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
  }
  shipped.push(...reader.capture());
  applyTransactions(snapshot, shipped);
  const copy = new DatabaseSync(snapshot, { readOnly: true });
  assert.equal(copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(dump(copy), dump(db));
  copy.close();
  db.close();
});

test("a reader resumes from a saved position, and a WAL restarted by a checkpoint is read from the top", async () => {
  const { db, path, snapshot } = await database();
  const shipped = [];
  let reader = new WalReader(`${path}-wal`);
  db.prepare("INSERT INTO t (v) VALUES ('a')").run();
  shipped.push(...reader.capture());
  // A new reader from the saved position sees only what came after.
  reader = new WalReader(`${path}-wal`, reader.position);
  assert.deepEqual(reader.capture(), []);
  db.prepare("INSERT INTO t (v) VALUES ('b')").run();
  const second = reader.capture();
  assert.equal(second.length, 1);
  shipped.push(...second);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.deepEqual(reader.capture(), []);
  db.prepare("INSERT INTO t (v) VALUES ('c')").run();
  shipped.push(...reader.capture());
  applyTransactions(snapshot, shipped);
  const copy = new DatabaseSync(snapshot, { readOnly: true });
  assert.deepEqual(copy.prepare("SELECT v FROM t ORDER BY id").all().map((row) => row.v), ["a", "b", "c"]);
  copy.close();
  db.close();
});
