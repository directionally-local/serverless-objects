import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SERVICE_FILE = "celld-node.json";
const LOG_FILE = "celld.log";

export function defaultStateDirectory(env = process.env) {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return env.SOBJECTS_STATE_DIR || join(base, "serverless-objects");
}

export async function startCelldDetached({
  executable,
  args,
  env = process.env,
  cwd = process.cwd(),
  stateDirectory = defaultStateDirectory(env),
  spawnProcess = spawn,
  isRunning = pidMatchesExecutable,
  wait = delay,
  startupTimeoutMs = 5_000,
} = {}) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700).catch(() => {});
  const statePath = join(stateDirectory, SERVICE_FILE);
  const existing = await readState(statePath);
  if (existing && isRunning(existing.pid, existing.executable)) {
    throw new Error(`celld is already running (pid ${existing.pid}); run 'sobjects status'.`);
  }
  if (existing) await unlink(statePath).catch(() => {});

  const logPath = join(stateDirectory, LOG_FILE);
  const logFd = openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawnProcess(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }

  try {
    await waitForSpawn(child);
    child.unref();
    if (!Number.isInteger(child.pid)) throw new Error("celld did not provide a process id.");
    const startupDeadline = Date.now() + startupTimeoutMs;
    while (!isRunning(child.pid, executable) && Date.now() < startupDeadline) {
      await wait(100);
    }
    if (!isRunning(child.pid, executable)) {
      throw new Error(`celld did not start as the expected executable (pid ${child.pid}); inspect ${logPath}.`);
    }

    const state = {
      pid: child.pid,
      executable,
      args,
      cwd,
      logPath,
      startedAt: new Date().toISOString(),
    };
    await writeState(statePath, state);
    return state;
  } catch (error) {
    if (Number.isInteger(child?.pid)) {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }
}

export async function getCelldStatus({
  stateDirectory = defaultStateDirectory(),
  isRunning = pidMatchesExecutable,
} = {}) {
  const statePath = join(stateDirectory, SERVICE_FILE);
  const state = await readState(statePath);
  if (!state) return { running: false };
  if (isRunning(state.pid, state.executable)) return { running: true, state };
  await unlink(statePath).catch(() => {});
  return { running: false, stale: true, state };
}

export async function stopCelld({
  stateDirectory = defaultStateDirectory(),
  signalProcess = process.kill,
  isRunning = pidMatchesExecutable,
  wait = delay,
  timeoutMs = 10_000,
} = {}) {
  const statePath = join(stateDirectory, SERVICE_FILE);
  const state = await readState(statePath);
  if (!state) return { stopped: false };

  if (!isRunning(state.pid, state.executable)) {
    await unlink(statePath).catch(() => {});
    return { stopped: false, stale: true, state };
  }

  try {
    signalProcess(state.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw new Error(`Could not stop celld pid ${state.pid}: ${error.message}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (isRunning(state.pid, state.executable) && Date.now() < deadline) await wait(100);
  if (isRunning(state.pid, state.executable)) {
    throw new Error(`celld pid ${state.pid} did not stop after SIGTERM; it was left running.`);
  }
  await unlink(statePath).catch(() => {});
  return { stopped: true, state };
}

export async function readCelldLogs({
  stateDirectory = defaultStateDirectory(),
  lines = 100,
} = {}) {
  const state = await readState(join(stateDirectory, SERVICE_FILE));
  const logPath = state?.logPath || join(stateDirectory, LOG_FILE);
  let contents;
  try {
    contents = await readFile(logPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`No celld log exists at ${logPath}.`);
    throw new Error(`Could not read celld log ${logPath}: ${error.message}`);
  }
  return {
    logPath,
    output: contents.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n"),
  };
}

function pidMatchesExecutable(pid, executable) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return command === executable || command.startsWith(`${executable} `) ||
      basename(command.split(/\s+/, 1)[0]) === basename(executable);
  } catch {
    return false;
  }
}

async function readState(statePath) {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8"));
    if (!Number.isInteger(value.pid) || value.pid < 1 || typeof value.logPath !== "string" || typeof value.executable !== "string") {
      throw new Error(`Invalid celld state file ${statePath}.`);
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeState(statePath, state) {
  const temporaryPath = `${statePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, statePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw new Error(`Could not write celld state file ${statePath}: ${error.message}`);
  }
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
