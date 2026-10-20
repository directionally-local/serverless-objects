// `sobjects dev --engine native`: run a project on the native engine.
import { resolve } from "node:path";

export const nativeDevHelp = `Usage: sobjects dev [project] --engine native [--port PORT] [--host HOST] [--persist-to DIR] [--idle-evict-seconds N]
       [--backup-bucket s3://BUCKET/PREFIX] [--backup-mode interval|durable] [--backup-interval-seconds N]
       [--threads N] [--thread-stall-seconds N] [--thread-memory-mb N]
       [--node-name NAME] [--lease-seconds N]

Run a Wrangler project's Worker and Durable Objects in this Node process, with
each object's storage in a SQLite file under --persist-to (default:
<project>/.sobjects/native). For trusted code: there is no isolate between the
app and the engine. Supported: Durable Objects (IDs, RPC, fetch, KV and SQL
storage, transactions, alarms, input gates, WebSockets with the hibernation API)
and vars. An object idle for --idle-evict-seconds (default 60; 0 never) is
evicted; its hibernatable WebSockets stay open and wake it again.

With --backup-bucket, each object's SQLite file is copied to an S3-compatible
bucket within --backup-interval-seconds (default 10) of a change and when the
engine stops, and objects missing locally are restored from it on start.
Credentials come from AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and optionally
AWS_SESSION_TOKEN; set S3_ENDPOINT for R2 or another S3-compatible store, and
AWS_REGION if needed. Changes made since the last upload are lost if the disk
is lost. One node per bucket prefix: a node that finds another node's newer
copy stops backing that object up.

--backup-mode durable instead holds each event's result until the writes it
made are in the bucket (an output gate, as on Cloudflare), so losing the disk
loses nothing that was acknowledged. Writes from all objects are uploaded
together, one bucket PUT per flush; each write waits for one. The store must
support conditional writes (If-None-Match), as S3, R2 and MinIO do.

With --threads N, the Worker and its objects run on N worker threads: each
object lives on one thread (chosen by its ID), and requests are spread across
them. A thread that crashes, exceeds --thread-memory-mb, or doesn't answer for
--thread-stall-seconds (default 30) is replaced, and its objects reload from
disk; calls in flight on it fail. Threads use more cores and keep a busy or
stuck object from blocking objects on other threads. They are not a security
boundary.

With --node-name (and --backup-mode durable), this node is one of several
sharing the bucket prefix. Each object runs on one node at a time: a node
claims an object when it first serves it, and takes over the objects of a
node whose lease (--lease-seconds, default 10) ran out, restoring them from
the bucket. A node that can't renew its lease stops acknowledging writes.
Names must be unique and stable per node. Calls for an object another live
node runs fail for now; forwarding between nodes comes next.`;

export function wantsNativeEngine(args) {
  return args.some((argument, index) => argument === "--engine=native" || (argument === "--engine" && args[index + 1] === "native"));
}

export function parseNativeDevArgs(args, cwd) {
  const options = { project: ".", port: 8787, host: "127.0.0.1", persistTo: undefined, idleEvictSeconds: 60, backupBucket: undefined, backupMode: "interval", backupIntervalSeconds: 10, threads: 0, threadStallSeconds: 30, threadMemoryMb: undefined, nodeName: undefined, leaseSeconds: 10 };
  let sawProject = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Option ${argument} requires a value.`);
      index += 1;
      return next;
    };
    if (argument === "--engine") value();
    else if (argument === "--engine=native") continue;
    else if (argument === "--port") options.port = Number(value());
    else if (argument === "--host" || argument === "--ip") options.host = value();
    else if (argument === "--persist-to") options.persistTo = value();
    else if (argument === "--idle-evict-seconds") options.idleEvictSeconds = Number(value());
    else if (argument === "--backup-bucket") options.backupBucket = value();
    else if (argument === "--backup-interval-seconds") options.backupIntervalSeconds = Number(value());
    else if (argument === "--backup-mode") options.backupMode = value();
    else if (argument === "--threads") options.threads = Number(value());
    else if (argument === "--node-name") options.nodeName = value();
    else if (argument === "--lease-seconds") options.leaseSeconds = Number(value());
    else if (argument === "--thread-stall-seconds") options.threadStallSeconds = Number(value());
    else if (argument === "--thread-memory-mb") options.threadMemoryMb = Number(value());
    else if (!argument.startsWith("-") && !sawProject) {
      options.project = argument;
      sawProject = true;
    } else throw new Error(`Unknown option for the native engine: ${argument}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error("--port must be an integer from 0 to 65535.");
  if (!Number.isFinite(options.idleEvictSeconds) || options.idleEvictSeconds < 0) throw new Error("--idle-evict-seconds must be 0 or more.");
  if (!Number.isFinite(options.backupIntervalSeconds) || options.backupIntervalSeconds < 1) throw new Error("--backup-interval-seconds must be 1 or more.");
  if (!["interval", "durable"].includes(options.backupMode)) throw new Error("--backup-mode must be interval or durable.");
  if (!Number.isInteger(options.threads) || options.threads < 0 || options.threads > 256) throw new Error("--threads must be an integer from 0 to 256.");
  if (!Number.isFinite(options.threadStallSeconds) || options.threadStallSeconds < 1) throw new Error("--thread-stall-seconds must be 1 or more.");
  if (options.threadMemoryMb !== undefined && (!Number.isInteger(options.threadMemoryMb) || options.threadMemoryMb < 16)) throw new Error("--thread-memory-mb must be an integer of 16 or more.");
  if (!Number.isFinite(options.leaseSeconds) || options.leaseSeconds < 3) throw new Error("--lease-seconds must be 3 or more.");
  if (options.nodeName !== undefined && (options.backupMode !== "durable" || !options.backupBucket)) throw new Error("--node-name needs --backup-bucket with --backup-mode durable.");
  if (options.nodeName !== undefined && options.threads > 0) throw new Error("--node-name can't be combined with --threads yet.");
  const project = resolve(cwd, options.project);
  return { ...options, project, persistTo: resolve(cwd, options.persistTo ?? resolve(project, ".sobjects", "native")) };
}

export async function runNativeDev(args, io, { cwd, onSignal, env = process.env }) {
  if (args.includes("--help") || args.includes("-h")) {
    io.log(nativeDevHelp);
    return 0;
  }
  let options;
  let engine;
  try {
    options = parseNativeDevArgs(args, cwd);
    // Loaded on demand: node:sqlite prints an experimental warning when imported.
    const { NativeEngine, loadProjectConfig } = await import("./engine.js");
    const config = await loadProjectConfig(options.project);
    const log = (message) => io.error(message);
    const common = { config, persistDirectory: options.persistTo, idleEvictMs: options.idleEvictSeconds * 1000, log };
    if (options.threads > 0) {
      const { ThreadedEngine } = await import("./threads.js");
      if (options.backupBucket) {
        // Checked here so a bad URI or missing credentials fail before threads start.
        const { S3Client } = await import("./s3.js");
        S3Client.fromEnvironment({ bucketUri: options.backupBucket, env });
      }
      engine = new ThreadedEngine({
        ...common,
        threads: options.threads,
        env,
        stallMs: options.threadStallSeconds * 1000,
        memoryMb: options.threadMemoryMb,
        backup: options.backupBucket ? { bucketUri: options.backupBucket, intervalMs: options.backupIntervalSeconds * 1000, mode: options.backupMode } : undefined,
      });
    } else {
      let backup;
      if (options.backupBucket) {
        const { S3Client } = await import("./s3.js");
        const { client, prefix } = S3Client.fromEnvironment({ bucketUri: options.backupBucket, env });
        backup = { client, prefix, intervalMs: options.backupIntervalSeconds * 1000, mode: options.backupMode };
      }
      const cluster = options.nodeName ? { name: options.nodeName, ttlMs: options.leaseSeconds * 1000, onFence: () => {
        io.error("Stopping: this node lost its lease, and another node may now run its objects.");
        process.exit(3);
      } } : undefined;
      engine = new NativeEngine({ ...common, backup, cluster });
    }
    await engine.start();
    const address = await engine.listen({ host: options.host, port: options.port });
    if (engine.restoredObjects) io.log(`Restored ${engine.restoredObjects} object(s) from ${options.backupBucket}`);
    io.log(`Native engine ready on http://${address.address}:${address.port} (state: ${options.persistTo}${options.backupBucket ? `, backups: ${options.backupBucket} (${options.backupMode})` : ""}${options.threads ? `, threads: ${options.threads}` : ""}${options.nodeName ? `, node: ${options.nodeName}` : ""})`);
  } catch (error) {
    io.error(error.message);
    await engine?.close().catch(() => {});
    return 1;
  }
  return new Promise((resolveExit) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await engine.close();
      resolveExit(0);
    };
    onSignal("SIGINT", stop);
    onSignal("SIGTERM", stop);
  });
}
