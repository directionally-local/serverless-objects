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

test("supports top-level and up help", async () => {
  const topLevel = capture();
  assert.equal(await run(["--help"], topLevel.io), 0);
  assert.match(topLevel.stdout.join("\n"), /up \[--config PATH\]/);

  const up = capture();
  assert.equal(await run(["up", "--help"], up.io), 0);
  assert.match(up.stdout.join("\n"), /foreground/);
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

test("passes deploy arguments to the configured celld binary", async () => {
  const output = capture();
  let invocation;
  const exitCode = await run(["deploy", "--bucket", "s3://test"], output.io, {
    env: { SOBJECTS_CELLD_BIN: "/opt/celld" },
    spawnProcess: (executable, args) => {
      invocation = { executable, args };
      return childWithExit(0);
    },
  });

  assert.deepEqual(invocation, {
    executable: "/opt/celld",
    args: ["deploy", "--bucket", "s3://test"],
  });
  assert.equal(exitCode, 0);
});

test("up installs pinned celld and starts it with validated config", async () => {
  const output = capture();
  const cwd = "/work/app";
  let installOptions;
  let configPath;
  let invocation;
  const exitCode = await run(["up", "--config", "ops/sobjects.toml"], output.io, {
    cwd,
    env: { SOBJECTS_DATA_DIR: "/data/sobjects" },
    installEngine: async (options) => {
      installOptions = options;
      return "/data/sobjects/engines/celld-0.6.2/celld";
    },
    loadConfig: async (path) => {
      configPath = path;
      return {
        bucket: "s3://example/fleet",
        listen: "127.0.0.1:8080",
        endpoint: "https://s3.example.test",
        region: "auto",
      };
    },
    spawnProcess: (executable, args, options) => {
      invocation = { executable, args, options };
      return childWithExit(0);
    },
  });

  assert.deepEqual(installOptions, { dataDirectory: "/data/sobjects" });
  assert.equal(configPath, resolve(cwd, "ops/sobjects.toml"));
  assert.deepEqual(invocation, {
    executable: "/data/sobjects/engines/celld-0.6.2/celld",
    args: [
      "--bucket", "s3://example/fleet",
      "--listen", "127.0.0.1:8080",
      "--endpoint", "https://s3.example.test",
      "--region", "auto",
    ],
    options: { stdio: "inherit" },
  });
  assert.equal(exitCode, 0);
});

test("up validates config before installing or starting celld", async () => {
  const output = capture();
  let installed = false;
  let spawned = false;
  const exitCode = await run(["up"], output.io, {
    env: {},
    loadConfig: async () => { throw new Error("Unknown config key 'listen_port'."); },
    installEngine: async () => { installed = true; return "/celld"; },
    spawnProcess: () => { spawned = true; return childWithExit(0); },
  });

  assert.equal(exitCode, 2);
  assert.equal(installed, false);
  assert.equal(spawned, false);
  assert.match(output.stderr[0], /Unknown config key/);
});

test("up rejects unexpected options", async () => {
  const output = capture();
  assert.equal(await run(["up", "--unknown"], output.io), 2);
  assert.match(output.stderr[0], /Unknown sobjects up option/);
});

test("reports a missing celld binary with an install hint", async () => {
  const output = capture();
  const exitCode = await run(["dev"], output.io, {
    env: { SOBJECTS_CELLD_BIN: "/missing/celld" },
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

test("rejects Wrangler preflight errors before installing or starting celld", async () => {
  const output = capture();
  let installed = false;
  let spawned = false;
  const exitCode = await run(["dev"], output.io, {
    env: {},
    prepareProject: async () => { throw new Error("Unsupported Wrangler config keys: routes"); },
    installEngine: async () => { installed = true; return "/celld"; },
    spawnProcess: () => { spawned = true; return childWithExit(0); },
  });

  assert.equal(exitCode, 2);
  assert.equal(installed, false);
  assert.equal(spawned, false);
  assert.match(output.stderr[0], /Unsupported Wrangler config keys/);
});

test("runs a declared build command before celld and cleans up the normalized config", async () => {
  const output = capture();
  const order = [];
  const exitCode = await run(["dev", "/work/app"], output.io, {
    cwd: "/work",
    env: { SOBJECTS_CELLD_BIN: "/celld", PATH: "/usr/bin" },
    prepareProject: async () => ({
      args: ["/work/app/.sobjects-wrangler-test.json"],
      warnings: ["normalized optional key"],
      buildCommand: "npm run build",
      buildDirectory: "/work/app",
      cleanup: async () => { order.push("cleanup"); },
    }),
    spawnProcess: (executable, args, options) => {
      if (options.shell) {
        order.push("build");
        assert.equal(executable, "npm run build");
        assert.equal(options.cwd, "/work/app");
      } else {
        order.push("celld");
        assert.equal(executable, "/celld");
        assert.deepEqual(args, ["dev", "/work/app/.sobjects-wrangler-test.json"]);
      }
      return childWithExit(0);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(order, ["build", "celld", "cleanup"]);
  assert.equal(output.stderr[0], "Warning: normalized optional key");
});

test("rejects commands that are not implemented", async () => {
  const output = capture();
  const exitCode = await run(["migrate"], output.io);
  assert.equal(exitCode, 2);
  assert.match(output.stderr[0], /Unknown option or command: migrate/);
});
