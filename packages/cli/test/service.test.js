import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  getCelldStatus,
  readCelldLogs,
  startCelldDetached,
  stopCelld,
} from "../src/service.js";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-service-test-"));
  directories.push(directory);
  return directory;
}

function fakeChild(pid = 24680) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

test("starts detached celld, records state, tails logs, and stops it", async () => {
  const stateDirectory = await temporaryDirectory();
  let running = true;
  let invocation;
  const state = await startCelldDetached({
    executable: "/opt/serverless-objects/celld",
    args: ["--bucket", "s3://example/fleet"],
    env: { AWS_REGION: "us-east-1" },
    cwd: "/srv/app",
    stateDirectory,
    spawnProcess: (executable, args, options) => {
      invocation = { executable, args, options };
      return fakeChild();
    },
    isRunning: (pid, executable) => running && pid === 24680 && executable === "/opt/serverless-objects/celld",
    wait: async () => {},
  });

  assert.equal(invocation.executable, "/opt/serverless-objects/celld");
  assert.deepEqual(invocation.args, ["--bucket", "s3://example/fleet"]);
  assert.equal(invocation.options.detached, true);
  assert.equal(state.pid, 24680);
  assert.equal(JSON.parse(await readFile(join(stateDirectory, "celld-node.json"), "utf8")).pid, 24680);

  await writeFile(state.logPath, "first\nsecond\nthird\n");
  const logs = await readCelldLogs({ stateDirectory, lines: 2 });
  assert.equal(logs.output, "second\nthird");
  assert.equal((await getCelldStatus({ stateDirectory, isRunning: () => true })).running, true);

  const stopped = await stopCelld({
    stateDirectory,
    isRunning: () => running,
    signalProcess: (pid, signal) => {
      assert.equal(pid, 24680);
      assert.equal(signal, "SIGTERM");
      running = false;
    },
    wait: async () => {},
    timeoutMs: 100,
  });
  assert.equal(stopped.stopped, true);
  assert.equal((await getCelldStatus({ stateDirectory, isRunning: () => false })).running, false);
});

test("waits briefly for detached process identity to settle", async () => {
  const stateDirectory = await temporaryDirectory();
  let checks = 0;
  let waits = 0;
  const state = await startCelldDetached({
    executable: "/opt/celld",
    args: [],
    stateDirectory,
    spawnProcess: () => fakeChild(),
    isRunning: () => ++checks >= 3,
    wait: async () => { waits += 1; },
    startupTimeoutMs: 1_000,
  });
  assert.equal(state.pid, 24680);
  assert.equal(waits, 2);
  await stopCelld({ stateDirectory, isRunning: () => false });
});

test("does not launch a second detached node when the recorded process is alive", async () => {
  const stateDirectory = await temporaryDirectory();
  await writeFile(join(stateDirectory, "celld-node.json"), JSON.stringify({
    pid: 12345,
    executable: "/opt/celld",
    logPath: join(stateDirectory, "celld.log"),
  }));
  let spawned = false;
  await assert.rejects(
    startCelldDetached({
      executable: "/opt/celld",
      args: [],
      stateDirectory,
      isRunning: () => true,
      spawnProcess: () => { spawned = true; return fakeChild(); },
    }),
    /already running/,
  );
  assert.equal(spawned, false);
});

test("removes stale state rather than signaling a reused PID", async () => {
  const stateDirectory = await temporaryDirectory();
  await writeFile(join(stateDirectory, "celld-node.json"), JSON.stringify({
    pid: 54321,
    executable: "/opt/celld",
    logPath: join(stateDirectory, "celld.log"),
  }));
  let signaled = false;
  const result = await stopCelld({
    stateDirectory,
    isRunning: () => false,
    signalProcess: () => { signaled = true; },
  });
  assert.equal(result.stale, true);
  assert.equal(signaled, false);
  assert.equal((await getCelldStatus({ stateDirectory })).running, false);
});

test("errors clearly when no service log exists", async () => {
  const stateDirectory = await temporaryDirectory();
  await assert.rejects(readCelldLogs({ stateDirectory }), /No celld log exists/);
});
