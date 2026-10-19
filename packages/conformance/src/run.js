import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(PACKAGE_DIR, "app");
const DEFAULT_CELLD_BIN = path.join(os.homedir(), ".local/share/serverless-objects/engines/celld-0.6.2/celld");

export function parseArgs(args) {
  const options = {
    target: "wrangler",
    port: 9876,
    timeoutMs: 60_000,
    alarmDelayMs: undefined,
    restartAfterAlarm: undefined,
    celldBin: process.env.CELLD_BIN ?? DEFAULT_CELLD_BIN,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") options.target = args[++index];
    else if (arg === "--port") options.port = Number(args[++index]);
    else if (arg === "--timeout") options.timeoutMs = Number(args[++index]);
    else if (arg === "--alarm-delay") options.alarmDelayMs = Number(args[++index]);
    else if (arg === "--celld-bin") options.celldBin = args[++index];
    else if (arg === "--restart-after-alarm") options.restartAfterAlarm = true;
    else if (arg === "--no-restart-after-alarm") options.restartAfterAlarm = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.help) return options;
  if (!["wrangler", "celld"].includes(options.target)) throw new Error("--target must be wrangler or celld");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw new Error("--port must be an integer from 1 to 65535");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) throw new Error("--timeout must be at least 1000 milliseconds");
  if (options.alarmDelayMs !== undefined && (!Number.isInteger(options.alarmDelayMs) || options.alarmDelayMs < 1_000)) {
    throw new Error("--alarm-delay must be at least 1000 milliseconds");
  }

  options.restartAfterAlarm ??= options.target === "celld";
  options.alarmDelayMs ??= options.restartAfterAlarm ? 30_000 : 2_000;
  return options;
}

export function validateCaseResult(name, response, body) {
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  if (!body || typeof body.pass !== "boolean") throw new Error(`${name}: malformed result ${JSON.stringify(body)}`);
  return { name, ...body };
}

function usage() {
  return [
    "Usage: node src/run.js [--target wrangler|celld] [options]",
    "",
    "Options:",
    "  --target TARGET       Runtime to test (default: wrangler)",
    "  --port PORT           Local listener port (default: 9876)",
    "  --timeout MS          Startup timeout (default: 60000)",
    "  --alarm-delay MS      Alarm delay (default: 2000; 30000 with restart)",
    "  --celld-bin PATH      celld executable (or set CELLD_BIN)",
    "  --restart-after-alarm Restart target while a durable alarm is pending",
    "  --no-restart-after-alarm  Do not restart target during alarm check",
  ].join("\n");
}

function startTarget(target, projectDir, options) {
  let command;
  let args;
  if (target === "wrangler") {
    command = "wrangler";
    args = [
      "dev",
      "--config", path.join(projectDir, "wrangler.json"),
      "--ip", "127.0.0.1",
      "--port", String(options.port),
      "--local",
      "--persist-to", path.join(projectDir, ".wrangler-state"),
    ];
  } else {
    command = options.celldBin;
    args = ["dev", projectDir, "--host", "127.0.0.1", "--port", String(options.port), "--no-watch"];
  }

  console.log(`Starting ${target}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, { cwd: PACKAGE_DIR, stdio: "inherit", env: process.env });
  child.on("error", (error) => {
    child.startError = error;
  });
  return child;
}

async function stopTarget(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 15_000)),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function waitForServer(child, baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.startError) throw child.startError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Target exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/cases`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && Array.isArray(await response.json())) return;
      lastError = new Error(`Unexpected readiness response: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Target did not become ready within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

async function runCases(baseUrl) {
  const listResponse = await fetch(`${baseUrl}/cases`, { signal: AbortSignal.timeout(5_000) });
  if (!listResponse.ok) throw new Error(`/cases returned HTTP ${listResponse.status}`);
  const names = await listResponse.json();
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== "string")) {
    throw new Error(`/cases returned an invalid case list: ${JSON.stringify(names)}`);
  }

  const results = [];
  for (const name of names) {
    const response = await fetch(`${baseUrl}/case/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => null);
    results.push(validateCaseResult(name, response, body));
  }
  return results;
}

async function readAlarmStatus(baseUrl) {
  const response = await fetch(`${baseUrl}/alarm/status`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`/alarm/status returned HTTP ${response.status}`);
  return response.json();
}

async function runAlarmCheck(baseUrl, delayMs, restartAfterAlarm, restart) {
  const response = await fetch(`${baseUrl}/alarm/arm?ms=${delayMs}`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`/alarm/arm returned HTTP ${response.status}`);
  const { pending } = await response.json();
  if (typeof pending !== "number" || pending <= Date.now()) throw new Error(`Alarm did not report a future deadline: ${pending}`);

  if (restartAfterAlarm) await restart();
  if (restartAfterAlarm) {
    const afterRestart = await readAlarmStatus(baseUrl);
    if (afterRestart.fired || typeof afterRestart.pending !== "number") {
      throw new Error(`Alarm was not still pending after restart: ${JSON.stringify(afterRestart)}`);
    }
  }

  const deadline = Math.max(pending + 10_000, Date.now() + delayMs + 10_000);
  while (Date.now() < deadline) {
    const status = await readAlarmStatus(baseUrl);
    if (status.fired) return { pass: true, detail: restartAfterAlarm ? "alarm fired after process restart" : "alarm fired" };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Alarm did not fire before timeout (pending=${pending})`);
}

function waitForWebSocketEvent(socket, eventName, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`WebSocket ${eventName} timed out`)), timeoutMs);
    const onEvent = (event) => finish(undefined, event);
    const onError = () => finish(new Error("WebSocket error"));
    const onClose = () => finish(new Error("WebSocket closed unexpectedly"));
    function finish(error, event) {
      clearTimeout(timer);
      socket.removeEventListener(eventName, onEvent);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      if (error) reject(error);
      else resolve(event);
    }
    socket.addEventListener(eventName, onEvent, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

async function runWebSocketCheck(baseUrl) {
  if (typeof WebSocket !== "function") throw new Error("This Node.js version does not provide the WebSocket client API");
  const url = new URL("/socket?tag=conformance", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  try {
    await waitForWebSocketEvent(socket, "open");
    const pongMessage = waitForWebSocketEvent(socket, "message");
    socket.send("ping");
    const pong = await pongMessage;
    if (pong.data !== "pong") throw new Error(`WebSocket auto-response expected pong, got ${String(pong.data)}`);

    const echoMessage = waitForWebSocketEvent(socket, "message");
    socket.send("conformance-echo");
    const echo = JSON.parse((await echoMessage).data);
    if (echo.echo !== "conformance-echo" || echo.attachment?.tag !== "conformance" || echo.tags?.[0] !== "conformance") {
      throw new Error(`WebSocket echo/attachment/tags mismatch: ${JSON.stringify(echo)}`);
    }
    return { pass: true, detail: "upgrade, auto-response, echo, attachment, and tags" };
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
}

export async function run(options) {
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), "sobjects-conformance-"));
  const projectDir = path.join(scratchDir, "app");
  await cp(APP_DIR, projectDir, { recursive: true });
  let child;
  let results = [];

  const start = async () => {
    child = startTarget(options.target, projectDir, options);
    await waitForServer(child, baseUrl, options.timeoutMs);
  };
  const restart = async () => {
    await stopTarget(child);
    await start();
  };

  try {
    await start();
    results = await runCases(baseUrl);
    results.push({ name: "alarm-durability", ...await runAlarmCheck(baseUrl, options.alarmDelayMs, options.restartAfterAlarm, restart) });
    results.push({ name: "websockets", ...await runWebSocketCheck(baseUrl) });
    return { target: options.target, results };
  } finally {
    if (child) await stopTarget(child);
    await rm(scratchDir, { recursive: true, force: true });
  }
}

async function main(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    const { target, results } = await run(options);
    console.log(`\nConformance results — ${target}`);
    for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
    const failed = results.filter((result) => !result.pass);
    console.log(`${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    console.error(`Conformance run failed: ${error.stack ?? error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
