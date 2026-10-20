// The native engine across worker threads (sobjects dev --engine native
// --threads N). The main thread serves HTTP and hands each request to a
// thread in turn; each thread owns the objects whose IDs map to it, and a
// stub for an object on another thread relays the call there. A thread that
// crashes, runs out of memory or stops answering is replaced; its objects
// reload from their SQLite files on the next call.
//
// Threads keep one app's objects off each other's event loop and use more
// than one core. They are not a security boundary: all threads run the same
// trusted code in one process.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { MessageChannel, Worker } from "node:worker_threads";
import { join } from "node:path";
import { toRequest } from "./engine.js";
import { AlarmIndex } from "./objects.js";
import { PortChannel, RemoteEnd, encodeRequest } from "./ports.js";
import { connect } from "./websocket.js";

const SHARD_URL = new URL("./shard.js", import.meta.url);
const PING_MS = 1_000;
const RESTART_WINDOW_MS = 60_000;
const RESTARTS_PER_WINDOW = 5;
const RESTART_BACKOFF_MS = 5_000;

export class ThreadedEngine {
  #shards = [];
  #next = 0;
  #closing = false;
  #pinger;
  restarts = 0;

  // threads: how many; stallMs: replace a thread that hasn't answered a ping
  // for this long; memoryMb: each thread's heap limit; backup: { bucketUri,
  // intervalMs } (credentials come from the environment, as for one thread).
  constructor({ config, persistDirectory, threads, idleEvictMs = 60_000, backup, stallMs = 30_000, memoryMb, env = process.env, log = (message) => console.error(message) }) {
    this.env = env;
    if (!Number.isInteger(threads) || threads < 1) throw new Error("threads must be a positive integer.");
    this.config = config;
    this.persistDirectory = persistDirectory;
    this.threads = threads;
    this.idleEvictMs = idleEvictMs;
    this.backup = backup;
    this.stallMs = stallMs;
    this.memoryMb = memoryMb;
    this.log = log;
    this.restoredObjects = 0;
  }

  async start() {
    mkdirSync(this.persistDirectory, { recursive: true });
    // Created here once: threads opening a new index together would race to set WAL mode.
    new AlarmIndex(join(this.persistDirectory, "alarms.sqlite")).close();
    const ready = [];
    for (let index = 0; index < this.threads; index += 1) ready.push(this.#spawn(index));
    const results = await Promise.allSettled(ready);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      await this.close();
      throw failed.reason;
    }
    this.restoredObjects = results.reduce((sum, result) => sum + result.value.restored, 0);
    for (let index = 0; index < this.threads; index += 1) this.#connectPeers(index, index + 1);
    this.#pinger = setInterval(() => this.#checkHealth(), PING_MS);
    this.#pinger.unref();
  }

  // Starts thread `index` and resolves once its engine is ready.
  #spawn(index) {
    const worker = new Worker(SHARD_URL, {
      workerData: {
        config: this.config,
        persistDirectory: this.persistDirectory,
        idleEvictMs: this.idleEvictMs,
        backup: this.backup,
        index,
        count: this.threads,
      },
      env: this.env,
      // The main thread already printed node:sqlite's experimental warning.
      // (Not inherited: some of the main thread's flags are invalid for workers.)
      execArgv: ["--disable-warning=ExperimentalWarning"],
      ...(this.memoryMb ? { resourceLimits: { maxOldGenerationSizeMb: this.memoryMb } } : {}),
    });
    const previous = this.#shards[index];
    const shard = { index, worker, ready: false, lastPong: Date.now(), restartTimes: previous?.restartTimes ?? [] };
    this.#shards[index] = shard;
    return new Promise((resolve, reject) => {
      shard.channel = new PortChannel(worker, async (type, payload) => {
        if (type === "log") this.log(payload);
        else if (type === "ready") {
          shard.ready = true;
          shard.lastPong = Date.now();
          resolve(payload);
        } else if (type === "failed") reject(new Error(payload.message));
      });
      worker.on("error", (error) => {
        this.log(`engine thread ${index} failed: ${error?.stack ?? error}`);
        reject(error);
      });
      worker.on("exit", (code) => {
        shard.channel.close(new Error(`Engine thread ${index} exited.`));
        if (this.#closing || this.#shards[index] !== shard) return;
        reject(new Error(`Engine thread ${index} exited with code ${code} while starting.`));
        if (shard.ready) this.#replace(index, `exited with code ${code}`);
      });
    });
  }

  // Gives thread `index` a port to every other ready thread from `from` on
  // (all of them after a restart).
  #connectPeers(index, from = 0) {
    for (let other = from; other < this.threads; other += 1) {
      if (other === index || !this.#shards[other]?.ready) continue;
      const { port1, port2 } = new MessageChannel();
      this.#shards[index].channel.post("peer", { index: other, port: port1 }, [port1]);
      this.#shards[other].channel.post("peer", { index, port: port2 }, [port2]);
    }
  }

  async #replace(index, reason) {
    const shard = this.#shards[index];
    if (this.#closing || shard.replacing) return;
    shard.replacing = true;
    shard.ready = false;
    this.restarts += 1;
    this.log(`engine thread ${index} ${reason}; starting a new one`);
    for (const other of this.#shards) if (other !== shard && other.ready) other.channel.post("peer-down", { index });
    await shard.worker.terminate().catch(() => {});
    const now = Date.now();
    shard.restartTimes = [...shard.restartTimes.filter((at) => now - at < RESTART_WINDOW_MS), now];
    if (shard.restartTimes.length > RESTARTS_PER_WINDOW) await new Promise((resolve) => setTimeout(resolve, RESTART_BACKOFF_MS));
    if (this.#closing) return;
    try {
      await this.#spawn(index);
      this.#connectPeers(index);
    } catch (error) {
      this.log(`engine thread ${index} did not restart: ${error?.message ?? error}`);
      this.#shards[index].replacing = false;
      setTimeout(() => this.#replace(index, "failed to start"), RESTART_BACKOFF_MS).unref();
    }
  }

  #checkHealth() {
    for (const shard of this.#shards) {
      if (!shard?.ready) continue;
      if (Date.now() - shard.lastPong > this.stallMs) {
        void this.#replace(shard.index, `did not answer for ${Math.round(this.stallMs / 1000)}s`);
        continue;
      }
      shard.channel.request("ping").then(() => (shard.lastPong = Date.now()), () => {});
    }
  }

  // The Worker's fetch handler runs on the threads in turn.
  #pick() {
    for (let attempt = 0; attempt < this.threads; attempt += 1) {
      const shard = this.#shards[this.#next++ % this.threads];
      if (shard?.ready) return shard;
    }
    throw new Error("No engine thread is running.");
  }

  async fetchEncoded(request) {
    const { value, transfer } = encodeRequest(request);
    return this.#pick().channel.request("fetch", { request: value }, transfer);
  }

  listen({ host = "127.0.0.1", port = 8787 } = {}) {
    this.server = createServer((req, res) => void this.#serve(req, res));
    this.server.on("upgrade", (req, socket, head) => void this.#upgrade(req, socket, head));
    return new Promise((resolveListen, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolveListen(this.server.address());
      });
    });
  }

  async #serve(req, res) {
    try {
      const response = await this.fetchEncoded(toRequest(req, req.method !== "GET" && req.method !== "HEAD"));
      if (response.status === 101) throw new TypeError("A 101 response needs a WebSocket upgrade request.");
      res.writeHead(response.status, response.statusText, toNodeHeaders(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (error) {
      this.log(`request failed: ${error?.stack ?? error}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`Worker threw: ${error?.message ?? error}\n`);
    }
  }

  async #upgrade(req, socket, head) {
    socket.on("error", () => {});
    try {
      const request = toRequest(req, false);
      const response = await this.fetchEncoded(request);
      if (response.status === 101 && response.webSocket) {
        return connect(socket, head, request, { headers: new Headers(response.headers), webSocket: new RemoteEnd(response.webSocket) });
      }
      const body = response.body ? Buffer.from(await new Response(response.body).arrayBuffer()) : Buffer.alloc(0);
      socket.end(`HTTP/1.1 ${response.status} ${response.statusText || "Error"}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    } catch (error) {
      this.log(`upgrade failed: ${error?.stack ?? error}`);
      socket.end("HTTP/1.1 500 Internal Server Error\r\nconnection: close\r\n\r\n");
    }
  }

  async close() {
    this.#closing = true;
    clearInterval(this.#pinger);
    await new Promise((resolveClose) => (this.server ? this.server.close(() => resolveClose()) : resolveClose()));
    // Each thread closes its objects and flushes its backups before it stops.
    await Promise.all(this.#shards.map(async (shard) => {
      if (!shard) return;
      if (shard.ready) {
        await Promise.race([shard.channel.request("close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 30_000).unref())]);
      }
      await shard.worker.terminate().catch(() => {});
    }));
  }
}

function toNodeHeaders(entries) {
  const headers = {};
  const cookies = [];
  for (const [name, value] of entries) {
    if (name === "set-cookie") cookies.push(value);
    else headers[name] = value;
  }
  if (cookies.length) headers["set-cookie"] = cookies;
  return headers;
}
