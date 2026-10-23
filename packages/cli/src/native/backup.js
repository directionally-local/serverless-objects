// Bucket backups for the native engine. Each object's SQLite file is copied
// to an S3-compatible bucket (VACUUM INTO, then one PUT) a few seconds after
// it changes and when its host closes; on start, objects missing from local
// disk are restored from the bucket. Writes since the last upload are lost if
// the disk is lost, so the recovery point is the backup interval plus the
// upload time; the local file stays the source of truth while the node runs.
//
// Layout: <prefix>/native/<script>/<class>/<id>.sqlite. Uploads are
// conditional on the ETag this node last saw, so a second node writing the
// same objects is detected and refused rather than silently overwritten.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { isClassName } from "./ids.js";

export class BucketBackup {
  #client;
  #root;
  #tempDirectory;
  #intervalMs;
  #log;
  #etags = new Map();
  #changes = new WeakMap();
  #uploads = new Map();
  #fenced = new Set();
  #attempted = new Map();
  #timer;
  #sequence = 0;
  uploaded = 0;
  restored = 0;

  constructor({ client, prefix, scriptName, tempDirectory, intervalMs = 10_000, log = () => {} }) {
    this.#client = client;
    this.#root = [prefix, "native", scriptName].filter(Boolean).join("/");
    this.#tempDirectory = tempDirectory;
    this.#intervalMs = intervalMs;
    this.#log = log;
  }

  key(className, id) {
    return `${this.#root}/${className}/${id}.sqlite`;
  }

  // Downloads every backed-up object that has no local file and records its
  // pending alarm, so it fires as if the object had always been here.
  // owns(id) limits it to one thread's objects (--threads).
  async restore(objectsDirectory, alarmIndex, owns = () => true) {
    for (const { key, etag } of await this.#client.list(`${this.#root}/`)) {
      const match = /^([^/]+)\/([0-9a-f]{64})\.sqlite$/.exec(key.slice(this.#root.length + 1));
      if (!match) continue;
      const [, className, id] = match;
      // The class becomes a directory under objectsDirectory: never "..".
      if (!isClassName(className) || !owns(id)) continue;
      this.#etags.set(key, etag);
      const path = join(objectsDirectory, className, `${id}.sqlite`);
      if (existsSync(path)) continue;
      const object = await this.#client.get(key);
      if (!object) continue;
      mkdirSync(join(objectsDirectory, className), { recursive: true });
      writeFileSync(`${path}.restore`, object.body);
      const db = new DatabaseSync(`${path}.restore`);
      let alarm;
      try {
        alarm = db.prepare("SELECT value FROM _cf_METADATA WHERE key = 'alarm'").get()?.value ?? null;
      } finally {
        db.close();
      }
      renameSync(`${path}.restore`, path);
      this.#etags.set(key, object.etag ?? etag);
      if (alarm !== null) alarmIndex.set(className, id, Number(alarm));
      this.restored += 1;
    }
  }

  // Backs up changed objects every interval. hosts() lists the live hosts.
  start(hosts) {
    mkdirSync(this.#tempDirectory, { recursive: true });
    this.#timer = setInterval(() => {
      for (const host of hosts()) this.capture(host);
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  // Copies the object's database if it changed since the last copy, and
  // queues the upload. Synchronous, so a host can call it just before closing.
  capture(host) {
    const { className, id, database } = host.backupSource();
    const changes = database.changes();
    if (this.#changes.get(database) === changes) return;
    const key = this.key(className, id);
    if (this.#fenced.has(key)) return;
    const path = join(this.#tempDirectory, `${process.pid}-${threadId}-${(this.#sequence += 1)}.sqlite`);
    try {
      database.snapshotTo(path);
    } catch (error) {
      // An open transaction blocks VACUUM INTO; the next interval tries again.
      rmSync(path, { force: true });
      if (!/transaction/i.test(String(error?.message))) this.#log(`backup of ${className} ${id} failed: ${error?.message ?? error}`);
      return;
    }
    this.#changes.set(database, changes);
    const body = readFileSync(path);
    rmSync(path, { force: true });
    const previous = this.#uploads.get(key) ?? Promise.resolve();
    const upload = previous.then(() => this.#upload(key, body, () => this.#changes.delete(database)));
    this.#uploads.set(key, upload);
    upload.then(() => {
      if (this.#uploads.get(key) === upload) this.#uploads.delete(key);
    });
  }

  // Captures the live hosts and waits for every queued upload.
  async flush(hosts = []) {
    for (const host of hosts) this.capture(host);
    await Promise.all(this.#uploads.values());
  }

  async close(hosts = []) {
    clearInterval(this.#timer);
    await this.flush(hosts);
  }

  async #upload(key, body, retryLater) {
    if (this.#fenced.has(key)) return;
    const etag = this.#etags.get(key);
    // Remembered until an upload is confirmed: a failed one may still have landed.
    const attempts = this.#attempted.get(key) ?? [];
    this.#attempted.set(key, [...attempts.slice(-2), body]);
    try {
      const next = await this.#client.put(key, body, etag ? { ifMatch: etag } : { ifNoneMatch: "*" });
      if (next === null) {
        // An earlier upload that failed (a 500 or a timeout) may have landed
        // anyway: if the bucket holds a copy this node uploaded, carry on from it.
        const current = await this.#client.get(key);
        const ours = current && this.#attempted.get(key)?.some((attempt) => Buffer.compare(attempt, current.body) === 0);
        if (!ours) {
          this.#fenced.add(key);
          this.#log(`backup of ${key} stopped: another node changed it in the bucket. Only one node may run these objects.`);
          return;
        }
        this.#etags.set(key, current.etag);
        if (Buffer.compare(current.body, body) !== 0) {
          retryLater();
          return;
        }
        this.uploaded += 1;
        this.#attempted.delete(key);
        return;
      }
      this.#etags.set(key, next);
      this.#attempted.delete(key);
      this.uploaded += 1;
    } catch (error) {
      retryLater();
      this.#log(`backup upload of ${key} failed, will retry: ${error?.message ?? error}`);
    }
  }
}
