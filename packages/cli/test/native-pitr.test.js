import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NativeEngine, loadProjectConfig } from "../src/native/engine.js";

const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-pitr-"));
  directories.push(directory);
  return directory;
}

// A bucket in memory with conditional PUTs and LastModified times from `now()`.
class MemoryBucket {
  objects = new Map();
  now = () => Date.now();
  failPut = () => false;
  // Stored, but the response is lost.
  ghostPut = () => false;
  #version = 0;

  async list(prefix) {
    return [...this.objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, { etag, body, modified }]) => ({ key, etag, size: body.length, lastModified: new Date(modified).toISOString() }));
  }

  async get(key) {
    const object = this.objects.get(key);
    return object ? { body: Buffer.from(object.body), etag: object.etag } : null;
  }

  async put(key, body, { ifMatch, ifNoneMatch } = {}) {
    if (this.failPut(key)) throw new Error("S3 PUT failed: injected");
    const current = this.objects.get(key);
    if (ifNoneMatch === "*" && current) return null;
    if (ifMatch && current?.etag !== ifMatch) return null;
    const etag = `"${(this.#version += 1)}"`;
    this.objects.set(key, { body: Buffer.from(body), etag, modified: this.now() });
    if (this.ghostPut(key)) throw new Error("S3 PUT timed out");
    return etag;
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

const APP = `
import { DurableObject } from "cloudflare:workers";
export class Doc extends DurableObject {
  set(value) {
    this.ctx.storage.kv.put("value", value);
    return value;
  }
  get() { return this.ctx.storage.kv.get("value") ?? null; }
  bookmark() { return this.ctx.storage.getCurrentBookmark(); }
  bookmarkAt(time) { return this.ctx.storage.getBookmarkForTime(time); }
  async restore(bookmark, abort = true) {
    const undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    this.ctx.storage.kv.put("undo", undo);
    if (abort) this.ctx.abort("restoring");
    return undo;
  }
  setAlarmIn(ms) { return this.ctx.storage.setAlarm(Date.now() + ms); }
  getAlarm() { return this.ctx.storage.getAlarm(); }
  clearAlarm() { return this.ctx.storage.deleteAlarm(); }
  alarm() {
    if (this.ctx.storage.kv.get("abortInAlarm")) {
      this.ctx.storage.kv.delete("abortInAlarm");
      this.ctx.abort("reset from the alarm");
    }
    this.ctx.storage.kv.put("alarmed", true);
  }
  abortInAlarm(ms) {
    this.ctx.storage.kv.put("abortInAlarm", true);
    return this.ctx.storage.setAlarm(Date.now() + ms);
  }
  alarmed() { return this.ctx.storage.kv.get("alarmed") ?? false; }
}
export default { fetch: () => new Response("ok") };
`;

async function project() {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/index.js"), APP);
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "pitr-app", main: "src/index.js", durable_objects: { bindings: [{ name: "DOC", class_name: "Doc" }] } }));
  return directory;
}

async function engine(directory, bucket, persistDirectory, { mode = "durable", retentionMs = 7 * 86_400_000, tuning, node } = {}) {
  const config = await loadProjectConfig(directory);
  const started = new NativeEngine({
    config,
    persistDirectory,
    idleEvictMs: 0,
    backup: mode ? { client: bucket, prefix: "p", mode, intervalMs: 60_000, retentionMs, tuning } : undefined,
    cluster: node ? { name: node, ttlMs: 4_000, wakeMs: 200 } : undefined,
    log: () => {},
  });
  await started.start();
  return started;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

test("an object restores a bookmark on its next session, and can undo it", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const persist = await temporaryDirectory();
  let node = await engine(directory, bucket, persist);
  try {
    const doc = () => node.env.DOC.getByName("a");
    await doc().set(1);
    const first = await doc().bookmark();
    await doc().set(2);
    await doc().set(3);
    assert.match(first, /^[0-9a-f]{16}-[0-9a-f]{16}$/);
    assert.ok(first < (await doc().bookmark()), "bookmarks sort by time");

    // abort() fails the call that made it; the next call sees the restored state.
    await assert.rejects(doc().restore(first), /restoring/);
    assert.equal(await doc().get(), 1);
    await doc().set(4);

    // The bookmark returned by the restore brings back the state before it.
    const undo = await node.env.DOC.getByName("a").restore(first, false).catch((error) => error);
    assert.equal(typeof undo, "string");
    await node.close();
    node = await engine(directory, bucket, persist);
    // The restore requested before the restart ran as the object opened.
    assert.equal(await doc().get(), 1);
    await assert.rejects(doc().restore(undo), /restoring/);
    assert.equal(await doc().get(), 4);

    // A disk that loses everything comes back with the restored state.
    await node.close();
    rmSync(persist, { recursive: true, force: true });
    node = await engine(directory, bucket, persist);
    assert.equal(await doc().get(), 4);
    await doc().set(5);
    assert.equal(await doc().get(), 5);
  } finally {
    await node.close();
  }
});

test("getBookmarkForTime finds the state at a time, back to before the first write", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const node = await engine(directory, bucket, await temporaryDirectory());
  try {
    const doc = () => node.env.DOC.getByName("b");
    const before = Date.now();
    await tick();
    await doc().set("one");
    await tick();
    const afterOne = Date.now();
    await tick();
    await doc().set("two");
    await tick();
    await doc().set("three");

    await assert.rejects(doc().restore(await doc().bookmarkAt(afterOne)), /restoring/);
    assert.equal(await doc().get(), "one");
    await assert.rejects(doc().restore(await doc().bookmarkAt(new Date(before))), /restoring/);
    assert.equal(await doc().get(), null);
    // The object works after restoring to empty, and keeps working across restarts.
    await doc().set("again");
    assert.equal(await doc().get(), "again");

    await assert.rejects(doc().bookmarkAt("soon"), TypeError);
    await assert.rejects(node.env.DOC.getByName("c").restore("0000000000000001-0000000000000000"), /isn't one of this object's/);
    const other = await node.env.DOC.getByName("c").bookmark();
    await assert.rejects(doc().restore(other), /isn't one of this object's/);
  } finally {
    await node.close();
  }
});

test("a restore brings back the alarm the object had then", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const node = await engine(directory, bucket, await temporaryDirectory());
  try {
    const doc = () => node.env.DOC.getByName("d");
    await doc().setAlarmIn(60_000);
    const withAlarm = await doc().bookmark();
    await node.env.DOC.getByName("d").set("x");
    const alarm = await doc().getAlarm();
    // Deleting the alarm, then restoring, sets it again.
    await doc().clearAlarm();
    assert.equal(await doc().getAlarm(), null);
    await assert.rejects(doc().restore(withAlarm), /restoring/);
    assert.equal(await doc().getAlarm(), alarm);
  } finally {
    await node.close();
  }
});

test("history older than the retention window is deleted, and can't be restored", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  // The first writes land in the bucket two minutes ago, by its clock.
  let offset = -120_000;
  bucket.now = () => Date.now() + offset;
  const node = await engine(directory, bucket, await temporaryDirectory(), { retentionMs: 60_000, tuning: { snapshotTransactions: 2 } });
  try {
    const doc = () => node.env.DOC.getByName("e");
    for (let value = 1; value <= 6; value += 1) await doc().set(value);
    const snapshots = () => [...bucket.objects.keys()].filter((key) => key.includes("/snapshot-")).sort();
    const segments = () => [...bucket.objects.keys()].filter((key) => key.endsWith(".seg"));
    const old = snapshots();
    const oldSegments = segments().length;
    assert.ok(old.length >= 2);

    offset = 0;
    await doc().set(7);
    await node.durable.compact();
    // The newest old snapshot is the base: older ones and the log they cover go.
    assert.deepEqual(snapshots().filter((key) => old.includes(key)), [old.at(-1)]);
    assert.ok(segments().length < oldSegments, "covered segments are deleted");
    assert.equal(await doc().get(), 7);
    await assert.rejects(doc().bookmarkAt(Date.now() - 200_000), RangeError);
    // The base (its time is the bucket's backdated one) can still be restored.
    await assert.rejects(doc().restore(await doc().bookmarkAt(Date.now() - 90_000)), /restoring/);
    assert.ok([5, 6].includes(await doc().get()));
  } finally {
    await node.close();
  }
});

test("bookmarks need durable mode", async () => {
  const directory = await project();
  const node = await engine(directory, null, await temporaryDirectory(), { mode: null });
  try {
    await assert.rejects(node.env.DOC.getByName("f").bookmark(), /needs --backup-mode durable/);
  } finally {
    await node.close();
  }
});

test("a restore whose upload fails leaves the object as it was, and runs once the bucket answers", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const persist = await temporaryDirectory();
  const options = { tuning: { gateTimeoutMs: 1_000 } };
  let node = await engine(directory, bucket, persist, options);
  try {
    const doc = () => node.env.DOC.getByName("g");
    await doc().set("v1");
    const first = await doc().bookmark();
    await doc().set("v2");
    const latest = await doc().bookmark();
    bucket.failPut = (key) => key.includes("/snapshot-");
    await assert.rejects(doc().restore(first), /restoring/);
    await assert.rejects(doc().get(), /injected/);
    // Restarted while the restore is pending; compaction runs before anything opens it.
    bucket.failPut = () => false;
    await node.close();
    node = await engine(directory, bucket, persist, options);
    await node.durable.compact();
    assert.equal(await doc().get(), "v1");
    await assert.rejects(doc().restore(latest), /restoring/);
    assert.equal(await doc().get(), "v2");
  } finally {
    await node.close();
  }
});

test("a bookmark whose history the bucket no longer keeps is refused when the restore is asked for", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const node = await engine(directory, bucket, await temporaryDirectory(), { retentionMs: 0, tuning: { snapshotTransactions: 2 } });
  try {
    const doc = () => node.env.DOC.getByName("h");
    await doc().set(1);
    const old = await doc().bookmark();
    for (let value = 2; value <= 6; value += 1) await doc().set(value);
    await node.durable.compact();
    await assert.rejects(doc().restore(old), /older than the history the bucket keeps/);
    assert.equal(await doc().get(), 6);
  } finally {
    await node.close();
  }
});

test("ctx.abort() keeps the object's alarm", async () => {
  const directory = await project();
  const node = await engine(directory, new MemoryBucket(), await temporaryDirectory());
  try {
    const doc = () => node.env.DOC.getByName("i");
    await doc().setAlarmIn(300);
    await assert.rejects(doc().restore(await doc().bookmark()), /restoring/);
    for (let attempt = 0; attempt < 100 && !(await doc().alarmed()); attempt += 1) await tick();
    assert.equal(await doc().alarmed(), true);
  } finally {
    await node.close();
  }
});

test("with several nodes, a restore asked for on one node doesn't undo another node's later writes", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const persistA = await temporaryDirectory();
  let a = await engine(directory, bucket, persistA, { node: "a" });
  await a.env.DOC.getByName("x").set(1);
  const first = await a.env.DOC.getByName("x").bookmark();
  await a.env.DOC.getByName("x").set(2);
  // Asked for, but a stops before the object restarts on it.
  await a.env.DOC.getByName("x").restore(first, false);
  await a.close();
  const b = await engine(directory, bucket, await temporaryDirectory(), { node: "b" });
  await b.env.DOC.getByName("x").set(3);
  await b.close();
  a = await engine(directory, bucket, persistA, { node: "a" });
  try {
    assert.equal(await a.env.DOC.getByName("x").get(), 3);
  } finally {
    await a.close();
  }
});

test("a restore snapshot left behind by a failed attempt never shadows later writes", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const persist = await temporaryDirectory();
  const node = await engine(directory, bucket, persist, { retentionMs: 0, tuning: { gateTimeoutMs: 1_000, snapshotTransactions: 2 } });
  try {
    const doc = () => node.env.DOC.getByName("j");
    await doc().set("v1");
    const first = await doc().bookmark();
    await doc().set("v2");
    await doc().set("v3");
    // The restore's snapshot lands, but its response is lost.
    bucket.ghostPut = (key) => key.includes("/snapshot-");
    await assert.rejects(doc().restore(first), /restoring/);
    await assert.rejects(doc().get(), /timed out/);
    bucket.ghostPut = () => false;
    // Compaction removes the bookmark's history, so the retry drops the restore.
    await node.durable.compact();
    assert.equal(await doc().get(), "v3");
    await doc().set("v4");
  } finally {
    await node.close();
  }
  // A lost disk rebuilds the object with the acknowledged write.
  const rebuilt = await engine(directory, bucket, await temporaryDirectory());
  try {
    assert.equal(await rebuilt.env.DOC.getByName("j").get(), "v4");
  } finally {
    await rebuilt.close();
  }
});

test("ctx.abort() inside an alarm handler resets the object, and the alarm runs again", async () => {
  const directory = await project();
  const node = await engine(directory, new MemoryBucket(), await temporaryDirectory());
  try {
    const doc = () => node.env.DOC.getByName("k");
    await doc().abortInAlarm(50);
    for (let attempt = 0; attempt < 200 && !(await doc().alarmed()); attempt += 1) await tick();
    assert.equal(await doc().alarmed(), true);
  } finally {
    await node.close();
  }
});
