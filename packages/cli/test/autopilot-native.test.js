import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NativeEngine, loadProjectConfig } from "../src/native/engine.js";

const CLI_PACKAGE = dirname(dirname(fileURLToPath(import.meta.url)));
const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

// A stand-in for autopilot-ai's SDK. prompt() scripts a turn: text, then one
// or two bash calls that ask for permission first (edit mode), then usage.
const FAKE_SDK = `
export async function createAgentSession({ sessionId, config }) {
  const listeners = new Set();
  const pending = new Map();
  let next = 0;
  let aborted = false;
  const emit = (event) => { for (const listener of listeners) listener(event); };
  const ask = (toolName) => new Promise((resolve) => {
    const requestId = "req_" + next++;
    pending.set(requestId, resolve);
    emit({ type: "permission.request", requestId, toolName, args: { command: "echo hi" } });
  });
  const session = {
    sessionId,
    config,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    resolvePermission(requestId, decision) { pending.get(requestId)?.(decision); pending.delete(requestId); },
    setMode() {},
    async abort() { aborted = true; },
    async prompt(text) {
      globalThis.__fakePrompts = [...(globalThis.__fakePrompts ?? []), { sessionId, text }];
      if (text.includes("hang")) return new Promise(() => {});
      aborted = false;
      emit({ type: "message.start", messageId: "m" + next, role: "assistant" });
      emit({ type: "message.delta", messageId: "m" + next, text: "Working on it.\\n" });
      const calls = text.includes("two tools") ? 2 : 1;
      for (let call = 0; call < calls; call += 1) {
        const decision = await ask("bash");
        if (decision !== "allow" || aborted) {
          emit({ type: "session.end", reason: "aborted" });
          return;
        }
        const id = "t" + next++;
        emit({ type: "tool.start", toolCallId: id, toolName: "bash", args: { command: "echo hi" } });
        emit({ type: "tool.result", toolCallId: id, toolName: "bash", result: "hi", isError: false });
      }
      emit({ type: "usage", inputTokens: 100, outputTokens: 20, cost: 0.001 });
      emit({ type: "message.end", messageId: "m0" });
    },
  };
  return { session };
}
`;

const APP = `
import { RunRegistry } from "serverless-objects/autopilot";
import { AutopilotNativeRun } from "serverless-objects/autopilot/native";
export { RunRegistry };
export class Run extends AutopilotNativeRun {}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const run = env.RUNS.getByName(url.searchParams.get("id"));
    const args = request.method === "POST" ? await request.json() : [];
    try {
      return Response.json((await run[url.pathname.slice(1)](...args)) ?? null);
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  },
};
`;

async function project() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-autopilot-native-"));
  directories.push(directory);
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "node_modules", "autopilot-ai"), { recursive: true });
  await writeFile(join(directory, "node_modules", "autopilot-ai", "package.json"), JSON.stringify({ name: "autopilot-ai", type: "module", exports: { "./sdk": "./sdk.js" } }));
  await writeFile(join(directory, "node_modules", "autopilot-ai", "sdk.js"), FAKE_SDK);
  await symlink(CLI_PACKAGE, join(directory, "node_modules", "serverless-objects"), "dir");
  await writeFile(join(directory, "src/index.js"), APP);
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({
    name: "native-runs",
    main: "src/index.js",
    durable_objects: { bindings: [{ name: "RUNS", class_name: "Run" }, { name: "RUN_REGISTRY", class_name: "RunRegistry" }] },
  }));
  return directory;
}

function client(base) {
  return async (method, id, ...args) => {
    const response = await fetch(`${base}/${method}?id=${id}`, { method: "POST", body: JSON.stringify(args) });
    return response.json();
  };
}

async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a run's turn executes in-process, with tool budgets enforced before the tool runs", async () => {
  const directory = await project();
  const engine = new NativeEngine({ config: await loadProjectConfig(directory), persistDirectory: join(directory, ".state"), log: () => {} });
  await engine.start();
  const { port } = await engine.listen({ port: 0 });
  const call = client(`http://127.0.0.1:${port}`);
  try {
    await call("create", "r1", { id: "r1", workspace: "w", cwd: directory, task: "Say hi" });
    const started = await call("start", "r1", { model: "test/model" });
    assert.equal(started.active, true);
    const done = await until(async () => {
      const run = await call("get", "r1");
      return run.status === "completed" ? run : null;
    });
    assert.equal(done.stopReason, "native_session_complete");
    assert.equal(done.totalPromptTokens, 100);
    const events = (await call("listEvents", "r1", {})).map((event) => event.type);
    assert.deepEqual(events, ["state", "state", "tool_intent", "tool_result", "usage", "checkpoint", "state"]);
    const log = (await call("listSessionEvents", "r1", {})).map((event) => event.event_type);
    assert.deepEqual(log.slice(0, 3), ["SessionStarted", "UserMessageCreated", "AssistantStreamStarted"]);
    assert.ok(log.includes("ToolExecutionFinished") && log.includes("AssistantMessageCompleted"));

    // The second mutating tool is denied before it runs; resume continues the same session.
    await call("create", "r2", { id: "r2", workspace: "w", cwd: directory, task: "Use two tools", maxToolIterations: 1 });
    await call("start", "r2");
    const paused = await until(async () => {
      const run = await call("get", "r2");
      const turn = await call("turnState", "r2");
      return run.status === "needs_input" && !turn.active ? run : null;
    });
    assert.equal(paused.stopReason, "max_tool_iterations_exceeded");
    assert.equal((await call("listEvents", "r2", {})).filter((event) => event.type === "tool_intent").length, 1);
    await call("resume", "r2", { maxToolIterations: 5 }, { message: "Carry on with one tool" });
    const resumed = await until(async () => {
      const run = await call("get", "r2");
      return run.status === "completed" ? run : null;
    });
    assert.equal(resumed.maxToolIterations, 5);
    const prompts = globalThis.__fakePrompts.filter((prompt) => prompt.text !== "Say hi");
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].sessionId, prompts[1].sessionId);
    assert.equal(prompts[1].text, "Carry on with one tool");
  } finally {
    await engine.close();
  }
});

function startDev(directory, port) {
  const child = spawn(process.execPath, [join(CLI_PACKAGE, "bin", "sobjects.mjs"), "dev", directory, "--engine", "native", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      const match = /ready on http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (match) resolve({ child, base: `http://127.0.0.1:${match[1]}` });
    });
    child.on("exit", (code) => reject(new Error(`dev exited ${code}`)));
  });
}

async function stop(child) {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

test("a turn cut off by a restart is reconciled, and start() continues the session", async () => {
  const directory = await project();
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  let { child, base } = await startDev(directory, port);
  try {
    const call = client(base);
    await call("create", "r3", { id: "r3", workspace: "w", cwd: directory, task: "hang forever" });
    const { sessionId } = await call("start", "r3");
    await until(async () => (await call("get", "r3")).status === "running");
    await stop(child);

    ({ child, base } = await startDev(directory, port));
    const recovered = await client(base)("get", "r3");
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.stopReason, "process_restart_recovered");
    const continued = await client(base)("start", "r3");
    assert.equal(continued.sessionId, sessionId);
    const done = await until(async () => {
      const run = await client(base)("get", "r3");
      return run.status === "completed" ? run : null;
    });
    assert.equal(done.stopReason, "native_session_complete");
  } finally {
    await stop(child);
  }
});
