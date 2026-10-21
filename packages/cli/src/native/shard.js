// One engine thread (--threads): a NativeEngine that runs the objects whose
// IDs map to this shard, the Worker's fetch handler for requests the main
// thread hands it, and calls from other shards for its objects.
import { parentPort, workerData } from "node:worker_threads";
import { NativeEngine } from "./engine.js";
import { servePeerRequest } from "./objects.js";
import { PortChannel, decodeRequest, encodeResponse } from "./ports.js";
import { S3Client } from "./s3.js";

const { config, persistDirectory, idleEvictMs, drainMs, backup, index, count } = workerData;
const peers = new Map();
let engine;

const main = new PortChannel(parentPort, async (type, payload) => {
  if (type === "peer") {
    peers.get(payload.index)?.close();
    peers.set(payload.index, new PortChannel(payload.port, async (peerType, peerPayload) => {
      await started;
      return servePeerRequest(engine, peerType, peerPayload);
    }).unref());
    return;
  }
  if (type === "peer-down") {
    peers.get(payload.index)?.close(new Error(`Engine thread ${payload.index} restarted; retry the call.`));
    peers.delete(payload.index);
    return;
  }
  await started;
  if (type === "ping") return "pong";
  if (type === "fetch") return encodeResponse(await engine.fetch(decodeRequest(payload.request)));
  if (type === "close") {
    await engine.close();
    for (const peer of peers.values()) peer.close();
    setImmediate(() => main.close());
    return null;
  }
  throw new Error(`Unknown request ${type}`);
});

let backupOptions;
if (backup) {
  const { client, prefix } = S3Client.fromEnvironment({ bucketUri: backup.bucketUri });
  backupOptions = { client, prefix, intervalMs: backup.intervalMs, mode: backup.mode };
}
engine = new NativeEngine({
  config,
  persistDirectory,
  idleEvictMs,
  drainMs,
  backup: backupOptions,
  log: (message) => main.post("log", `[thread ${index}] ${message}`),
  shard: {
    index,
    count,
    peer: (owner) => {
      const peer = peers.get(owner);
      if (!peer) throw new Error(`Engine thread ${owner} is not running; retry the call.`);
      return peer;
    },
  },
});
const started = engine.start();
started.then(
  () => main.post("ready", { restored: engine.restoredObjects }),
  (error) => main.post("failed", { message: String(error?.stack ?? error) }),
);
