import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { run } from "../src/cli.js";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function projectWithConfig() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-deploy-config-"));
  directories.push(directory);
  await writeFile(join(directory, "sobjects.toml"), `
[celld]
bucket = "s3://example/fleet"
endpoint = "https://storage.example.test"
region = "auto"
`);
  return directory;
}

function childWithExit(code = 0) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", code, null));
  return child;
}

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

test("uses sobjects.toml for missing celld deploy options", async () => {
  const cwd = await projectWithConfig();
  const output = capture();
  let invocation;
  const exitCode = await run(["deploy", "--dry-run"], output.io, {
    cwd,
    env: { SOBJECTS_CELLD_BIN: "/celld", PATH: "/usr/bin" },
    ensureToken: async () => "test-token",
    spawnProcess: (executable, args) => {
      invocation = { executable, args };
      return childWithExit();
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(invocation, {
    executable: "/celld",
    args: [
      "deploy",
      "--dry-run",
      "--bucket", "s3://example/fleet",
      "--endpoint", "https://storage.example.test",
      "--region", "auto",
    ],
  });
});

test("preserves explicit celld flags and environment overrides", async () => {
  const cwd = await projectWithConfig();
  const output = capture();
  let invocation;
  const exitCode = await run(
    ["deploy", "--bucket", "s3://cli/fleet", "--endpoint=https://cli.example", "--dry-run"],
    output.io,
    {
      cwd,
      env: { SOBJECTS_CELLD_BIN: "/celld", CELLD_BUCKET: "s3://env/fleet", AWS_REGION: "env-region" },
      ensureToken: async () => "test-token",
      spawnProcess: (executable, args) => {
        invocation = { executable, args };
        return childWithExit();
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(invocation, {
    executable: "/celld",
    args: ["deploy", "--bucket", "s3://cli/fleet", "--endpoint=https://cli.example", "--dry-run"],
  });
});

test("falls back to SOBJECTS_CONFIG when the project has no sobjects.toml", async () => {
  const configDirectory = await projectWithConfig();
  const cwd = await mkdtemp(join(tmpdir(), "sobjects-deploy-project-"));
  directories.push(cwd);
  const output = capture();
  let invocation;
  const exitCode = await run(["deploy"], output.io, {
    cwd,
    env: { SOBJECTS_CELLD_BIN: "/celld", PATH: "/usr/bin", SOBJECTS_CONFIG: join(configDirectory, "sobjects.toml") },
    ensureToken: async () => "test-token",
    spawnProcess: (executable, args) => {
      invocation = { executable, args };
      return childWithExit();
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(invocation.args, [
    "deploy",
    "--bucket", "s3://example/fleet",
    "--endpoint", "https://storage.example.test",
    "--region", "auto",
  ]);
});

test("deploys without defaults when neither config exists", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sobjects-deploy-project-"));
  directories.push(cwd);
  const output = capture();
  let invocation;
  const exitCode = await run(["deploy", "--bucket", "s3://explicit"], output.io, {
    cwd,
    env: { SOBJECTS_CELLD_BIN: "/celld", PATH: "/usr/bin" },
    ensureToken: async () => "test-token",
    spawnProcess: (executable, args) => {
      invocation = { executable, args };
      return childWithExit();
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(invocation.args, ["deploy", "--bucket", "s3://explicit"]);
});
