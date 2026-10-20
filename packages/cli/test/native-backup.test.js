import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NativeEngine, loadProjectConfig } from "../src/native/engine.js";
import { parseNativeDevArgs } from "../src/native/dev.js";
import { S3Client, parseBucketUri } from "../src/native/s3.js";

const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-backup-"));
  directories.push(directory);
  return directory;
}

// An S3 bucket in memory with conditional PUTs, shaped like S3Client.
class MemoryBucket {
  objects = new Map();
  #version = 0;

  async list(prefix) {
    return [...this.objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, { etag, body }]) => ({ key, etag, size: body.length }));
  }

  async get(key) {
    const object = this.objects.get(key);
    return object ? { body: Buffer.from(object.body), etag: object.etag } : null;
  }

  async put(key, body, { ifMatch, ifNoneMatch } = {}) {
    const current = this.objects.get(key);
    if (ifNoneMatch === "*" && current) return null;
    if (ifMatch && current?.etag !== ifMatch) return null;
    const etag = `"${(this.#version += 1)}"`;
    this.objects.set(key, { body: Buffer.from(body), etag });
    return etag;
  }
}

const APP = `
import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async add(amount) {
    const value = (this.ctx.storage.kv.get("value") ?? 0) + amount;
    this.ctx.storage.kv.put("value", value);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS log (amount INTEGER)");
    this.ctx.storage.sql.exec("INSERT INTO log VALUES (?)", amount);
    return value;
  }
  async read() {
    return { value: this.ctx.storage.kv.get("value") ?? 0, rows: this.ctx.storage.sql.exec("SELECT count(*) AS n FROM log").one().n, fired: this.ctx.storage.kv.get("fired") ?? false };
  }
  async later(ms) {
    await this.ctx.storage.setAlarm(Date.now() + ms);
  }
  async alarm() {
    this.ctx.storage.kv.put("fired", true);
  }
}
export default { fetch: () => new Response("ok") };
`;

async function project() {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/index.js"), APP);
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({
    name: "backup-app",
    main: "src/index.js",
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
  }));
  return directory;
}

async function engineFor(directory, bucket, { intervalMs = 60_000, logs = [] } = {}) {
  const engine = new NativeEngine({
    config: await loadProjectConfig(directory),
    persistDirectory: await temporaryDirectory(),
    idleEvictMs: 0,
    backup: { client: bucket, prefix: "nodes/a", intervalMs },
    log: (message) => logs.push(message),
  });
  await engine.start();
  return engine;
}

async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("objects are backed up on change and restored onto an empty disk, alarms included", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const first = await engineFor(directory, bucket, { intervalMs: 50 });
  await first.env.COUNTER.getByName("a").add(2);
  await first.env.COUNTER.getByName("a").add(3);
  await first.env.COUNTER.getByName("b").add(1);
  await until(() => first.backup.uploaded >= 2);
  const keys = [...bucket.objects.keys()];
  assert.equal(keys.length, 2);
  assert.ok(keys.every((key) => /^nodes\/a\/native\/backup-app\/Counter\/[0-9a-f]{64}\.sqlite$/.test(key)));
  // Unchanged objects are not uploaded again.
  const uploaded = first.backup.uploaded;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(first.backup.uploaded, uploaded);
  await first.env.COUNTER.getByName("b").later(300);
  await first.close();

  // A new node with an empty disk gets the objects, its data and its pending alarm.
  const second = await engineFor(directory, bucket);
  try {
    assert.equal(second.backup.restored, 2);
    assert.deepEqual(await second.env.COUNTER.getByName("a").read(), { value: 5, rows: 2, fired: false });
    await until(async () => (await second.env.COUNTER.getByName("b").read()).fired);
  } finally {
    await second.close();
  }
});

test("a node stops backing up an object another node has changed in the bucket", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const logs = [];
  const node = await engineFor(directory, bucket, { logs });
  try {
    await node.env.COUNTER.getByName("a").add(1);
    await node.backup.flush([...node.namespaces[0].hosts()]);
    const [key] = bucket.objects.keys();
    await bucket.put(key, Buffer.from("someone else"));
    await node.env.COUNTER.getByName("a").add(1);
    await node.backup.flush([...node.namespaces[0].hosts()]);
    assert.equal(bucket.objects.get(key).body.toString(), "someone else");
    assert.ok(logs.some((line) => line.includes("another node changed it")));
  } finally {
    await node.close();
  }
});

test("the S3 client signs requests, sends conditions and parses listings", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), ...init });
    if (init.method === "PUT") return new Response(null, { status: init.headers["if-none-match"] ? 412 : 200, headers: { etag: '"e1"' } });
    return new Response(`<ListBucketResult><Contents><Key>p/a&amp;b.sqlite</Key><ETag>&quot;e1&quot;</ETag><Size>3</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`);
  };
  const { client, prefix } = S3Client.fromEnvironment({
    bucketUri: "s3://my-bucket/p",
    env: { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "secret", S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/", AWS_REGION: "auto" },
    fetchImpl,
    now: () => new Date("2026-10-20T00:00:00Z"),
  });
  assert.equal(prefix, "p");
  assert.equal(await client.put("p/x y.sqlite", "abc", { ifNoneMatch: "*" }), null);
  assert.equal(await client.put("p/x y.sqlite", "abc", { ifMatch: '"e0"' }), '"e1"');
  assert.deepEqual(await client.list("p/"), [{ key: "p/a&b.sqlite", etag: '"e1"', size: 3 }]);
  assert.equal(requests[0].url, "https://acct.r2.cloudflarestorage.com/my-bucket/p/x%20y.sqlite");
  assert.match(requests[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20261020\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(requests[2].url, "https://acct.r2.cloudflarestorage.com/my-bucket?list-type=2&prefix=p%2F");
  assert.throws(() => parseBucketUri("gs://nope"), /expected s3:\/\//);
  assert.throws(() => S3Client.fromEnvironment({ bucketUri: "s3://my-bucket", env: {} }), /credentials are missing/);
});

test("native dev parses the backup options", () => {
  const options = parseNativeDevArgs(["--engine", "native", "--backup-bucket", "s3://b/x", "--backup-interval-seconds", "5"], "/tmp");
  assert.equal(options.backupBucket, "s3://b/x");
  assert.equal(options.backupIntervalSeconds, 5);
  assert.throws(() => parseNativeDevArgs(["--backup-interval-seconds", "0"], "/tmp"), /1 or more/);
});
