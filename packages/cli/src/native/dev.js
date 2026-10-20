// `sobjects dev --engine native`: run a project on the native engine.
import { resolve } from "node:path";

export const nativeDevHelp = `Usage: sobjects dev [project] --engine native [--port PORT] [--host HOST] [--persist-to DIR] [--idle-evict-seconds N]
       [--backup-bucket s3://BUCKET/PREFIX] [--backup-interval-seconds N]

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
copy stops backing that object up.`;

export function wantsNativeEngine(args) {
  return args.some((argument, index) => argument === "--engine=native" || (argument === "--engine" && args[index + 1] === "native"));
}

export function parseNativeDevArgs(args, cwd) {
  const options = { project: ".", port: 8787, host: "127.0.0.1", persistTo: undefined, idleEvictSeconds: 60, backupBucket: undefined, backupIntervalSeconds: 10 };
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
    else if (!argument.startsWith("-") && !sawProject) {
      options.project = argument;
      sawProject = true;
    } else throw new Error(`Unknown option for the native engine: ${argument}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error("--port must be an integer from 0 to 65535.");
  if (!Number.isFinite(options.idleEvictSeconds) || options.idleEvictSeconds < 0) throw new Error("--idle-evict-seconds must be 0 or more.");
  if (!Number.isFinite(options.backupIntervalSeconds) || options.backupIntervalSeconds < 1) throw new Error("--backup-interval-seconds must be 1 or more.");
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
    let backup;
    if (options.backupBucket) {
      const { S3Client } = await import("./s3.js");
      const { client, prefix } = S3Client.fromEnvironment({ bucketUri: options.backupBucket, env });
      backup = { client, prefix, intervalMs: options.backupIntervalSeconds * 1000 };
    }
    engine = new NativeEngine({ config, persistDirectory: options.persistTo, idleEvictMs: options.idleEvictSeconds * 1000, backup, log: (message) => io.error(message) });
    await engine.start();
    const address = await engine.listen({ host: options.host, port: options.port });
    if (engine.backup?.restored) io.log(`Restored ${engine.backup.restored} object(s) from ${options.backupBucket}`);
    io.log(`Native engine ready on http://${address.address}:${address.port} (state: ${options.persistTo}${options.backupBucket ? `, backups: ${options.backupBucket}` : ""})`);
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
