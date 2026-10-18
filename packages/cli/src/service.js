import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// celld keeps its original state file name so existing detached nodes are found.
function serviceFiles(name) {
  return name === "celld"
    ? { stateFile: "celld-node.json", logFile: "celld.log" }
    : { stateFile: `${name}.json`, logFile: `${name}.log` };
}

export function defaultStateDirectory(env = process.env) {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return env.SOBJECTS_STATE_DIR || join(base, "serverless-objects");
}

export async function startDetached({
  name = "celld",
  executable,
  args,
  // A string that must appear in the process command line, for services such
  // as the ingress whose executable is the shared Node.js binary.
  marker,
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
  const { stateFile, logFile } = serviceFiles(name);
  const statePath = join(stateDirectory, stateFile);
  const existing = await readState(statePath);
  if (existing && isRunning(existing.pid, existing.executable, existing.marker)) {
    throw new Error(`${name} is already running (pid ${existing.pid}); run 'sobjects status'.`);
  }
  if (existing) await unlink(statePath).catch(() => {});

  const logPath = join(stateDirectory, logFile);
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
    if (!Number.isInteger(child.pid)) throw new Error(`${name} did not provide a process id.`);
    const startupDeadline = Date.now() + startupTimeoutMs;
    while (!isRunning(child.pid, executable, marker) && Date.now() < startupDeadline) {
      await wait(100);
    }
    if (!isRunning(child.pid, executable, marker)) {
      throw new Error(`${name} did not start as the expected executable (pid ${child.pid}); inspect ${logPath}.`);
    }

    const state = {
      pid: child.pid,
      executable,
      args,
      cwd,
      logPath,
      ...(marker ? { marker } : {}),
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

export async function getServiceStatus({
  name = "celld",
  stateDirectory = defaultStateDirectory(),
  isRunning = pidMatchesExecutable,
} = {}) {
  const statePath = join(stateDirectory, serviceFiles(name).stateFile);
  const state = await readState(statePath);
  if (!state) return { running: false };
  if (isRunning(state.pid, state.executable, state.marker)) return { running: true, state };
  await unlink(statePath).catch(() => {});
  return { running: false, stale: true, state };
}

export async function stopService({
  name = "celld",
  stateDirectory = defaultStateDirectory(),
  signalProcess = process.kill,
  isRunning = pidMatchesExecutable,
  wait = delay,
  timeoutMs = 10_000,
} = {}) {
  const statePath = join(stateDirectory, serviceFiles(name).stateFile);
  const state = await readState(statePath);
  if (!state) return { stopped: false };

  if (!isRunning(state.pid, state.executable, state.marker)) {
    await unlink(statePath).catch(() => {});
    return { stopped: false, stale: true, state };
  }

  try {
    signalProcess(state.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw new Error(`Could not stop ${name} pid ${state.pid}: ${error.message}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (isRunning(state.pid, state.executable, state.marker) && Date.now() < deadline) await wait(100);
  if (isRunning(state.pid, state.executable, state.marker)) {
    throw new Error(`${name} pid ${state.pid} did not stop after SIGTERM; it was left running.`);
  }
  await unlink(statePath).catch(() => {});
  return { stopped: true, state };
}

export async function readServiceLogs({
  name = "celld",
  stateDirectory = defaultStateDirectory(),
  lines = 100,
} = {}) {
  const { stateFile, logFile } = serviceFiles(name);
  const state = await readState(join(stateDirectory, stateFile));
  const logPath = state?.logPath || join(stateDirectory, logFile);
  let contents;
  try {
    contents = await readFile(logPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`No ${name} log exists at ${logPath}.`);
    throw new Error(`Could not read ${name} log ${logPath}: ${error.message}`);
  }
  return {
    logPath,
    output: contents.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n"),
  };
}

function pidMatchesExecutable(pid, executable, marker) {
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
    if (marker && !command.includes(marker)) return false;
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
      throw new Error(`Invalid service state file ${statePath}.`);
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
    throw new Error(`Could not write service state file ${statePath}: ${error.message}`);
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
