import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { splitHostPort } from "./ingress.js";

export const ADMIN_REQUEST_HEADER = "x-sobjects-request";

const DASHBOARD_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/dashboard/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/dashboard/app.css": ["app.css", "text/css; charset=utf-8"],
};
const DASHBOARD_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};

// Counters fed by the ingress access log. celld records no metrics of its
// own, so /metrics combines these with a sample of celld's /state.
export function createIngressMetrics() {
  const requests = new Map();
  let bytes = 0;
  let upgrades = 0;
  return {
    observe(entry) {
      const key = `${entry.route ?? ""}\u0000${statusClass(entry.status)}`;
      requests.set(key, (requests.get(key) ?? 0) + 1);
      bytes += entry.bytes ?? 0;
      if (entry.upgrade && entry.status === 101) upgrades += 1;
    },
    render() {
      const lines = [
        "# HELP sobjects_ingress_requests_total Requests handled by the ingress.",
        "# TYPE sobjects_ingress_requests_total counter",
      ];
      for (const [key, count] of [...requests].sort()) {
        const [route, code] = key.split("\u0000");
        lines.push(`sobjects_ingress_requests_total{route="${labelValue(route)}",code="${code}"} ${count}`);
      }
      lines.push(
        "# HELP sobjects_ingress_response_bytes_total Upstream response bytes sent to clients.",
        "# TYPE sobjects_ingress_response_bytes_total counter",
        `sobjects_ingress_response_bytes_total ${bytes}`,
        "# HELP sobjects_ingress_websocket_upgrades_total Completed WebSocket tunnels.",
        "# TYPE sobjects_ingress_websocket_upgrades_total counter",
        `sobjects_ingress_websocket_upgrades_total ${upgrades}`,
      );
      return lines;
    },
  };
}

export async function startAdmin({ listen, engine, metrics, version }) {
  const dashboard = Object.fromEntries(Object.entries(DASHBOARD_FILES).map(([path, [file, type]]) => [
    path,
    { type, body: readFileSync(new URL(`./dashboard/${file}`, import.meta.url)) },
  ]));
  const { host: listenHost } = splitHostPort(listen);
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", listenHost.includes(":") ? `[${listenHost}]` : listenHost]);

  const server = createServer(async (request, response) => {
    // Reject DNS-rebinding requests: browsers send the attacker's hostname.
    const host = String(request.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!allowedHosts.has(host)) {
      sendJson(response, 421, { error: "Unexpected Host header for the admin API." });
      return;
    }
    // A custom header forces a CORS preflight, which this server never
    // approves, so other origins in a browser cannot trigger mutations.
    if (request.method !== "GET" && request.method !== "HEAD" && request.headers[ADMIN_REQUEST_HEADER] !== "1") {
      sendJson(response, 403, { error: `Mutating admin requests require the ${ADMIN_REQUEST_HEADER}: 1 header.` });
      return;
    }
    try {
      await route(request, response);
    } catch (error) {
      const status = error instanceof RangeError ? 400 : 502;
      sendJson(response, status, { error: error.message });
    }
  });

  async function route(request, response) {
    const url = new URL(request.url, "http://admin.invalid");
    const path = url.pathname;

    if (request.method === "GET" && dashboard[path]) {
      const file = dashboard[path];
      response.writeHead(200, { ...DASHBOARD_HEADERS, "content-type": file.type, "content-length": file.body.length });
      response.end(file.body);
      return;
    }

    if (request.method === "GET" && path === "/api/v1/health") {
      const engineHealth = await engine.health();
      sendJson(response, engineHealth.ok ? 200 : 503, { ok: engineHealth.ok, version, engine: engineHealth });
      return;
    }
    if (request.method === "GET" && path === "/api/v1/node") {
      sendJson(response, 200, await engine.state());
      return;
    }
    if (request.method === "GET" && path === "/api/v1/objects") {
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100;
      const [listing, state] = await Promise.all([
        engine.listObjects({
          className: url.searchParams.get("class") ?? undefined,
          after: url.searchParams.get("after") ?? undefined,
          limit,
        }),
        engine.state().catch(() => undefined),
      ]);
      const residents = new Set(state?.residents ?? []);
      sendJson(response, 200, {
        objects: listing.objects.map((object) => ({
          ...object,
          resident: state ? residents.has(object.scope) : undefined,
        })),
        next: listing.next,
      });
      return;
    }
    if (request.method === "GET" && path === "/api/v1/backups") {
      sendJson(response, 200, await engine.listBackups({
        className: url.searchParams.get("class") ?? undefined,
        after: url.searchParams.get("after") ?? undefined,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
      }));
      return;
    }
    const object = /^\/api\/v1\/objects\/([^/]+)(?:\/(kv|sql|export))?$/.exec(path);
    if (object) {
      const scope = decodeURIComponent(object[1]);
      if (request.method === "GET" && !object[2]) {
        sendJson(response, 200, await engine.inspect(scope, { op: "summary" }));
        return;
      }
      if (request.method === "GET" && object[2] === "kv") {
        sendJson(response, 200, await engine.inspect(scope, {
          op: "kv",
          prefix: url.searchParams.get("prefix") ?? undefined,
          startAfter: url.searchParams.get("startAfter") ?? undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
        }));
        return;
      }
      if (request.method === "GET" && object[2] === "export") {
        const exported = await engine.inspect(scope, { op: "export" });
        const name = `${scope.replace(/[^A-Za-z0-9_-]+/g, "-")}-${exported.exportedAt.replace(/[:.]/g, "-")}.json`;
        const text = `${JSON.stringify({ scope, ...exported }, null, 2)}\n`;
        response.writeHead(200, {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${name}"`,
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(text),
        });
        response.end(text);
        return;
      }
      if (request.method === "POST" && object[2] === "sql") {
        const body = await readJson(request);
        sendJson(response, 200, await engine.inspect(scope, { op: "sql", query: body?.query }));
        return;
      }
    }
    const evict = /^\/api\/v1\/objects\/([^/]+)\/evict$/.exec(path);
    if (evict && request.method === "POST") {
      const result = await engine.evict(decodeURIComponent(evict[1]));
      sendJson(response, result.status, result);
      return;
    }
    if (request.method === "GET" && path === "/metrics") {
      const lines = [];
      let state;
      try {
        state = await engine.state();
      } catch {
        state = undefined;
      }
      gauge(lines, "sobjects_engine_up", "Whether the engine operator API answered.", state ? 1 : 0);
      if (state) {
        gauge(lines, "sobjects_engine_resident_objects", "Objects resident in memory.", state.residentCells);
        gauge(lines, "sobjects_engine_owned_objects", "Objects owned by this node.", state.ownedCells);
        gauge(lines, "sobjects_engine_websockets", "WebSockets held by the engine.", state.websockets);
        gauge(lines, "sobjects_engine_rss_bytes", "Engine resident set size.", state.rssBytes);
        gauge(lines, "sobjects_engine_cpu_percent", "Engine CPU use.", state.cpuPercent);
        gauge(lines, "sobjects_engine_draining", "Whether the engine is draining.", state.draining ? 1 : 0);
        gauge(lines, "sobjects_engine_pressured", "Whether the engine reports memory pressure.", state.pressured ? 1 : 0);
      }
      if (metrics) lines.push(...metrics.render());
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
      response.end(`${lines.join("\n")}\n`);
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  }

  const { port } = splitHostPort(listen);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(new Error(`Admin API could not listen on ${listen}: ${error.message}`));
    server.once("error", onError);
    server.listen(port, listenHost, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return {
    address: server.address(),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

async function readJson(request, limitBytes = 64 * 1024) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > limitBytes) throw new RangeError("Request body is too large.");
  }
  try {
    return JSON.parse(text || "null");
  } catch {
    throw new RangeError("Expected a JSON body.");
  }
}

function gauge(lines, name, help, value) {
  if (value === undefined) return;
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
}

function statusClass(status) {
  return typeof status === "number" ? `${Math.floor(status / 100)}xx` : "unknown";
}

function labelValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function sendJson(response, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}
