// Side-by-side benchmark: the same app (bench-app/) on Wrangler, celld, the
// native engine, or any URL (a Worker deployed to Cloudflare). Every number
// is measured by this client, so a remote target includes the network; the
// noop row is the Worker-only baseline to subtract.
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startTarget, stopTarget, waitForServer } from "./run.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(PACKAGE_DIR, "bench-app");
const DEFAULT_CELLD_BIN = path.join(process.env.HOME ?? "", ".local/share/serverless-objects/engines/celld-0.6.2/celld");

export function parseBenchArgs(args) {
  const options = { target: "native", url: undefined, port: 9877, requests: 500, concurrency: 32, durationMs: 5_000, timeoutMs: 60_000, json: false, celldBin: process.env.CELLD_BIN ?? DEFAULT_CELLD_BIN };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--target") options.target = value();
    else if (arg === "--url") options.url = value().replace(/\/+$/, "");
    else if (arg === "--port") options.port = Number(value());
    else if (arg === "--requests") options.requests = Number(value());
    else if (arg === "--concurrency") options.concurrency = Number(value());
    else if (arg === "--duration") options.durationMs = Number(value());
    else if (arg === "--celld-bin") options.celldBin = value();
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (options.url) options.target = "url";
  if (!["wrangler", "celld", "native", "url"].includes(options.target)) throw new Error("--target must be wrangler, celld or native (or pass --url)");
  for (const name of ["requests", "concurrency", "durationMs"]) {
    if (!Number.isInteger(options[name]) || options[name] < 1) throw new Error(`--${name === "durationMs" ? "duration" : name} must be a positive integer`);
  }
  return options;
}

export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) };
}

async function timed(url) {
  const started = performance.now();
  const response = await fetch(url);
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return performance.now() - started;
}

async function latency(base, route, requests) {
  for (let index = 0; index < Math.min(20, requests); index += 1) await timed(`${base}${route}`);
  const samples = [];
  for (let index = 0; index < requests; index += 1) samples.push(await timed(`${base}${route}`));
  return summarize(samples);
}

// Requests per second with `concurrency` requests in flight; routeFor(i)
// picks each worker's route (one object, or one object per worker).
async function throughput(base, routeFor, concurrency, durationMs) {
  const deadline = performance.now() + durationMs;
  let completed = 0;
  let failed = 0;
  const samples = [];
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    while (performance.now() < deadline) {
      try {
        samples.push(await timed(`${base}${routeFor(worker)}`));
        completed += 1;
      } catch {
        failed += 1;
      }
    }
  }));
  return { rps: Math.round(completed / (durationMs / 1000)), failed, ...summarize(samples) };
}

async function webSocketLatency(base, messages) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws?id=bench-ws`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
  });
  const roundTrip = () => new Promise((resolve) => {
    const started = performance.now();
    socket.addEventListener("message", () => resolve(performance.now() - started), { once: true });
    socket.send("ping");
  });
  for (let index = 0; index < 20; index += 1) await roundTrip();
  const samples = [];
  for (let index = 0; index < messages; index += 1) samples.push(await roundTrip());
  socket.close();
  return summarize(samples);
}

export async function bench(base, options) {
  const run = `${Date.now().toString(36)}`;
  const rows = [];
  const add = async (name, measure) => rows.push({ name, ...await measure() });
  await add("noop (Worker only)", () => latency(base, "/noop", options.requests));
  await add("DO read (RPC + KV get)", () => latency(base, `/read?id=${run}-a`, options.requests));
  await add("DO write (RPC + KV put)", () => latency(base, `/write?id=${run}-a`, options.requests));
  await add("DO 100-row SQL transaction", () => latency(base, `/sql?id=${run}-sql&n=100`, Math.max(1, Math.floor(options.requests / 5))));
  await add("WebSocket echo (hibernatable)", () => webSocketLatency(base, options.requests));
  await add(`writes, 1 object, ${options.concurrency} in flight`, () => throughput(base, () => `/write?id=${run}-hot`, options.concurrency, options.durationMs));
  await add(`writes, ${options.concurrency} objects, ${options.concurrency} in flight`, () => throughput(base, (worker) => `/write?id=${run}-w${worker}`, options.concurrency, options.durationMs));
  return rows;
}

export function formatTable(target, rows) {
  const ms = (value) => (value === undefined ? "" : value.toFixed(2));
  const lines = [
    `Benchmark — ${target}`,
    "",
    "| Operation | p50 ms | p95 ms | p99 ms | req/s |",
    "|---|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.name} | ${ms(row.p50)} | ${ms(row.p95)} | ${ms(row.p99)} | ${row.rps ?? ""}${row.failed ? ` (${row.failed} failed)` : ""} |`),
  ];
  return lines.join("\n");
}

function usage() {
  return [
    "Usage: node src/bench.js [--target native|celld|wrangler | --url URL] [options]",
    "",
    "  --url URL           Benchmark a running deployment of bench-app (for example on Cloudflare)",
    "  --requests N        Sequential requests per latency row (default 500)",
    "  --concurrency N     In-flight requests for the throughput rows (default 32)",
    "  --duration MS       Length of each throughput row (default 5000)",
    "  --port PORT         Local port for a started target (default 9877)",
    "  --json              Print JSON instead of a table",
  ].join("\n");
}

async function main(args) {
  let options;
  try {
    options = parseBenchArgs(args);
  } catch (error) {
    console.error(`${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) return console.log(usage());
  let child;
  let scratchDir;
  try {
    let base = options.url;
    if (!base) {
      await mkdir(path.join(PACKAGE_DIR, ".runs"), { recursive: true });
      scratchDir = await mkdtemp(path.join(PACKAGE_DIR, ".runs", "bench-"));
      await cp(APP_DIR, scratchDir, { recursive: true });
      base = `http://127.0.0.1:${options.port}`;
      child = startTarget(options.target, scratchDir, options);
      await waitForServer(child, base, options.timeoutMs);
    }
    const rows = await bench(base, options);
    console.log(options.json ? JSON.stringify({ target: options.url ?? options.target, rows }, null, 2) : `\n${formatTable(options.url ?? options.target, rows)}`);
  } catch (error) {
    console.error(`Benchmark failed: ${error.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    if (child) await stopTarget(child);
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
