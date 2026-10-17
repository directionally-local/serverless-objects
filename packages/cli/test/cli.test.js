import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.js";

function capture() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      log: (message) => stdout.push(message),
      error: (message) => stderr.push(message),
    },
  };
}

function childWithExit(code, signal = null) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", code, signal));
  return child;
}

test("prints usage when invoked without arguments", async () => {
  const output = capture();
  const exitCode = await run([], output.io);
  assert.equal(exitCode, 0);
  assert.match(output.stdout.join("\n"), /Usage: sobjects/);
  assert.deepEqual(output.stderr, []);
});

test("supports both help flags", async () => {
  for (const flag of ["--help", "-h"]) {
    const output = capture();
    const exitCode = await run([flag], output.io);
    assert.equal(exitCode, 0);
    assert.match(output.stdout.join("\n"), /dev \[project\]/);
  }
});

test("prints the package version", async () => {
  for (const flag of ["--version", "-v", "version"]) {
    const output = capture();
    const exitCode = await run([flag], output.io);
    assert.equal(exitCode, 0);
    assert.deepEqual(output.stdout, ["0.1.0"]);
    assert.deepEqual(output.stderr, []);
  }
});

test("passes dev arguments and project-local binaries to celld", async () => {
  const output = capture();
  const cwd = "/work";
  const env = { SOBJECTS_CELLD_BIN: "/opt/celld", PATH: "/usr/bin" };
  let invocation;
  const exitCode = await run(
    ["dev", "./example", "--port", "19876"],
    output.io,
    {
      env,
      cwd,
      spawnProcess: (executable, args, options) => {
        invocation = { executable, args, options };
        return childWithExit(17);
      },
    },
  );

  assert.deepEqual(invocation, {
    executable: "/opt/celld",
    args: ["dev", "./example", "--port", "19876"],
    options: {
      stdio: "inherit",
      env: {
        ...env,
        PATH: [join(resolve(cwd, "./example"), "node_modules", ".bin"), env.PATH].join(delimiter),
      },
    },
  });
  assert.equal(exitCode, 17);
});

test("passes deploy arguments to celld", async () => {
  const output = capture();
  let invocation;
  const exitCode = await run(["deploy", "--bucket", "s3://test"], output.io, {
    env: {},
    spawnProcess: (executable, args) => {
      invocation = { executable, args };
      return childWithExit(0);
    },
  });

  assert.deepEqual(invocation, {
    executable: "celld",
    args: ["deploy", "--bucket", "s3://test"],
  });
  assert.equal(exitCode, 0);
});

test("reports a missing celld binary with an install hint", async () => {
  const output = capture();
  const exitCode = await run(["dev"], output.io, {
    env: {},
    spawnProcess: () => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        const error = Object.assign(new Error("not found"), { code: "ENOENT" });
        child.emit("error", error);
      });
      return child;
    },
  });

  assert.equal(exitCode, 127);
  assert.match(output.stderr.join("\n"), /Install celld v0\.6\.2/);
});

test("rejects commands that are not implemented", async () => {
  const output = capture();
  const exitCode = await run(["migrate"], output.io);
  assert.equal(exitCode, 2);
  assert.match(output.stderr[0], /Unknown option or command: migrate/);
});
