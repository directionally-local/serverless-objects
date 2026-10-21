// The soak: runs the native engine (the installed `sobjects` CLI) with the
// soak app for days, under steady load and injected faults, and checks that
// no acknowledged write is lost, alarms keep firing, sockets keep echoing,
// and memory and file counts stay flat. Meant to run alone in a container
// (see Dockerfile); writes state/report.json and a daily Markdown summary.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LedgerJournal, alarmGaps } from "./journal.js";

const env = process.env;
const number = (name, fallback) => (env[name] === undefined ? fallback : Number(env[name]));
const CONFIG = {
  app: resolve(env.SOAK_APP ?? join(fileURLToPath(new URL(".", import.meta.url)), "app")),
  data: env.SOAK_DATA ?? "/soak/data",
  state: env.SOAK_STATE ?? "/soak/state",
  s3Dir: env.SOAK_S3_DIR ?? "/soak/state/s3",
  sobjects: env.SOAK_SOBJECTS ?? "sobjects",
  port: number("SOAK_PORT", 8787),
  threads: number("SOAK_THREADS", 2),
  backupIntervalSeconds: number("SOAK_BACKUP_INTERVAL", 10),
  // durable: every acknowledged write is in the bucket first (a disk wipe may lose nothing).
  backupMode: env.SOAK_BACKUP_MODE ?? "durable",
  writesPerSecond: number("SOAK_RATE", 20),
  ledgers: number("SOAK_LEDGERS", 50),
  ledgerRotate: number("SOAK_LEDGER_ROTATE", 5_000),
  tickers: number("SOAK_TICKERS", 5),
  tickPeriodMs: number("SOAK_TICK_MS", 30_000),
  faultMinutes: number("SOAK_FAULT_MINUTES", 45),
  verifyMinutes: number("SOAK_VERIFY_MINUTES", 15),
  days: number("SOAK_DAYS", 14),
  // Comma-separated subset of the fault names below; default all.
  faults: env.SOAK_FAULTS ? env.SOAK_FAULTS.split(",") : undefined,
  outageSeconds: number("SOAK_OUTAGE_SECONDS", 300),
  diskFullSeconds: number("SOAK_DISK_FULL_SECONDS", 180),
};
const ENGINE = `http://127.0.0.1:${CONFIG.port}`;
const S3 = { port: 8333, accessKey: "soak", secretKey: "soak-local-only-secret", bucket: "soak" };
const FAULTS = [["kill9", 3], ["sigterm", 2], ["crash-thread", 2], ["bucket-outage", 1], ["disk-full", 1], ["wipe-restore", 1]];

for (const directory of [CONFIG.data, CONFIG.state, CONFIG.s3Dir]) mkdirSync(directory, { recursive: true });
const STATE_FILE = join(CONFIG.state, "soak-state.json");
const saved = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const report = saved.report ?? {
  startedAt: Date.now(),
  config: CONFIG,
  totals: { acked: 0, failed: 0, verifications: 0, excusedLosses: 0, socketEchoes: 0, socketFailures: 0, socketConnects: 0, socketCloses: 0 },
  faults: [],
  violations: [],
  violationCount: 0,
  hourly: [],
  notes: [],
};
report.runnerStarts = (report.runnerStarts ?? 0) + 1;
const journals = new Map(Object.entries(saved.journals ?? {}).map(([name, value]) => [name, new LedgerJournal(value)]));
let active = saved.active ?? Array.from({ length: CONFIG.ledgers }, (_, index) => `ledger-${index}-0`);
for (const name of active) if (!journals.has(name)) journals.set(name, new LedgerJournal());
const downtime = saved.downtime ?? [];
const locks = new Map();
let engine;
let weed;
let faultActive = null;
let lastOutageEnd = 0;
let hourSamples = [];
let stopping = false;

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
process.on("unhandledRejection", (error) => log(`unhandled: ${error?.stack ?? error}`));

function violation(kind, detail) {
  report.violationCount += 1;
  if (report.violations.length < 500) report.violations.push({ at: Date.now(), kind, detail });
  log(`VIOLATION ${kind}: ${detail}`);
}

// ---- processes -------------------------------------------------------------

function logStream(name) {
  const path = join(CONFIG.state, name);
  try {
    if (statSync(path).size > 50 * 1024 * 1024) renameSync(path, `${path}.1`);
  } catch {}
  return createWriteStream(path, { flags: "a" });
}

// SeaweedFS as the bucket. Volumes are sized explicitly: the defaults (8
// volumes of 64 MB) filled up in the first soak and every upload then got a 500.
async function startBucket() {
  writeFileSync("/tmp/soak-s3.json", JSON.stringify({ identities: [{ name: "soak", credentials: [{ accessKey: S3.accessKey, secretKey: S3.secretKey }], actions: ["Admin", "Read", "Write", "List", "Tagging"] }] }));
  const out = logStream("seaweedfs.log");
  weed = spawn("weed", [
    "server", `-dir=${CONFIG.s3Dir}`, "-ip=127.0.0.1", "-ip.bind=127.0.0.1",
    "-s3", `-s3.port=${S3.port}`, "-s3.config=/tmp/soak-s3.json",
    // At most 50 volumes of 256 MB (12.8 GB); deleted data is vacuumed back.
    "-master.volumeSizeLimitMB=256", "-volume.max=50", "-master.garbageThreshold=0.2",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  weed.stdout.pipe(out);
  weed.stderr.pipe(out);
  weed.on("exit", (code) => !stopping && log(`seaweedfs exited ${code}`));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const created = await new Promise((resolveShell) => {
      const shell = spawn("weed", ["shell", "-master=127.0.0.1:9333"], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      shell.stdout.on("data", (chunk) => (output += chunk));
      shell.stdin.end(`s3.bucket.create -name ${S3.bucket}\n`);
      shell.on("exit", (code) => resolveShell(/already exists/i.test(output) || (code === 0 && !/error|failed|refused/i.test(output))));
    });
    if (created) {
      // The S3 gateway starts after the master; any HTTP answer means it's up.
      for (let wait = 0; wait < 120; wait += 1) {
        try {
          await fetch(`http://127.0.0.1:${S3.port}/`, { signal: AbortSignal.timeout(2_000) });
          return log("seaweedfs ready");
        } catch {
          await sleep(1_000);
        }
      }
      throw new Error("the SeaweedFS S3 gateway did not start");
    }
    await sleep(1_000);
  }
  throw new Error("SeaweedFS did not start");
}

async function startEngine() {
  const out = logStream("engine.log");
  engine = spawn(CONFIG.sobjects, [
    "dev", CONFIG.app, "--engine", "native",
    "--port", String(CONFIG.port),
    "--persist-to", join(CONFIG.data, "native"),
    "--threads", String(CONFIG.threads),
    "--thread-stall-seconds", "20",
    "--backup-bucket", `s3://${S3.bucket}/run`,
    "--backup-interval-seconds", String(CONFIG.backupIntervalSeconds),
    "--backup-mode", CONFIG.backupMode,
  ], {
    env: { ...env, AWS_ACCESS_KEY_ID: S3.accessKey, AWS_SECRET_ACCESS_KEY: S3.secretKey, AWS_REGION: "us-east-1", S3_ENDPOINT: `http://127.0.0.1:${S3.port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engine.stdout.pipe(out);
  engine.stderr.pipe(out);
  const child = engine;
  child.exited = new Promise((resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })));
  child.exited.then(({ code, signal }) => {
    if (!stopping && !faultActive) {
      violation("engine-exit", `engine exited unexpectedly (code ${code}, signal ${signal}); restarting`);
      void restartAfterCrash();
    }
  });
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (await fetchOk(`${ENGINE}/health`, 2_000)) {
      for (let index = 0; index < CONFIG.tickers; index += 1) await fetchOk(`${ENGINE}/tick/start?name=ticker-${index}&period=${CONFIG.tickPeriodMs}`, 10_000);
      return Date.now() - started;
    }
    await sleep(250);
  }
  throw new Error("engine did not become healthy within 120 s");
}

async function restartAfterCrash() {
  const down = Date.now();
  try {
    await startEngine();
  } catch (error) {
    log(`restart failed: ${error.message}`);
  }
  downtime.push([down, Date.now()]);
}

async function stopEngine(signal) {
  const child = engine;
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  const timeout = sleep(30_000).then(() => "timeout");
  if ((await Promise.race([child.exited, timeout])) === "timeout") {
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function fetchOk(url, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

// ---- load ------------------------------------------------------------------

async function withLock(name, task) {
  while (locks.get(name)) await locks.get(name);
  let release;
  locks.set(name, new Promise((resolveLock) => (release = resolveLock)));
  try {
    return await task();
  } finally {
    locks.delete(name);
    release();
  }
}

async function appendOnce() {
  const index = Math.floor(Math.random() * active.length);
  const name = active[index];
  if (locks.get(name)) return;
  await withLock(name, async () => {
    const journal = journals.get(name);
    const seq = journal.send();
    const started = performance.now();
    try {
      const response = await fetch(`${ENGINE}/append?name=${name}&seq=${seq}`, { signal: AbortSignal.timeout(10_000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body === seq) {
        journal.acked(seq);
        report.totals.acked += 1;
        hourSamples.push(performance.now() - started);
      } else {
        journal.failed(seq);
        report.totals.failed += 1;
      }
    } catch {
      journal.failed(seq);
      report.totals.failed += 1;
    }
    if (journal.next > CONFIG.ledgerRotate) {
      const [prefix, , generation] = name.split("-");
      const next = `${prefix}-${name.split("-")[1]}-${Number(generation) + 1}`;
      active[index] = next;
      journals.set(next, new LedgerJournal());
      // A retired ledger's recent acks only matter for a wipe in the next minutes.
      setTimeout(() => (journal.recent = []), 10 * 60_000).unref();
    }
  });
}

// A few sockets echo often; two only every 90 s, so their objects hibernate in between.
function startSockets() {
  for (let index = 0; index < 5; index += 1) {
    const everyMs = index < 3 ? 10_000 : 90_000;
    const connect = () => {
      if (stopping) return;
      const socket = new WebSocket(`${ENGINE.replace("http", "ws")}/echo?name=echo-${index}`);
      const waiting = new Map();
      let timer;
      // A connection attempt made while the engine restarts can hang in the
      // client; give up on it so the loop tries again.
      const connecting = setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) {
          log(`socket ${index}: no answer to the connection within 10 s; retrying`);
          socket.close();
          setTimeout(connect, 1_000);
        }
      }, 10_000);
      socket.addEventListener("open", () => clearTimeout(connecting));
      socket.addEventListener("message", (event) => {
        const wait = waiting.get(event.data);
        if (!wait) return;
        clearTimeout(wait);
        waiting.delete(event.data);
        report.totals.socketEchoes += 1;
      });
      socket.addEventListener("open", () => {
        report.totals.socketConnects = (report.totals.socketConnects ?? 0) + 1;
        log(`socket ${index} open`);
        timer = setInterval(() => {
          const token = `${index}-${Date.now()}`;
          waiting.set(token, setTimeout(() => {
            waiting.delete(token);
            if (!faultActive) {
              report.totals.socketFailures += 1;
              log(`socket ${index}: no echo within 5 s`);
            }
          }, 5_000));
          try {
            socket.send(token);
          } catch {}
        }, everyMs);
      });
      socket.addEventListener("close", (event) => {
        report.totals.socketCloses = (report.totals.socketCloses ?? 0) + 1;
        log(`socket ${index} closed (${event.code})`);
        clearInterval(timer);
        for (const wait of waiting.values()) clearTimeout(wait);
        waiting.clear();
        setTimeout(connect, 1_000);
      });
      socket.addEventListener("error", () => {});
    };
    connect();
  }
}

// ---- verification ----------------------------------------------------------

async function verifyLedgers(reason) {
  const names = [...active];
  // A few retired ledgers each round, so old data is rechecked too.
  const retired = [...journals.keys()].filter((name) => !active.includes(name));
  for (let pick = 0; pick < Math.min(3, retired.length); pick += 1) names.push(retired[Math.floor(Math.random() * retired.length)]);
  let checked = 0;
  for (const name of names) {
    await withLock(name, async () => {
      let state;
      for (let attempt = 0; attempt < 5 && !state; attempt += 1) {
        try {
          const response = await fetch(`${ENGINE}/ledger?name=${name}`, { signal: AbortSignal.timeout(30_000) });
          if (response.ok) state = await response.json();
        } catch {}
        if (!state) await sleep(2_000);
      }
      if (!state) return violation("verify-unreachable", `${name}: ledger could not be read (${reason})`);
      if (state.integrity !== "ok") violation("integrity", `${name}: quick_check returned ${state.integrity}`);
      const { violations, excusedNow } = journals.get(name).verify(state.seqs);
      report.totals.excusedLosses += excusedNow;
      for (const detail of violations.slice(0, 20)) violation("lost-write", `${name}: ${detail} (${reason})`);
      if (violations.length > 20) violation("lost-write", `${name}: ${violations.length - 20} more (${reason})`);
      checked += 1;
    });
  }
  report.totals.verifications += 1;
  log(`verified ${checked} ledgers (${reason})`);
}

async function verifyAlarms() {
  const since = Date.now() - 6 * 3_600_000;
  for (let index = 0; index < CONFIG.tickers; index += 1) {
    try {
      const response = await fetch(`${ENGINE}/tick/fires?name=ticker-${index}&since=${since}`, { signal: AbortSignal.timeout(10_000) });
      const fires = await response.json();
      const relevant = fires.filter((at) => at > report.startedAt + 120_000);
      for (const gap of alarmGaps(relevant, CONFIG.tickPeriodMs, downtime)) {
        const key = `ticker-${index}:${gap.from}`;
        report.seenGaps ??= [];
        if (report.seenGaps.includes(key)) continue;
        report.seenGaps.push(key);
        violation("alarm-gap", `ticker-${index}: ${Math.round(gap.gapMs / 1000)} s between fires (${Math.round(gap.downMs / 1000)} s of planned downtime)`);
      }
    } catch (error) {
      log(`alarm check failed: ${error.message}`);
    }
  }
}

// ---- faults ----------------------------------------------------------------

function pickFault() {
  const allowed = FAULTS.filter(([name]) => !CONFIG.faults || CONFIG.faults.includes(name));
  const choices = allowed.filter(([name]) => name !== "wipe-restore" || Date.now() - lastOutageEnd > 10 * 60_000);
  if (choices.length === 0) return allowed.find(([name]) => name !== "wipe-restore")?.[0] ?? "kill9";
  const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [name, weight] of choices) if ((roll -= weight) < 0) return name;
  return choices[0][0];
}

async function injectFault(name) {
  const record = { type: name, at: Date.now() };
  faultActive = name;
  log(`fault: ${name}`);
  try {
    if (name === "kill9" || name === "sigterm" || name === "wipe-restore") {
      const down = Date.now();
      await stopEngine(name === "sigterm" ? "SIGTERM" : "SIGKILL");
      if (name === "wipe-restore") {
        // Writes acknowledged since the last backup upload may be lost.
        // Counted after the kill, so no write is acknowledged afterwards.
        // Durable mode loses nothing acknowledged; interval mode up to an interval plus an upload.
        const windowMs = CONFIG.backupMode === "durable" ? 0 : CONFIG.backupIntervalSeconds * 1000 + 30_000;
        record.atRisk = [...journals.values()].reduce((sum, journal) => sum + journal.wiped(Date.now(), windowMs), 0);
        rmSync(join(CONFIG.data, "native"), { recursive: true, force: true });
      }
      record.restartMs = await startEngine();
      downtime.push([down, Date.now()]);
    } else if (name === "crash-thread") {
      await fetchOk(`${ENGINE}/fault/crash-thread`, 5_000);
      await sleep(5_000);
      record.healthy = await fetchOk(`${ENGINE}/health`, 5_000);
      if (!record.healthy) violation("thread-crash", "engine unhealthy 5 s after a thread crash");
    } else if (name === "bucket-outage") {
      weed.kill("SIGSTOP");
      await sleep(CONFIG.outageSeconds * 1000);
      weed.kill("SIGCONT");
      lastOutageEnd = Date.now();
      record.healthy = await fetchOk(`${ENGINE}/health`, 5_000);
      if (!record.healthy) violation("bucket-outage", `engine unhealthy after a ${CONFIG.outageSeconds}-second bucket outage`);
    } else if (name === "disk-full") {
      // Only ever fill a small dedicated disk, never the host's.
      const disk = statfsSync(CONFIG.data);
      if (disk.blocks * disk.bsize > 8e9 || statSync(CONFIG.data).dev === statSync(CONFIG.state).dev) {
        record.skipped = "the data directory is not on its own small disk";
        log(`disk-full skipped: ${record.skipped}`);
      } else {
        record.filledBytes = await fillDisk(CONFIG.diskFullSeconds * 1000);
      }
      record.healthy = await fetchOk(`${ENGINE}/health`, 5_000);
    }
  } catch (error) {
    record.error = String(error?.message ?? error);
    violation("fault-recovery", `${name}: ${record.error}`);
    if (engine?.exitCode !== null) await restartAfterCrash();
  } finally {
    faultActive = null;
  }
  await sleep(30_000);
  await verifyLedgers(`after ${name}`);
  record.recoveredAt = Date.now();
  report.faults.push(record);
}

// Fills the data disk until it is full, holds it, then frees it.
async function fillDisk(holdMs) {
  const path = join(CONFIG.data, "soak-filler");
  let written = 0;
  const handle = await open(path, "w");
  const chunk = Buffer.alloc(8 * 1024 * 1024, 1);
  try {
    for (;;) {
      try {
        await handle.write(chunk);
        written += chunk.length;
      } catch {
        break;
      }
      if (written > 4e9) break;
    }
    await sleep(holdMs);
  } finally {
    await handle.close();
    rmSync(path, { force: true });
  }
  return written;
}

// ---- metrics and reports -----------------------------------------------------

function processStats(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return { rssMb: Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024), fds: readdirSync(`/proc/${pid}/fd`).length };
  } catch {
    return { rssMb: null, fds: null };
  }
}

function directoryBytes(directory) {
  let total = 0;
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      total += entry.isDirectory() ? directoryBytes(path) : statSync(path).size;
    }
  } catch {}
  return total;
}

function sampleHour() {
  const sorted = hourSamples.sort((a, b) => a - b);
  const at = (fraction) => (sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))].toFixed(2)) : null);
  const engineStats = processStats(engine?.pid);
  const disk = statfsSync(CONFIG.data);
  report.hourly.push({
    at: Date.now(),
    writes: sorted.length,
    p50: at(0.5),
    p99: at(0.99),
    engineRssMb: engineStats.rssMb,
    engineFds: engineStats.fds,
    bucketRssMb: processStats(weed?.pid).rssMb,
    dataMb: Math.round(directoryBytes(join(CONFIG.data, "native")) / 1e6),
    dataDiskFreeMb: Math.round((disk.bavail * disk.bsize) / 1e6),
  });
  hourSamples = [];
}

function save() {
  const temporary = `${STATE_FILE}.tmp`;
  writeFileSync(temporary, JSON.stringify({ report, journals: Object.fromEntries(journals), active, downtime }));
  renameSync(temporary, STATE_FILE);
  writeFileSync(join(CONFIG.state, "report.json"), JSON.stringify(summary(), null, 2));
}

function summary() {
  const hours = (Date.now() - report.startedAt) / 3_600_000;
  const recent = report.hourly.slice(-24);
  const first = report.hourly.slice(0, 6);
  const average = (rows, key) => (rows.length ? Math.round(rows.reduce((sum, row) => sum + (row[key] ?? 0), 0) / rows.length) : null);
  const faultCounts = {};
  for (const fault of report.faults) faultCounts[fault.type] = (faultCounts[fault.type] ?? 0) + 1;
  return {
    startedAt: new Date(report.startedAt).toISOString(),
    hoursRun: Number(hours.toFixed(1)),
    targetDays: CONFIG.days,
    runnerStarts: report.runnerStarts,
    totals: report.totals,
    faults: faultCounts,
    violationCount: report.violationCount,
    recentViolations: report.violations.slice(-20),
    trend: {
      engineRssMb: { firstHours: average(first, "engineRssMb"), last24h: average(recent, "engineRssMb") },
      engineFds: { firstHours: average(first, "engineFds"), last24h: average(recent, "engineFds") },
      p99Ms: { firstHours: average(first, "p99"), last24h: average(recent, "p99") },
      dataMb: report.hourly.at(-1)?.dataMb ?? null,
    },
  };
}

function writeDaily() {
  const s = summary();
  const day = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Soak report ${day}`,
    "",
    `Running ${s.hoursRun} h of ${s.targetDays * 24} h. Violations: **${s.violationCount}**.`,
    "",
    `- Writes acknowledged: ${s.totals.acked}; failed (not acknowledged): ${s.totals.failed}; verifications: ${s.totals.verifications}`,
    `- Losses excused by disk wipes (within the backup window): ${s.totals.excusedLosses}`,
    `- Socket echoes: ${s.totals.socketEchoes}; missed outside faults: ${s.totals.socketFailures}`,
    `- Faults: ${Object.entries(s.faults).map(([type, count]) => `${type} ${count}`).join(", ") || "none yet"}`,
    `- Engine RSS: ${s.trend.engineRssMb.firstHours} MB at start, ${s.trend.engineRssMb.last24h} MB over the last 24 h`,
    `- Engine open files: ${s.trend.engineFds.firstHours} at start, ${s.trend.engineFds.last24h} over the last 24 h`,
    `- Write p99: ${s.trend.p99Ms.firstHours} ms at start, ${s.trend.p99Ms.last24h} ms over the last 24 h; data on disk ${s.trend.dataMb} MB`,
    "",
    ...(s.recentViolations.length ? ["## Recent violations", "", ...s.recentViolations.map((v) => `- ${new Date(v.at).toISOString()} ${v.kind}: ${v.detail}`)] : []),
  ];
  writeFileSync(join(CONFIG.state, `report-${day}.md`), `${lines.join("\n")}\n`);
}

// ---- main ------------------------------------------------------------------

async function main() {
  log(`soak starting (runner start ${report.runnerStarts}): ${JSON.stringify(CONFIG)}`);
  await startBucket();
  await startEngine();
  startSockets();
  const endAt = report.startedAt + CONFIG.days * 86_400_000;
  const loadTimer = setInterval(() => {
    if (Date.now() < endAt && faultActive !== "kill9" && faultActive !== "wipe-restore") void appendOnce();
  }, 1000 / CONFIG.writesPerSecond);
  setInterval(save, 60_000);
  setInterval(sampleHour, 3_600_000);
  setInterval(writeDaily, 3_600_000);
  setInterval(() => void verifyAlarms(), 30 * 60_000);
  let nextVerify = Date.now() + CONFIG.verifyMinutes * 60_000;
  let nextFault = Date.now() + CONFIG.faultMinutes * 60_000 * (0.5 + Math.random());
  while (Date.now() < endAt) {
    await sleep(5_000);
    if (Date.now() >= nextFault) {
      await injectFault(pickFault());
      nextFault = Date.now() + CONFIG.faultMinutes * 60_000 * (0.5 + Math.random());
    }
    if (Date.now() >= nextVerify) {
      await verifyLedgers("scheduled");
      nextVerify = Date.now() + CONFIG.verifyMinutes * 60_000;
    }
  }
  clearInterval(loadTimer);
  await sleep(10_000);
  await verifyLedgers("final");
  await verifyAlarms();
  report.finishedAt = Date.now();
  sampleHour();
  save();
  writeDaily();
  log(`soak finished: ${report.violationCount} violations`);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    stopping = true;
    save();
    writeDaily();
    await stopEngine("SIGTERM");
    weed?.kill("SIGTERM");
    process.exit(0);
  });
}

await main();
