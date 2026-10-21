import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const CLI = fileURLToPath(new URL("../bin/sobjects.mjs", import.meta.url));
const run = promisify(execFile);

const APP = `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment() {
    const value = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", value);
    return value;
  }
}
export default { fetch: async (request, env) => new Response(String(await env.COUNTER.getByName("a").increment())) };
`;

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForText(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      return await response.text();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function project() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-native-up-"));
  await mkdir(join(directory, "app", "src"), { recursive: true });
  await writeFile(join(directory, "app", "src", "index.js"), APP);
  await writeFile(join(directory, "app", "wrangler.json"), JSON.stringify({
    name: "counter",
    main: "src/index.js",
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
  }));
  const port = await freePort();
  await writeFile(join(directory, "sobjects.toml"), `[native]\nproject = "app"\nlisten = "127.0.0.1:${port}"\n`);
  const env = { ...process.env, SOBJECTS_STATE_DIR: join(directory, "state"), SOBJECTS_DATA_DIR: join(directory, "data") };
  return { directory, port, env, config: join(directory, "sobjects.toml") };
}

test("sobjects up runs a [native] node in the foreground and stops it cleanly on SIGTERM", async () => {
  const { directory, port, env, config } = await project();
  try {
    const child = spawn(process.execPath, [CLI, "up", "--config", config], { env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    assert.equal(await waitForText(`http://127.0.0.1:${port}/`), "1");
    assert.equal(await waitForText(`http://127.0.0.1:${port}/`), "2");
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    // State lives in the data directory, not the project.
    assert.ok((await readdir(join(directory, "data", "native"))).length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sobjects up --detach runs a [native] node that status, logs and down manage", async () => {
  const { directory, port, env, config } = await project();
  try {
    const up = await run(process.execPath, [CLI, "up", "--detach", "--config", config], { env });
    assert.match(up.stdout, /Started the native engine in the background/);
    assert.equal(await waitForText(`http://127.0.0.1:${port}/`), "1");

    const status = await run(process.execPath, [CLI, "status"], { env });
    assert.match(status.stdout, /The native engine is running/);
    const logs = await run(process.execPath, [CLI, "logs"], { env });
    assert.match(logs.stdout, /Native engine ready/);

    const down = await run(process.execPath, [CLI, "down"], { env });
    assert.match(down.stdout, /Stopped native/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`));

    // A restart keeps the object's state.
    await run(process.execPath, [CLI, "up", "--detach", "--config", config], { env });
    assert.equal(await waitForText(`http://127.0.0.1:${port}/`), "2");
    await run(process.execPath, [CLI, "down"], { env });
  } finally {
    await run(process.execPath, [CLI, "down"], { env }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("sobjects deploy refuses a [native] config", async () => {
  const { directory, env } = await project();
  try {
    await assert.rejects(
      run(process.execPath, [CLI, "deploy", directory], { env }),
      (error) => /restart 'sobjects up' to run new code/.test(error.stderr) && error.code === 2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("request.url takes forwarded scheme and host only when trusted", async () => {
  const { toRequest } = await import("../src/native/engine.js");
  const req = { method: "GET", url: "/path?q=1", headers: { host: "127.0.0.1:8787", "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com" } };
  assert.equal(toRequest(req, false).url, "http://127.0.0.1:8787/path?q=1");
  assert.equal(toRequest(req, false, true).url, "https://app.example.com/path?q=1");
  const odd = { ...req, headers: { host: "127.0.0.1:8787", "x-forwarded-proto": "gopher", "x-forwarded-host": "evil.com/x" } };
  assert.equal(toRequest(odd, false, true).url, "http://127.0.0.1:8787/path?q=1");
});

test("up passes --trust-forwarded-headers to a loopback [native] node behind the ingress", async () => {
  const { run: runCli } = await import("../src/cli.js");
  let invocation;
  const errors = [];
  const config = {
    listen: "127.0.0.1:8787",
    native: { project: "/srv/app", args: ["/srv/app", "--engine", "native"], env: { S3_ENDPOINT: "http://s3" } },
    ingress: { listen: "127.0.0.1:8443", routes: [{ hostname: "app.localhost", upstream: "http://127.0.0.1:8787" }] },
  };
  const code = await runCli(["up"], { log: () => {}, error: (message) => errors.push(message) }, {
    cwd: "/srv",
    env: { SOBJECTS_DATA_DIR: "/data" },
    nodeExecutable: "/usr/bin/node",
    loadConfig: async () => config,
    startIngressServer: async () => ({ close: async () => {} }),
    onSignal: () => () => {},
    spawnProcess: (executable, args, options) => {
      invocation = { executable, args, env: options.env };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });
  assert.equal(code, 0, errors.join("\n"));
  assert.equal(invocation.executable, "/usr/bin/node");
  assert.deepEqual(invocation.args.slice(1), ["dev", "/srv/app", "--engine", "native", "--persist-to", "/data/native", "--trust-forwarded-headers"]);
  assert.equal(invocation.env.S3_ENDPOINT, "http://s3");
});
