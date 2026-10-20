// Runtime-independent core of the Hotcell-backed Sandbox Durable Object. It
// presents the @cloudflare/sandbox 0.x call shape and keeps the Hotcell sandbox
// id in object storage, so an evicted or restarted object reattaches to the
// same sandbox. index.js binds it to the Durable Object class.
import { HotcellClient } from "@hotcell/sdk";

export const DEFAULT_ENDPOINT = "http://127.0.0.1:4750";
export const SANDBOX_ID_KEY = "sobjects.hotcell.sandbox";
export const OPTIONS_KEY = "sobjects.hotcell.options";

export const SANDBOX_METHODS = [
  "exec",
  "writeFile",
  "readFile",
  "mkdir",
  "deleteFile",
  "renameFile",
  "moveFile",
  "exists",
  "listFiles",
  "startProcess",
  "listProcesses",
  "getProcess",
  "killProcess",
  "killAllProcesses",
  "getProcessLogs",
  "setEnvVars",
  "exposePort",
  "unexposePort",
  "getExposedPorts",
  "destroy",
  "hotcellSandboxId",
];

// Options that only tune Cloudflare's container transport have no Hotcell
// equivalent; accept them so ported code keeps working.
const IGNORED_OPTIONS = new Set(["enableDefaultSession", "containerTimeouts", "transport"]);
const SANDBOX_OPTIONS = new Set(["sleepAfter", "keepAlive", "normalizeId", "labels", "hotcell", ...IGNORED_OPTIONS]);
const HOTCELL_OPTIONS = new Set(["image", "env", "egress", "networked", "persist", "setup", "memoryMb", "cpus"]);

export class HotcellSandbox {
  #storage;
  #client;
  #handle;

  constructor({ storage, env = {}, createClient = (options) => new HotcellClient(options) }) {
    this.#storage = storage;
    this.#client = createClient({
      endpoint: env.HOTCELL_ENDPOINT || DEFAULT_ENDPOINT,
      apiKey: env.HOTCELL_API_KEY || undefined,
    });
  }

  // Entry point used by getSandbox(): records creation options, then runs one method.
  async invoke(method, args = [], options) {
    if (!SANDBOX_METHODS.includes(method)) throw new TypeError(`Unknown Sandbox method ${method}.`);
    if (options !== undefined) await this.configure(options);
    return this[method](...args);
  }

  // Options take effect when a Hotcell sandbox is next created; an attached
  // sandbox keeps the settings it was created with.
  async configure(options) {
    await this.#storage.put(OPTIONS_KEY, createOptions(options));
  }

  async exec(command, options = {}) {
    assertString(command, "command");
    const { cwd, env } = pickOptions(options, ["cwd", "env"], "exec");
    const started = Date.now();
    const result = await this.#withSandbox((sandbox) => sandbox.exec(command, { cwd, env: definedValues(env) }));
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      command,
      duration: Date.now() - started,
      timestamp: new Date(started).toISOString(),
    };
  }

  async writeFile(path, content, options = {}) {
    assertString(path, "path");
    if (typeof content !== "string") throw new TypeError("The Hotcell Sandbox binding writes string content only.");
    const { encoding } = pickOptions(options, ["encoding"], "writeFile");
    assertUtf8(encoding, "writeFile");
    await this.#withSandbox((sandbox) => sandbox.writeFile(path, content));
    return { success: true, path, timestamp: now() };
  }

  async readFile(path, options = {}) {
    assertString(path, "path");
    const { encoding } = pickOptions(options, ["encoding"], "readFile");
    assertUtf8(encoding, "readFile");
    const content = await this.#withSandbox((sandbox) => sandbox.readFile(path));
    return {
      success: true,
      path,
      content,
      timestamp: now(),
      encoding: "utf-8",
      isBinary: false,
      size: new TextEncoder().encode(content).byteLength,
    };
  }

  async mkdir(path, options = {}) {
    assertString(path, "path");
    const { recursive = false } = pickOptions(options, ["recursive"], "mkdir");
    await this.#withSandbox((sandbox) => sandbox.mkdir(path, { parents: Boolean(recursive) }));
    return { success: true, path, recursive: Boolean(recursive), timestamp: now() };
  }

  async deleteFile(path) {
    assertString(path, "path");
    await this.#shell(`rm -- ${quote(path)}`, "deleteFile");
    return { success: true, path, timestamp: now() };
  }

  async renameFile(oldPath, newPath) {
    return this.#move(oldPath, newPath, "renameFile");
  }

  async moveFile(sourcePath, destinationPath) {
    return this.#move(sourcePath, destinationPath, "moveFile");
  }

  async exists(path) {
    assertString(path, "path");
    const result = await this.#withSandbox((sandbox) => sandbox.exec(`test -e ${quote(path)}`));
    return { success: true, path, exists: result.exitCode === 0, timestamp: now() };
  }

  async listFiles(path, options = {}) {
    assertString(path, "path");
    pickOptions(options, [], "listFiles");
    const entries = await this.#withSandbox((sandbox) => sandbox.listFiles(path));
    // Hotcell 0.1.19 lists the directory itself first; Cloudflare lists only its contents.
    const self = trimSlash(path);
    const files = entries.filter((entry) => trimSlash(entry.path) !== self).map((entry) => ({
      name: entry.name,
      absolutePath: entry.path,
      relativePath: entry.name,
      type: entry.isDirectory ? "directory" : "file",
      size: entry.size,
      modifiedAt: isoTimestamp(entry.modifiedAt),
    }));
    return { success: true, path, files, count: files.length, timestamp: now() };
  }

  async startProcess(command, options = {}) {
    assertString(command, "command");
    const { cwd, env } = pickOptions(options, ["cwd", "env"], "startProcess");
    const handle = await this.#withSandbox((sandbox) => sandbox.startProcess(command, { cwd, env: definedValues(env) }));
    return toProcess(handle);
  }

  async listProcesses() {
    const handles = await this.#withSandbox((sandbox) => sandbox.listProcesses());
    return handles.map(toProcess);
  }

  async getProcess(id) {
    assertString(id, "id");
    return (await this.listProcesses()).find((process) => process.id === id) ?? null;
  }

  async killProcess(id, signal) {
    assertString(id, "id");
    await this.#withSandbox((sandbox) => sandbox.killProcess(id, signal));
  }

  async killAllProcesses() {
    const running = (await this.listProcesses()).filter((process) => process.status === "running");
    for (const process of running) await this.killProcess(process.id);
    return running.length;
  }

  // Hotcell keeps one combined log per process, so it is returned as stdout.
  async getProcessLogs(id) {
    assertString(id, "id");
    const stdout = await this.#withSandbox(async (sandbox) => {
      let text = "";
      for await (const chunk of sandbox.streamLogs(id, { follow: false })) text += chunk;
      return text;
    });
    return { stdout, stderr: "", processId: id };
  }

  async setEnvVars(envVars) {
    await this.#withSandbox((sandbox) => sandbox.setEnvVars(definedValues(envVars) ?? {}));
  }

  // Preview URLs come from Hotcell's proxy; Cloudflare's `hostname` option is
  // accepted for portability but does not change the URL.
  async exposePort(port, options = {}) {
    assertPort(port);
    const { name, token } = pickOptions(options, ["name", "hostname", "token"], "exposePort");
    const exposed = await this.#withSandbox((sandbox) => sandbox.exposePort(port, token ? { token } : {}));
    return { url: exposed.url, port: exposed.port, name };
  }

  async unexposePort(port) {
    assertPort(port);
    await this.#withSandbox((sandbox) => sandbox.unexposePort(port));
  }

  async getExposedPorts() {
    const ports = await this.#withSandbox((sandbox) => sandbox.listExposedPorts());
    return ports.map((exposed) => ({ url: exposed.url, port: exposed.port, status: "active" }));
  }

  async destroy() {
    const id = await this.#storage.get(SANDBOX_ID_KEY);
    this.#handle = undefined;
    if (id) {
      try {
        await (await this.#client.getSandbox(id)).destroy();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    await this.#storage.delete(SANDBOX_ID_KEY);
  }

  // Not part of the Cloudflare API: the Hotcell id, for operators.
  async hotcellSandboxId() {
    return (await this.#sandbox()).id;
  }

  async #move(from, to, operation) {
    assertString(from, "path");
    assertString(to, "path");
    await this.#shell(`mv -- ${quote(from)} ${quote(to)}`, operation);
    return { success: true, path: from, newPath: to, timestamp: now() };
  }

  async #shell(command, operation) {
    const result = await this.#withSandbox((sandbox) => sandbox.exec(command));
    if (result.exitCode !== 0) throw new Error(`${operation} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    return result;
  }

  // A sandbox removed behind our back invalidates the cached handle; the next
  // call reattaches by the stored id or creates a replacement.
  async #withSandbox(operation) {
    const sandbox = await this.#sandbox();
    try {
      return await operation(sandbox);
    } catch (error) {
      if (isNotFound(error)) this.#handle = undefined;
      throw error;
    }
  }

  #sandbox() {
    this.#handle ??= this.#attach().catch((error) => {
      this.#handle = undefined;
      throw error;
    });
    return this.#handle;
  }

  async #attach() {
    const id = await this.#storage.get(SANDBOX_ID_KEY);
    if (id) {
      try {
        const sandbox = await this.#client.getSandbox(id);
        if (sandbox.status === "stopped") await sandbox.start();
        return sandbox;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    const options = (await this.#storage.get(OPTIONS_KEY)) ?? {};
    const sandbox = await this.#client.getSandbox(undefined, options);
    await this.#storage.put(SANDBOX_ID_KEY, sandbox.id);
    return sandbox;
  }
}

// Translates Cloudflare SandboxOptions plus a `hotcell` block into Hotcell
// create options. Unknown keys are rejected rather than silently dropped.
export function createOptions(options = {}) {
  if (!isRecord(options)) throw new TypeError("Sandbox options must be an object.");
  const unknown = Object.keys(options).filter((key) => !SANDBOX_OPTIONS.has(key));
  if (unknown.length > 0) throw new TypeError(`Unsupported Sandbox options: ${unknown.join(", ")}.`);
  const hotcell = options.hotcell ?? {};
  if (!isRecord(hotcell)) throw new TypeError("Sandbox option `hotcell` must be an object.");
  const unknownHotcell = Object.keys(hotcell).filter((key) => !HOTCELL_OPTIONS.has(key));
  if (unknownHotcell.length > 0) throw new TypeError(`Unsupported Sandbox hotcell options: ${unknownHotcell.join(", ")}.`);

  const result = { ...hotcell };
  if (options.labels !== undefined) result.labels = options.labels;
  if (options.keepAlive) result.sleepAfter = 0;
  else if (options.sleepAfter !== undefined) result.sleepAfter = durationMs(options.sleepAfter);
  return result;
}

// Cloudflare durations are seconds or "30s" / "5m" / "1h"; Hotcell wants milliseconds.
export function durationMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value * 1000;
  const match = typeof value === "string" ? /^(\d+)([smh])$/.exec(value) : null;
  if (!match) throw new TypeError(`Invalid sleepAfter ${JSON.stringify(value)}; use seconds or "30s", "5m", "1h".`);
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
}

// Cloudflare lower-cases ids when normalizeId is set.
export function sandboxName(id, options) {
  assertString(id, "id");
  return options?.normalizeId ? id.toLowerCase() : id;
}

export function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function trimSlash(path) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

// Hotcell 0.1.19 reports `find -printf '%T+'` times: no zone and ten
// fractional digits. The sandbox clock is UTC, so normalize to ISO 8601.
export function isoTimestamp(value) {
  const match = typeof value === "string" ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?$/.exec(value) : null;
  if (!match) return value;
  return `${match[1]}${(match[2] ?? ".000").slice(0, 4).padEnd(4, "0")}Z`;
}

function toProcess(handle) {
  let status = "running";
  if (handle.status !== "running") status = handle.exitCode === 0 ? "completed" : "failed";
  return {
    id: handle.procId,
    pid: handle.pid,
    command: handle.command,
    status,
    startTime: new Date(handle.startedAt),
    exitCode: handle.exitCode ?? undefined,
  };
}

function pickOptions(options, allowed, operation) {
  if (!isRecord(options)) throw new TypeError(`${operation} options must be an object.`);
  const unsupported = Object.keys(options).filter((key) => !allowed.includes(key) && options[key] !== undefined);
  if (unsupported.length > 0) {
    throw new TypeError(`${operation} options not supported by the Hotcell Sandbox binding: ${unsupported.join(", ")}.`);
  }
  return options;
}

function definedValues(record) {
  if (record === undefined) return undefined;
  if (!isRecord(record)) throw new TypeError("Environment variables must be an object.");
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function assertUtf8(encoding, operation) {
  if (encoding !== undefined && !["utf-8", "utf8"].includes(encoding)) {
    throw new TypeError(`${operation} supports only UTF-8 text in the Hotcell Sandbox binding.`);
  }
}

function assertString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string.`);
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("port must be an integer from 1 to 65535.");
}

function isNotFound(error) {
  return / -> 404:/.test(String(error?.message ?? ""));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now() {
  return new Date().toISOString();
}
