import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ENDPOINT,
  HotcellSandbox,
  OPTIONS_KEY,
  SANDBOX_ID_KEY,
  createOptions,
  durationMs,
  isoTimestamp,
  quote,
  sandboxName,
} from "../src/sandbox.js";

function memoryStorage(entries = []) {
  const map = new Map(entries);
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, value) => { map.set(key, value); },
    delete: async (key) => map.delete(key),
  };
}

function notFound(path) {
  return new Error(`hotcell GET ${path} -> 404: {"error":"not found"}`);
}

// A Hotcell daemon in memory: sandboxes by id, with call logs.
function fakeHotcell() {
  const daemon = { sandboxes: new Map(), created: [], attached: [], options: undefined, nextId: 1 };
  daemon.createClient = (options) => {
    daemon.options = options;
    return {
      async getSandbox(id, createOptions) {
        if (id) {
          daemon.attached.push(id);
          const sandbox = daemon.sandboxes.get(id);
          if (!sandbox) throw notFound(`/sandboxes/${id}`);
          return sandbox;
        }
        const sandbox = fakeSandbox(`sbx${daemon.nextId++}`, daemon);
        daemon.created.push(createOptions);
        daemon.sandboxes.set(sandbox.id, sandbox);
        return sandbox;
      },
    };
  };
  return daemon;
}

function fakeSandbox(id, daemon) {
  const files = new Map();
  return {
    id,
    status: "running",
    files,
    commands: [],
    started: 0,
    async start() { this.started += 1; this.status = "running"; },
    async exec(command, options) {
      this.commands.push({ command, options });
      if (command.startsWith("rm -- ")) return { stdout: "", stderr: "rm: missing\n", exitCode: 1, success: false };
      if (command.startsWith("test -e ")) return { stdout: "", stderr: "", exitCode: files.has(command.slice(9, -1)) ? 0 : 1 };
      return { stdout: `ran ${command}\n`, stderr: "", exitCode: 0, success: true };
    },
    async writeFile(path, content) { files.set(path, content); },
    async readFile(path) {
      if (!files.has(path)) throw new Error(`hotcell GET /sandboxes/${id}/files -> 500: missing`);
      return files.get(path);
    },
    async mkdir(path, options) { this.commands.push({ mkdir: path, options }); },
    async listFiles() {
      return [
        { path: "/workspace", name: "workspace", isDirectory: true, size: 4096, modifiedAt: "2026-10-19T00:00:00.5100840080" },
        { path: "/workspace/a.txt", name: "a.txt", isDirectory: false, size: 3, modifiedAt: "2026-10-19T13:35:17.5110840080" },
      ];
    },
    async startProcess(command) {
      return { procId: "p1", pid: 42, command, status: "running", exitCode: null, startedAt: "2026-10-19T00:00:00Z", logPath: "/tmp/p1" };
    },
    async listProcesses() {
      return [
        { procId: "p1", pid: 42, command: "sleep 9", status: "running", exitCode: null, startedAt: "2026-10-19T00:00:00Z" },
        { procId: "p2", pid: 43, command: "true", status: "exited", exitCode: 0, startedAt: "2026-10-19T00:00:00Z" },
        { procId: "p3", pid: 44, command: "false", status: "exited", exitCode: 1, startedAt: "2026-10-19T00:00:00Z" },
      ];
    },
    killed: [],
    async killProcess(procId, signal) { this.killed.push([procId, signal]); },
    async *streamLogs(procId, options) {
      assert.deepEqual(options, { follow: false });
      yield `${procId} line 1\n`;
      yield `${procId} line 2\n`;
    },
    async exposePort(port, options) { return { port, exposeId: "e1", token: options.token ?? null, createdAt: "", url: `http://127.0.0.1:4751/${id}/${port}/` }; },
    async destroy() { daemon.sandboxes.delete(id); },
  };
}

function sandboxFor(daemon, storage = memoryStorage(), env = {}) {
  return new HotcellSandbox({ storage, env, createClient: daemon.createClient });
}

test("creates one Hotcell sandbox on first use and stores its id", async () => {
  const daemon = fakeHotcell();
  const storage = memoryStorage();
  const sandbox = sandboxFor(daemon, storage, { HOTCELL_API_KEY: "key" });
  const [first, second] = await Promise.all([sandbox.exec("echo a"), sandbox.exec("echo b")]);
  assert.equal(first.stdout, "ran echo a\n");
  assert.equal(second.success, true);
  assert.equal(daemon.created.length, 1);
  assert.equal(storage.map.get(SANDBOX_ID_KEY), "sbx1");
  assert.deepEqual(daemon.options, { endpoint: DEFAULT_ENDPOINT, apiKey: "key" });
});

test("a new object instance reattaches by the stored id and restarts a stopped sandbox", async () => {
  const daemon = fakeHotcell();
  const storage = memoryStorage();
  await sandboxFor(daemon, storage).writeFile("/workspace/marker", "kept");
  daemon.sandboxes.get("sbx1").status = "stopped";

  const reconstructed = sandboxFor(daemon, storage, { HOTCELL_ENDPOINT: "http://hotcell:4750" });
  assert.equal((await reconstructed.readFile("/workspace/marker")).content, "kept");
  assert.deepEqual(daemon.attached, ["sbx1"]);
  assert.equal(daemon.created.length, 1);
  assert.equal(daemon.sandboxes.get("sbx1").started, 1);
  assert.equal(daemon.options.endpoint, "http://hotcell:4750");
});

test("a sandbox that no longer exists is replaced", async () => {
  const daemon = fakeHotcell();
  const storage = memoryStorage([[SANDBOX_ID_KEY, "gone"]]);
  const sandbox = sandboxFor(daemon, storage);
  await sandbox.exec("true");
  assert.deepEqual(daemon.attached, ["gone"]);
  assert.equal(storage.map.get(SANDBOX_ID_KEY), "sbx1");

  // Removed while this instance still holds a handle: one call fails, the next recreates.
  const removed = daemon.sandboxes.get("sbx1");
  removed.exec = async () => { throw notFound("/sandboxes/sbx1/exec"); };
  daemon.sandboxes.clear();
  await assert.rejects(sandbox.exec("true"), /404/);
  await sandbox.exec("true");
  assert.equal(storage.map.get(SANDBOX_ID_KEY), "sbx2");
});

test("exec and file methods return the Cloudflare result shapes", async () => {
  const sandbox = sandboxFor(fakeHotcell());
  const result = await sandbox.exec("ls", { cwd: "/workspace", env: { A: "1", B: undefined } });
  assert.equal(result.command, "ls");
  assert.equal(result.exitCode, 0);
  assert.equal(typeof result.duration, "number");
  assert.match(result.timestamp, /^\d{4}-\d\d-\d\dT/);

  assert.deepEqual(Object.keys(await sandbox.writeFile("/workspace/é.txt", "héllo")), ["success", "path", "timestamp"]);
  const read = await sandbox.readFile("/workspace/é.txt", { encoding: "utf-8" });
  assert.equal(read.content, "héllo");
  assert.equal(read.size, 6);
  assert.equal((await sandbox.exists("/workspace/é.txt")).exists, true);
  assert.equal((await sandbox.exists("/nope")).exists, false);
  assert.deepEqual((await sandbox.mkdir("/workspace/d", { recursive: true })).recursive, true);

  const listed = await sandbox.listFiles("/workspace/");
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.files[0], {
    name: "a.txt",
    absolutePath: "/workspace/a.txt",
    relativePath: "a.txt",
    type: "file",
    size: 3,
    modifiedAt: "2026-10-19T13:35:17.511Z",
  });
  await assert.rejects(sandbox.deleteFile("/workspace/missing"), /deleteFile failed: rm: missing/);
  assert.deepEqual((await sandbox.renameFile("/a", "/b")).newPath, "/b");
});

test("unsupported options and binary content are rejected instead of ignored", async () => {
  const sandbox = sandboxFor(fakeHotcell());
  await assert.rejects(sandbox.exec("ls", { timeout: 5 }), /exec options not supported by the Hotcell Sandbox binding: timeout/);
  await assert.rejects(sandbox.readFile("/x", { encoding: "base64" }), /only UTF-8/);
  await assert.rejects(sandbox.writeFile("/x", new Uint8Array([1])), /string content only/);
  await assert.rejects(sandbox.exposePort(0), /port must be/);
  await assert.rejects(sandbox.invoke("runCode", []), /Unknown Sandbox method runCode/);
});

test("processes map to Cloudflare statuses and logs are collected", async () => {
  const daemon = fakeHotcell();
  const sandbox = sandboxFor(daemon);
  const started = await sandbox.startProcess("sleep 9");
  assert.deepEqual(started, { id: "p1", pid: 42, command: "sleep 9", status: "running", startTime: new Date("2026-10-19T00:00:00Z"), exitCode: undefined });
  assert.deepEqual((await sandbox.listProcesses()).map((process) => process.status), ["running", "completed", "failed"]);
  assert.equal((await sandbox.getProcess("p3")).exitCode, 1);
  assert.equal(await sandbox.getProcess("p9"), null);
  assert.equal(await sandbox.killAllProcesses(), 1);
  assert.deepEqual(daemon.sandboxes.get("sbx1").killed, [["p1", undefined]]);
  assert.deepEqual(await sandbox.getProcessLogs("p1"), { stdout: "p1 line 1\np1 line 2\n", stderr: "", processId: "p1" });
});

test("ports use Hotcell preview URLs", async () => {
  const sandbox = sandboxFor(fakeHotcell());
  assert.deepEqual(await sandbox.exposePort(8080, { hostname: "example.com", name: "web" }), {
    url: "http://127.0.0.1:4751/sbx1/8080/",
    port: 8080,
    name: "web",
  });
});

test("options are stored and applied when the sandbox is created", async () => {
  const daemon = fakeHotcell();
  const storage = memoryStorage();
  const sandbox = sandboxFor(daemon, storage);
  await sandbox.invoke("exec", ["true"], { sleepAfter: "5m", labels: { team: "a" }, transport: "rpc", hotcell: { egress: { spendCapUsd: 2 } } });
  assert.deepEqual(daemon.created, [{ egress: { spendCapUsd: 2 }, labels: { team: "a" }, sleepAfter: 300_000 }]);
  assert.deepEqual(storage.map.get(OPTIONS_KEY), daemon.created[0]);
});

test("destroy removes the Hotcell sandbox and forgets its id", async () => {
  const daemon = fakeHotcell();
  const storage = memoryStorage();
  const sandbox = sandboxFor(daemon, storage);
  await sandbox.exec("true");
  await sandbox.destroy();
  assert.equal(daemon.sandboxes.size, 0);
  assert.equal(storage.map.has(SANDBOX_ID_KEY), false);
  await sandbox.destroy();
  await sandbox.exec("true");
  assert.equal(storage.map.get(SANDBOX_ID_KEY), "sbx2");
});

test("option helpers validate Cloudflare durations, names, and keys", () => {
  assert.equal(durationMs(180), 180_000);
  assert.equal(durationMs("30s"), 30_000);
  assert.equal(durationMs("1h"), 3_600_000);
  assert.throws(() => durationMs("10 minutes"), /Invalid sleepAfter/);
  assert.deepEqual(createOptions({ keepAlive: true, sleepAfter: "1m" }), { sleepAfter: 0 });
  assert.throws(() => createOptions({ baseUrl: "x" }), /Unsupported Sandbox options: baseUrl/);
  assert.throws(() => createOptions({ hotcell: { apiKey: "x" } }), /Unsupported Sandbox hotcell options: apiKey/);
  assert.equal(sandboxName("User-1", { normalizeId: true }), "user-1");
  assert.equal(sandboxName("User-1"), "User-1");
  assert.equal(quote("it's"), "'it'\\''s'");
  assert.equal(isoTimestamp("2026-10-19T13:35:17"), "2026-10-19T13:35:17.000Z");
  assert.equal(isoTimestamp("2026-10-19T13:35:17Z"), "2026-10-19T13:35:17Z");
});
