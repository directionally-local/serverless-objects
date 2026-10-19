import { execFile } from "node:child_process";

// Thin adapter over celld 0.6's operator surface: the public health route,
// the unauthenticated internal listener (/state, /evict), and `celld cell
// list`. celld documents this API as alpha, so everything engine-specific
// stays in this file.
export function createCelldAdapter({
  listen,
  internalListen,
  executable,
  storageArgs,
  inspectorToken,
  env = process.env,
  fetchImpl = globalThis.fetch,
  run = execFileText,
  timeoutMs = 5_000,
}) {
  const publicOrigin = `http://${loopbackFor(listen)}`;
  const internalOrigin = `http://${loopbackFor(internalListen)}`;

  async function request(origin, path, init = {}) {
    const response = await fetchImpl(`${origin}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  return {
    async health() {
      const [publicResult, internalResult] = await Promise.allSettled([
        request(publicOrigin, "/.well-known/celld/health"),
        request(internalOrigin, "/state"),
      ]);
      const ok = publicResult.status === "fulfilled" && publicResult.value.status === 200;
      return {
        ok,
        listener: publicResult.status === "fulfilled" ? publicResult.value.status : "unreachable",
        operator: internalResult.status === "fulfilled" ? internalResult.value.status : "unreachable",
      };
    },

    async state() {
      const { status, body } = await request(internalOrigin, "/state");
      if (status !== 200 || typeof body !== "object") {
        throw new Error(`celld /state returned HTTP ${status}.`);
      }
      return summarizeState(body);
    },

    async listObjects({ className, after, limit = 100 } = {}) {
      if (className !== undefined && !/^[A-Za-z_$][\w$]*$/.test(className)) {
        throw new RangeError("Invalid object class name.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError("limit must be from 1 to 1000.");
      }
      const args = ["cell", "list"];
      if (className) args.push(className);
      args.push(...storageArgs, "--json", "--limit", String(limit + 1));
      if (after) args.push("--after", after);
      const output = await run(executable, args, { env, timeoutMs: 30_000 });
      const rows = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      const page = rows.slice(0, limit);
      return {
        objects: page.map((row) => parseScope(row.scope)),
        next: rows.length > limit ? page.at(-1).scope : undefined,
      };
    },

    // Reads storage through the hooks `sobjects deploy` bundles into the app.
    // Activating the object to answer is unavoidable; celld has no offline read.
    async inspect(scope, operation) {
      const { className, id } = parseScope(scope);
      if (!inspectorToken) {
        throw new Error("No inspector token on this host; deploy the app with 'sobjects deploy' from this host first.");
      }
      const { status, body } = await request(publicOrigin, "/", {
        method: "POST",
        headers: { "x-sobjects-inspect": inspectorToken, "content-type": "application/json" },
        body: JSON.stringify({ ...operation, className, id }),
      });
      if (status === 401) {
        throw new Error("The deployed app rejected this host's inspector token; redeploy it with 'sobjects deploy' from this host.");
      }
      if (status !== 200) {
        const message = typeof body === "object" && body?.error ? body.error : `HTTP ${status}`;
        if (status === 400) throw new RangeError(message);
        throw new Error(`Inspection failed: ${message}`);
      }
      return body;
    },

    async evict(scope) {
      // celld does not percent-decode scopes; parseScope limits them to
      // Class:<hex>, so the scope is safe to place in the path as is.
      const { scope: checked } = parseScope(scope);
      const { status, body } = await request(internalOrigin, `/evict/${checked}`, { method: "POST" });
      return { status, ...(typeof body === "object" ? body : { ok: false, error: { kind: "failed", reason: String(body) } }) };
    },
  };
}

export function parseScope(scope) {
  const match = /^([^:\s/]+):([0-9a-f]{64})$/.exec(String(scope ?? ""));
  if (!match) throw new RangeError(`Invalid object scope ${JSON.stringify(scope)}; expected Class:<64 hex id>.`);
  return { scope: match[0], className: match[1], id: match[2], reserved: match[1].startsWith("__") };
}

export function summarizeState(state) {
  const load = state.node_load ?? {};
  return {
    deployment: state.deployment
      ? { version: state.deployment.version, prefix: state.deployment.prefix, generation: state.deployment.generation }
      : undefined,
    residents: Array.isArray(state.residents) ? state.residents : [],
    ownedCells: numberOr(state.owned_cells ?? load.owned_cells),
    residentCells: numberOr(load.resident_cells),
    restoring: numberOr(state.restoring),
    activating: numberOr(state.activating),
    evicting: numberOr(state.evicting),
    websockets: numberOr(load.host_websockets),
    rssBytes: numberOr(state.rss_bytes ?? load.rss_bytes),
    inUseBytes: numberOr(state.in_use_bytes ?? load.in_use_bytes),
    cpuPercent: load.cpu_percent_x100 === undefined ? undefined : load.cpu_percent_x100 / 100,
    draining: Boolean(load.draining),
    pressured: Boolean(load.pressured),
    rebalancePaused: Boolean(load.rebalance_paused),
    ownership: state.ownership,
  };
}

function numberOr(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function loopbackFor(address) {
  const index = address.lastIndexOf(":");
  const host = address.slice(0, index).replace(/^\[(.*)\]$/, "$1");
  const port = address.slice(index + 1);
  if (host === "0.0.0.0" || host === "localhost") return `127.0.0.1:${port}`;
  if (host === "::") return `[::1]:${port}`;
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function execFileText(executable, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr).split("\n").filter((line) => line && !line.includes("jemalloc") && !/ WARN celld::memory/.test(line)).at(-1);
        reject(new Error(`celld ${args.slice(0, 2).join(" ")} failed: ${detail ?? error.message}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}
