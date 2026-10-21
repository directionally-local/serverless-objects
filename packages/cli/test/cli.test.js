import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const flag of ["--version", "-v", "version"]) {
    const output = capture();
    const exitCode = await run([flag], output.io);
    assert.equal(exitCode, 0);
    assert.deepEqual(output.stdout, [version]);
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
        PATH: [
          join(resolve(cwd, "./example"), "node_modules", ".bin"),
          env.PATH,
          dirname(createRequire(import.meta.url).resolve("esbuild/bin/esbuild")),
        ].join(delimiter),
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
    ensureToken: async () => "test-token",
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

test("up reads SOBJECTS_CONFIG when --config is absent, and --config wins", async () => {
  const loaded = [];
  const options = (env) => ({
    cwd: "/work",
    env: { SOBJECTS_CELLD_BIN: "/celld", ...env },
    loadConfig: async (path) => {
      loaded.push(path);
      return { bucket: "s3://example/fleet", listen: "127.0.0.1:8080" };
    },
    spawnProcess: () => childWithExit(0),
  });
  assert.equal(await run(["up"], capture().io, options({ SOBJECTS_CONFIG: "/etc/serverless-objects/sobjects.toml" })), 0);
  assert.equal(await run(["up", "--config", "mine.toml"], capture().io, options({ SOBJECTS_CONFIG: "/etc/serverless-objects/sobjects.toml" })), 0);
  assert.equal(await run(["up"], capture().io, options({})), 0);
  assert.deepEqual(loaded, ["/etc/serverless-objects/sobjects.toml", "/work/mine.toml", "/work/sobjects.toml"]);
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

  assert.deepEqual(installOptions, { dataDirectory: "/data/sobjects", version: "0.6.2" });
  assert.equal(configPath, resolve(cwd, "ops/sobjects.toml"));
  assert.deepEqual(invocation, {
    executable: "/data/sobjects/engines/celld-0.6.2/celld",
    args: [
      "--bucket", "s3://example/fleet",
      "--endpoint", "https://s3.example.test",
      "--region", "auto",
      "--listen", "127.0.0.1:8080",
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
      afterBuild: async () => { order.push("after-build"); },
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
  assert.deepEqual(order, ["build", "after-build", "celld", "cleanup"]);
  assert.equal(output.stderr[0], "Warning: normalized optional key");
});

test("up --detach starts the service manager instead of running in the foreground", async () => {
  const output = capture();
  let startOptions;
  const exitCode = await run(["up", "--detach"], output.io, {
    cwd: "/work/app",
    env: { SOBJECTS_STATE_DIR: "/tmp/sobjects-state" },
    loadConfig: async () => ({ bucket: "s3://example/fleet", listen: "127.0.0.1:8080" }),
    installEngine: async () => "/opt/celld",
    startService: async (options) => {
      startOptions = options;
      return { pid: 456, logPath: "/tmp/sobjects-state/celld.log" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(startOptions.executable, "/opt/celld");
  assert.deepEqual(startOptions.args, ["--bucket", "s3://example/fleet", "--listen", "127.0.0.1:8080"]);
  assert.equal(startOptions.stateDirectory, "/tmp/sobjects-state");
  assert.match(output.stdout.join("\n"), /pid 456/);
});

test("status, down, and logs delegate with the configured state directory", async () => {
  const env = { SOBJECTS_STATE_DIR: "/tmp/sobjects-state" };
  const statusOutput = capture();
  let stateDirectory;
  assert.equal(await run(["status"], statusOutput.io, {
    env,
    getServiceStatus: async (options) => {
      stateDirectory = options.stateDirectory;
      if (options.name === "supervisor") return { running: false };
      return { running: true, state: { pid: 321, startedAt: "now", logPath: "/tmp/celld.log" } };
    },
  }), 0);
  assert.equal(stateDirectory, "/tmp/sobjects-state");
  assert.match(statusOutput.stdout.join("\n"), /pid 321/);

  const downOutput = capture();
  assert.equal(await run(["down"], downOutput.io, {
    env,
    stopService: async (options) => {
      assert.equal(options.stateDirectory, "/tmp/sobjects-state");
      if (options.name === "celld") assert.equal(options.timeoutMs, 45_000);
      return options.name === "celld" ? { stopped: true, state: { pid: 321 } } : { stopped: false };
    },
  }), 0);
  assert.deepEqual(downOutput.stdout, ["Stopped celld (pid 321)."]);

  const logsOutput = capture();
  assert.equal(await run(["logs", "--tail", "3"], logsOutput.io, {
    env,
    readServiceLogs: async (options) => {
      assert.equal(options.stateDirectory, "/tmp/sobjects-state");
      assert.equal(options.lines, 3);
      return { output: "log line 1\\nlog line 2", logPath: "/tmp/celld.log" };
    },
  }), 0);
  assert.equal(logsOutput.stdout[0], "log line 1\\nlog line 2");
});

test("rejects an invalid logs tail value", async () => {
  const output = capture();
  assert.equal(await run(["logs", "--tail", "0"], output.io), 2);
  assert.match(output.stderr[0], /number from 1 to 10000/);
});

test("rejects commands that are not implemented", async () => {
  const output = capture();
  const exitCode = await run(["migrate"], output.io);
  assert.equal(exitCode, 2);
  assert.match(output.stderr[0], /Unknown option or command: migrate/);
});

const INGRESS_CONFIG = Object.freeze({
  bucket: "s3://example/fleet",
  listen: "127.0.0.1:8080",
  ingress: {
    listen: "0.0.0.0:443",
    tls: { cert: "/tls/cert.pem", key: "/tls/key.pem" },
    routes: [{ hostname: "agents.example.test", upstream: "http://127.0.0.1:8080" }],
    accessLog: "-",
  },
});

function fakeIngress(events) {
  return async (options) => {
    events.push(["start", options]);
    return {
      reloadCertificates: () => events.push(["reload"]),
      close: async () => { events.push(["close"]); },
    };
  };
}

test("up starts the configured ingress before celld and closes it after celld exits", async () => {
  const output = capture();
  const events = [];
  const exitCode = await run(["up"], output.io, {
    env: { SOBJECTS_CELLD_BIN: "/opt/celld" },
    loadConfig: async () => INGRESS_CONFIG,
    startIngressServer: fakeIngress(events),
    spawnProcess: (_executable, args) => {
      events.push(["celld", args]);
      return childWithExit(0);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(events.map(([name]) => name), ["start", "celld", "close"]);
  assert.equal(events[1][1].at(-1), "--trust-forwarded-headers");
  assert.equal(events[0][1].listen, "0.0.0.0:443");
  assert.deepEqual(events[0][1].tls, INGRESS_CONFIG.ingress.tls);
  assert.match(output.stdout[0], /Ingress listening on https:\/\/0\.0\.0\.0:443 for agents\.example\.test/);
});

test("up does not start celld when the ingress cannot listen", async () => {
  const output = capture();
  let spawned = false;
  const exitCode = await run(["up"], output.io, {
    env: { SOBJECTS_CELLD_BIN: "/opt/celld" },
    loadConfig: async () => INGRESS_CONFIG,
    startIngressServer: async () => { throw new Error("Ingress could not listen on 0.0.0.0:443: EACCES"); },
    spawnProcess: () => { spawned = true; return childWithExit(0); },
  });
  assert.equal(exitCode, 1);
  assert.equal(spawned, false);
  assert.match(output.stderr[0], /EACCES/);
});

test("up --detach starts celld and a detached supervisor, rolling back celld on failure", async () => {
  const started = [];
  const stopped = [];
  const dependencies = (failIngress) => ({
    cwd: "/work/app",
    env: { SOBJECTS_STATE_DIR: "/tmp/state", SOBJECTS_CELLD_BIN: "/opt/celld" },
    nodeExecutable: "/usr/bin/node",
    loadConfig: async () => INGRESS_CONFIG,
    startService: async (options) => {
      started.push(options);
      if (failIngress && options.name === "supervisor") throw new Error("supervisor did not start");
      return { pid: started.length, logPath: `/tmp/state/${options.name ?? "celld"}.log` };
    },
    stopService: async (options) => { stopped.push(options); return { stopped: true, state: { pid: 1 } }; },
  });

  const ok = capture();
  assert.equal(await run(["up", "--detach", "--config", "ops/so.toml"], ok.io, dependencies(false)), 0);
  assert.equal(started.length, 2);
  assert.equal(started[1].name, "supervisor");
  assert.equal(started[1].executable, "/usr/bin/node");
  assert.match(started[1].args[0], /bin\/sobjects\.mjs$/);
  assert.deepEqual(started[1].args.slice(1), ["supervise", "--config", resolve("/work/app", "ops/so.toml")]);
  assert.equal(started[1].marker, started[1].args[0]);
  assert.match(ok.stdout.join("\n"), /Started the supervisor \(ingress on 0\.0\.0\.0:443\)/);
  assert.deepEqual(stopped, []);

  started.length = 0;
  const failed = capture();
  assert.equal(await run(["up", "--detach"], failed.io, dependencies(true)), 1);
  assert.deepEqual(stopped, [{ name: "celld", stateDirectory: "/tmp/state", timeoutMs: 45_000 }]);
  assert.match(failed.stderr.join("\n"), /Stopping celld/);
});

test("supervise runs until a signal and reloads certificates on SIGHUP", async () => {
  const output = capture();
  const events = [];
  const handlers = new Map();
  const result = run(["supervise"], output.io, {
    env: {},
    loadConfig: async () => INGRESS_CONFIG,
    startIngressServer: fakeIngress(events),
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    },
  });
  while (!handlers.has("SIGTERM")) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  handlers.get("SIGHUP")();
  handlers.get("SIGTERM")();
  assert.equal(await result, 0);
  assert.deepEqual(events.map(([name]) => name), ["start", "reload", "close"]);
  assert.equal(handlers.size, 0);
  assert.match(output.stdout.join("\n"), /Reloaded ingress TLS certificates/);
});

test("supervise requires an [ingress] or [admin] table", async () => {
  const output = capture();
  const exitCode = await run(["supervise"], output.io, {
    loadConfig: async () => ({ bucket: "s3://example/fleet", listen: "127.0.0.1:8080" }),
  });
  assert.equal(exitCode, 2);
  assert.match(output.stderr[0], /No \[ingress\] or \[admin\] table/);
});

test("supervise writes JSON access logs to the state directory by default", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "sobjects-cli-ingress-"));
  try {
    const output = capture();
    const handlers = new Map();
    let address;
    const result = run(["supervise"], output.io, {
      env: { SOBJECTS_STATE_DIR: stateDirectory },
      loadConfig: async () => ({
        ...INGRESS_CONFIG,
        ingress: {
          listen: "127.0.0.1:0",
          routes: [{ hostname: "*", upstream: "http://127.0.0.1:1" }],
        },
      }),
      startIngressServer: async (options) => {
        const { startIngress } = await import("../src/ingress.js");
        const instance = await startIngress(options);
        address = instance.address;
        return instance;
      },
      onSignal: (signal, handler) => {
        handlers.set(signal, handler);
        return () => handlers.delete(signal);
      },
    });
    while (!handlers.has("SIGTERM")) await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const status = await new Promise((resolvePromise, reject) => {
      request({ port: address.port, host: "127.0.0.1", path: "/x?secret=1", headers: { host: "a.test" } }, (response) => {
        response.resume();
        response.on("end", () => resolvePromise(response.statusCode));
      }).on("error", reject).end();
    });
    assert.equal(status, 502);
    handlers.get("SIGTERM")();
    assert.equal(await result, 0);
    const [line] = (await readFile(join(stateDirectory, "access.log"), "utf8")).trim().split("\n");
    const entry = JSON.parse(line);
    assert.equal(entry.status, 502);
    assert.equal(entry.path, "/x");
    assert.equal(entry.host, "a.test");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("logs --supervisor reads the supervisor service log", async () => {
  const output = capture();
  let name;
  assert.equal(await run(["logs", "--supervisor", "--tail", "5"], output.io, {
    env: {},
    readServiceLogs: async (options) => {
      name = options.name;
      assert.equal(options.lines, 5);
      return { output: "ingress line" };
    },
  }), 0);
  assert.equal(name, "supervisor");
  assert.deepEqual(output.stdout, ["ingress line"]);
});

test("service print renders a unit for the resolved config after validating it", async () => {
  const output = capture();
  let loaded;
  const exitCode = await run(["service", "print", "--kind", "systemd", "--config", "ops/sobjects.toml"], output.io, {
    cwd: "/srv/app",
    env: { SOBJECTS_STATE_DIR: "/var/lib/so", SOBJECTS_DATA_DIR: "/opt/so" },
    nodeExecutable: "/usr/bin/node",
    loadConfig: async (path) => { loaded = path; return { bucket: "s3://b/p", listen: "127.0.0.1:8080" }; },
  });
  assert.equal(exitCode, 0);
  assert.equal(loaded, "/srv/app/ops/sobjects.toml");
  const unit = output.stdout.join("\n");
  assert.match(unit, /ExecStart=\/usr\/bin\/node \S+bin\/sobjects\.mjs up --config \/srv\/app\/ops\/sobjects\.toml/);
  assert.match(unit, /Environment=SOBJECTS_STATE_DIR=\/var\/lib\/so/);
  assert.match(unit, /Environment=SOBJECTS_DATA_DIR=\/opt\/so/);
});

test("service install writes the unit and prints enable commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "sobjects-service-home-"));
  try {
    const output = capture();
    const env = { XDG_CONFIG_HOME: join(home, ".config"), SOBJECTS_STATE_DIR: join(home, "state") };
    const dependencies = {
      cwd: home,
      env,
      platform: "linux",
      loadConfig: async () => ({ bucket: "s3://b/p", listen: "127.0.0.1:8080" }),
    };
    assert.equal(await run(["service", "install"], output.io, dependencies), 0);
    const path = join(home, ".config", "systemd", "user", "serverless-objects.service");
    assert.match(await readFile(path, "utf8"), /up --config/);
    assert.match(output.stdout.join("\n"), /systemctl --user enable --now serverless-objects\.service/);

    const again = capture();
    assert.equal(await run(["service", "install"], again.io, dependencies), 1);
    assert.match(again.stderr[0], /already exists/);
    assert.equal(await run(["service", "install", "--force"], capture().io, dependencies), 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service rejects invalid options and configs before writing", async () => {
  const cases = [
    [["service"], /Usage: sobjects service/],
    [["service", "start"], /Unknown sobjects service action/],
    [["service", "print", "--kind", "upstart"], /--kind must be/],
    [["service", "print", "--user", "x"], /only to --system/],
    [["service", "print", "--force"], /Unknown sobjects service option: --force/],
    [["service", "print", "--kind", "launchd", "--system"], /per user/],
  ];
  for (const [argv, pattern] of cases) {
    const output = capture();
    assert.equal(await run(argv, output.io, {
      platform: "linux",
      loadConfig: async () => ({ bucket: "s3://b/p", listen: "127.0.0.1:8080" }),
    }), 2, argv.join(" "));
    assert.match([...output.stdout, ...output.stderr].join("\n"), pattern);
  }
  const broken = capture();
  assert.equal(await run(["service", "print"], broken.io, {
    loadConfig: async () => { throw new Error("Unknown config key 'x'."); },
  }), 2);
});

test("foreground up forwards SIGTERM to celld and stops listening afterwards", async () => {
  const handlers = new Map();
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal));
  };
  const result = run(["up"], capture().io, {
    env: { SOBJECTS_CELLD_BIN: "/opt/celld" },
    loadConfig: async () => ({ bucket: "s3://b/p", listen: "127.0.0.1:8080" }),
    spawnProcess: () => child,
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    },
  });
  while (!handlers.has("SIGTERM")) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  handlers.get("SIGINT")();
  assert.deepEqual(signals, []);
  handlers.get("SIGTERM")();
  assert.equal(await result, 143);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(handlers.size, 0);
});

test("service print for a system unit uses the systemd state directory", async () => {
  const output = capture();
  assert.equal(await run(["service", "print", "--kind", "systemd", "--system", "--user", "so"], output.io, {
    env: { SOBJECTS_STATE_DIR: "/home/me/state" },
    loadConfig: async () => ({ bucket: "s3://b/p", listen: "127.0.0.1:8080" }),
  }), 0);
  const unit = output.stdout.join("\n");
  assert.match(unit, /Environment=SOBJECTS_STATE_DIR=\/var\/lib\/serverless-objects\/state/);
  assert.doesNotMatch(unit, /\/home\/me/);
});

function upgradeHarness(initialSelection) {
  const state = { selection: initialSelection, installs: [] };
  const output = capture();
  const dependencies = {
    env: { SOBJECTS_DATA_DIR: "/data", SOBJECTS_STATE_DIR: "/state" },
    installEngine: async ({ dataDirectory, version }) => {
      assert.equal(dataDirectory, "/data");
      state.installs.push(version);
      return `/data/engines/celld-${version}/celld`;
    },
    readSelection: async () => state.selection,
    writeSelection: async (_directory, selection) => { state.selection = selection; },
    isInstalled: async (_directory, version) => state.installs.includes(version),
    getServiceStatus: async () => ({ running: true }),
  };
  return { state, output, dependencies };
}

test("upgrade selects a pinned version, records the previous one, and rolls back", async () => {
  const { state, output, dependencies } = upgradeHarness(undefined);
  assert.equal(await run(["upgrade", "--engine-version", "v0.6.1"], output.io, dependencies), 0);
  assert.deepEqual(state.installs, ["0.6.1"]);
  assert.equal(state.selection.version, "0.6.1");
  assert.equal(state.selection.previous, "0.6.2");
  assert.match(output.stdout.join("\n"), /Selected celld 0\.6\.1 \(was 0\.6\.2\)/);
  assert.match(output.stdout.join("\n"), /detached node still runs the old version/);

  const rollback = capture();
  assert.equal(await run(["upgrade", "--rollback"], rollback.io, dependencies), 0);
  assert.equal(state.selection.version, "0.6.2");
  assert.equal(state.selection.previous, "0.6.1");

  const status = capture();
  assert.equal(await run(["upgrade", "--status"], status.io, dependencies), 0);
  assert.match(status.stdout.join("\n"), /Selected celld: 0\.6\.2\n/);
  assert.match(status.stdout.join("\n"), /\* 0\.6\.2 \(installed\)/);
  assert.match(status.stdout.join("\n"), /Rollback target: 0\.6\.1/);
});

test("upgrade keeps the current selection when installation fails or the version is unknown", async () => {
  const { state, output, dependencies } = upgradeHarness({ version: "0.6.2" });
  dependencies.installEngine = async () => { throw new Error("checksum mismatch"); };
  assert.equal(await run(["upgrade", "--engine-version", "0.6.1"], output.io, dependencies), 1);
  assert.deepEqual(state.selection, { version: "0.6.2" });
  assert.match(output.stderr.join("\n"), /celld 0\.6\.2 remains selected/);

  const unknown = capture();
  assert.equal(await run(["upgrade", "--engine-version", "9.9.9"], unknown.io, dependencies), 2);
  assert.match(unknown.stderr[0], /not a pinned release/);

  const noPrevious = capture();
  assert.equal(await run(["upgrade", "--rollback"], noPrevious.io, dependencies), 1);
  assert.match(noPrevious.stderr[0], /nothing to roll back/);

  assert.equal(await run(["upgrade", "--rollback", "--status"], capture().io, dependencies), 2);
});

test("up and dev run the selected celld version", async () => {
  const versions = [];
  const dependencies = {
    env: { SOBJECTS_DATA_DIR: "/data" },
    readSelection: async () => ({ version: "0.6.1", previous: "0.6.2" }),
    installEngine: async ({ version }) => { versions.push(version); return `/celld-${version}`; },
    loadConfig: async () => ({ bucket: "s3://b/p", listen: "127.0.0.1:8080" }),
    prepareProject: async (args) => ({ args, warnings: [], cleanup: async () => {} }),
    spawnProcess: (executable) => {
      versions.push(executable);
      return childWithExit(0);
    },
  };
  assert.equal(await run(["up"], capture().io, dependencies), 0);
  assert.equal(await run(["dev"], capture().io, dependencies), 0);
  assert.deepEqual(versions, ["0.6.1", "/celld-0.6.1", "0.6.1", "/celld-0.6.1"]);
});

test("up does not trust forwarded headers when celld is reachable beyond loopback", async () => {
  const output = capture();
  let celldArgs;
  const exitCode = await run(["up"], output.io, {
    env: { SOBJECTS_CELLD_BIN: "/opt/celld" },
    loadConfig: async () => ({ ...INGRESS_CONFIG, listen: "10.0.0.5:8080" }),
    startIngressServer: fakeIngress([]),
    spawnProcess: (_executable, args) => { celldArgs = args; return childWithExit(0); },
  });
  assert.equal(exitCode, 0);
  assert.equal(celldArgs.includes("--trust-forwarded-headers"), false);
  assert.match(output.stderr[0], /not loopback, so celld will not trust/);
});

test("up with [admin] pins celld's operator listener and starts the admin API on the same engine", async () => {
  const output = capture();
  let celldArgs;
  let engineOptions;
  let adminOptions;
  const exitCode = await run(["up"], output.io, {
    env: { SOBJECTS_CELLD_BIN: "/opt/celld" },
    loadConfig: async () => ({
      bucket: "s3://b/p",
      endpoint: "http://127.0.0.1:19000",
      listen: "127.0.0.1:8080",
      internalListen: "127.0.0.1:8081",
      admin: { listen: "127.0.0.1:8790" },
    }),
    createEngine: (options) => { engineOptions = options; return { kind: "engine" }; },
    startAdminServer: async (options) => {
      adminOptions = options;
      return { close: async () => {} };
    },
    spawnProcess: (_executable, args) => { celldArgs = args; return childWithExit(0); },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(celldArgs, [
    "--bucket", "s3://b/p", "--endpoint", "http://127.0.0.1:19000",
    "--listen", "127.0.0.1:8080", "--internal-listen", "127.0.0.1:8081",
  ]);
  assert.deepEqual(engineOptions.storageArgs, ["--bucket", "s3://b/p", "--endpoint", "http://127.0.0.1:19000"]);
  assert.equal(engineOptions.internalListen, "127.0.0.1:8081");
  assert.equal(engineOptions.executable, "/opt/celld");
  assert.equal(adminOptions.listen, "127.0.0.1:8790");
  assert.deepEqual(adminOptions.engine, { kind: "engine" });
  assert.match(output.stdout.join("\n"), /Admin API listening on http:\/\/127\.0\.0\.1:8790/);
});
