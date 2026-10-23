import { readFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { createSecureContext } from "node:tls";
import { createAcmeCertificateManager } from "./acme.js";

export const HEALTH_PATH = "/.well-known/sobjects/health";
const HEALTH_CACHE_MS = 1_000;

// Hop-by-hop headers (RFC 9110 section 7.6.1) and client-supplied forwarding
// headers. The ingress is the trust boundary, so forwarding headers are always
// rewritten rather than appended to.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const FORWARDING = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  // Only the supervisor may call the storage inspector hooks, and it talks to
  // celld directly, so the header never comes from a client.
  "x-sobjects-inspect",
]);

export async function startIngress({
  listen,
  routes,
  tls,
  acme,
  redirectHttp,
  stateDirectory,
  accessLog = () => {},
  readFile = readFileSync,
  createAcmeManager = createAcmeCertificateManager,
  log = () => {},
}) {
  const router = createRouter(routes);
  const secure = Boolean(tls || acme);
  if (acme && !redirectHttp) throw new Error("ACME HTTP-01 requires an HTTP redirect listener.");
  // Upgraded sockets are invisible to server.closeAllConnections().
  const tunnels = new Set();
  const challenges = acme ? new Map() : undefined;
  const handlers = createHandlers({ router, secure, accessLog, tunnels });

  let server;
  let redirect;
  let manager;
  let activeTls = tls;
  let contexts;
  let reloadCertificates = () => {};
  const servers = [];

  try {
    if (redirectHttp) {
      redirect = createHttpServer(createRedirectHandler({
        router,
        httpsPort: () => server?.address()?.port,
        accessLog,
        challenges,
      }));
      await listenOn(redirect, redirectHttp);
    }

    if (acme) {
      manager = createAcmeManager({
        config: acme,
        domains: acme.domains,
        stateDirectory,
        challenges,
        onCertificate: (certificate) => {
          activeTls = certificate;
          if (server) {
            contexts = loadContexts({ tls: activeTls, routes, readFile });
            server.setSecureContext(contexts.defaultOptions);
          }
        },
        log,
      });
      activeTls = await manager.start();
    }

    if (secure) {
      contexts = loadContexts({ tls: activeTls, routes, readFile });
      server = createHttpsServer({
        ...contexts.defaultOptions,
        SNICallback: (servername, callback) => {
          callback(null, contexts.forServername(servername));
        },
      }, handlers.request);
      reloadCertificates = () => {
        const next = loadContexts({ tls: activeTls, routes, readFile });
        contexts = next;
        server.setSecureContext(next.defaultOptions);
      };
    } else {
      server = createHttpServer(handlers.request);
    }
    server.on("upgrade", handlers.upgrade);
    server.on("clientError", (error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      else socket.destroy(error);
    });
    await listenOn(server, listen);
    servers.push(server);
    if (redirect) servers.push(redirect);
  } catch (error) {
    manager?.close();
    for (const socket of tunnels) socket.destroy();
    await Promise.all([server, redirect].filter(Boolean).map(closeServer));
    throw error;
  }

  return {
    server,
    servers,
    address: server.address(),
    reloadCertificates,
    close: async () => {
      manager?.close();
      for (const socket of tunnels) socket.destroy();
      await Promise.all(servers.map(closeServer));
    },
  };
}

export function createRouter(routes) {
  if (!Array.isArray(routes) || routes.length === 0) throw new Error("Ingress requires at least one route.");
  const compiled = routes.map((route) => ({
    ...route,
    pattern: route.hostname.toLowerCase(),
    target: parseUpstream(route.upstream),
  }));
  // Exact hostnames win over wildcards, and longer wildcards over shorter ones.
  compiled.sort((left, right) => specificity(right.pattern) - specificity(left.pattern));
  return {
    routes: compiled,
    match(hostHeader) {
      const hostname = normalizeHost(hostHeader);
      if (!hostname) return undefined;
      return compiled.find((route) => hostnameMatches(route.pattern, hostname));
    },
  };
}

export function hostnameMatches(pattern, hostname) {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return pattern === hostname;
}

function specificity(pattern) {
  if (pattern === "*") return 0;
  if (pattern.startsWith("*.")) return pattern.length;
  return 10_000 + pattern.length;
}

function normalizeHost(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader === "") return undefined;
  const lower = hostHeader.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end === -1 ? undefined : lower.slice(0, end + 1);
  }
  const hostname = lower.replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9.-]+$/.test(hostname) ? hostname : undefined;
}

function parseUpstream(upstream) {
  const url = new URL(upstream);
  if (url.protocol !== "http:") throw new Error(`Ingress upstream ${upstream} must use http.`);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return { host, port: Number(url.port || 80), origin: url.origin };
}

function createHandlers({ router, secure, accessLog, tunnels }) {
  const proto = secure ? "https" : "http";
  // Health requests share one upstream check, reused for a second after it
  // finishes, so a flood of them can't open a connection each.
  let healthCheck;
  const upstreamHealth = () => {
    if (!healthCheck || (healthCheck.finishedAt && Date.now() - healthCheck.finishedAt > HEALTH_CACHE_MS)) {
      const check = { finishedAt: 0 };
      check.result = checkUpstreams(router).finally(() => { check.finishedAt = Date.now(); });
      healthCheck = check;
    }
    return healthCheck.result;
  };

  function request(clientRequest, clientResponse) {
    const started = process.hrtime.bigint();
    const route = router.match(clientRequest.headers.host);
    const entry = baseLogEntry(clientRequest, route);
    let bytes = 0;
    const finish = (status) => {
      accessLog({ ...entry, status, bytes, duration_ms: elapsedMs(started) });
    };

    if (pathOf(clientRequest.url) === HEALTH_PATH) {
      upstreamHealth().then((health) => {
        // Upstream addresses are internal: only local callers see them.
        const body = `${JSON.stringify(isLoopbackPeer(clientRequest.socket.remoteAddress) ? health : { status: health.status })}\n`;
        const status = health.status === "ok" ? 200 : 503;
        clientResponse.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
        });
        clientResponse.end(body);
        bytes = Buffer.byteLength(body);
        finish(status);
      });
      return;
    }

    if (!route) {
      bytes = sendText(clientResponse, 421, "No route for this hostname.\n");
      finish(421);
      return;
    }

    const upstreamRequest = httpRequest({
      host: route.target.host,
      port: route.target.port,
      method: clientRequest.method,
      path: clientRequest.url,
      headers: forwardHeaders(clientRequest, proto),
    });
    upstreamRequest.on("response", (upstreamResponse) => {
      clientResponse.writeHead(
        upstreamResponse.statusCode,
        upstreamResponse.statusMessage,
        stripHopByHop(upstreamResponse.rawHeaders),
      );
      upstreamResponse.on("data", (chunk) => { bytes += chunk.length; });
      upstreamResponse.pipe(clientResponse);
      upstreamResponse.on("end", () => finish(upstreamResponse.statusCode));
      upstreamResponse.on("error", () => clientResponse.destroy());
    });
    upstreamRequest.on("error", () => {
      if (!clientResponse.headersSent) {
        bytes = sendText(clientResponse, 502, "Upstream unavailable.\n");
        finish(502);
      } else {
        clientResponse.destroy();
      }
    });
    clientResponse.on("close", () => {
      if (!clientResponse.writableFinished) upstreamRequest.destroy();
    });
    clientRequest.pipe(upstreamRequest);
  }

  function upgrade(clientRequest, clientSocket, head) {
    const started = process.hrtime.bigint();
    const route = router.match(clientRequest.headers.host);
    const entry = { ...baseLogEntry(clientRequest, route), upgrade: true };
    clientSocket.on("error", () => {});
    if (!route) {
      clientSocket.end("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      accessLog({ ...entry, status: 421, bytes: 0, duration_ms: elapsedMs(started) });
      return;
    }

    let status = 502;
    let bytes = 0;
    const upstreamSocket = connect(route.target.port, route.target.host);
    tunnels.add(clientSocket);
    tunnels.add(upstreamSocket);
    upstreamSocket.once("connect", () => {
      const headers = forwardHeaders(clientRequest, proto);
      headers.connection = "Upgrade";
      headers.upgrade = clientRequest.headers.upgrade;
      const lines = [`${clientRequest.method} ${clientRequest.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.once("data", (chunk) => {
        const match = /^HTTP\/1\.[01] (\d{3})/.exec(chunk.toString("latin1", 0, 16));
        if (match) status = Number(match[1]);
      });
      upstreamSocket.on("data", (chunk) => { bytes += chunk.length; });
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on("error", () => {
      if (bytes === 0 && clientSocket.writable) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      } else {
        clientSocket.destroy();
      }
    });
    // HTTP server sockets allow half-open connections, and WebSockets close
    // in-band, so either side ending tears down the whole tunnel.
    const teardown = () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    };
    clientSocket.on("end", teardown);
    clientSocket.on("close", teardown);
    upstreamSocket.on("end", teardown);
    upstreamSocket.on("close", () => {
      clientSocket.destroy();
      tunnels.delete(clientSocket);
      tunnels.delete(upstreamSocket);
      accessLog({ ...entry, status, bytes, duration_ms: elapsedMs(started) });
    });
  }

  return { request, upgrade };
}

const ACME_CHALLENGE_PREFIX = "/.well-known/acme-challenge";

function createRedirectHandler({ router, httpsPort, accessLog, challenges }) {
  return (clientRequest, clientResponse) => {
    const started = process.hrtime.bigint();
    const route = router.match(clientRequest.headers.host);
    const entry = { ...baseLogEntry(clientRequest, route), redirect: true };
    let pathname;
    try {
      pathname = new URL(clientRequest.url ?? "/", "http://localhost").pathname;
    } catch {
      const bytes = sendText(clientResponse, 400, "Invalid request path.\n");
      accessLog({ ...entry, status: 400, bytes, duration_ms: elapsedMs(started) });
      return;
    }

    if (challenges && pathname.startsWith(`${ACME_CHALLENGE_PREFIX}/`)) {
      const token = pathname.slice(ACME_CHALLENGE_PREFIX.length + 1);
      const hostname = normalizeHost(clientRequest.headers.host);
      const challenge = challenges.get(token);
      const body = challenge && challenge.hostname === hostname && /^[A-Za-z0-9_-]+$/.test(token)
        ? challenge.keyAuthorization
        : undefined;
      entry.path = `${ACME_CHALLENGE_PREFIX}/:token`;
      if (body && ["GET", "HEAD"].includes(clientRequest.method)) {
        const bytes = Buffer.byteLength(body);
        clientResponse.writeHead(200, {
          "content-type": "text/plain",
          "cache-control": "no-store",
          "content-length": bytes,
        });
        clientResponse.end(clientRequest.method === "HEAD" ? undefined : body);
        accessLog({ ...entry, status: 200, bytes: clientRequest.method === "HEAD" ? 0 : bytes, duration_ms: elapsedMs(started) });
      } else {
        const bytes = sendText(clientResponse, 404, "Challenge not found.\n");
        accessLog({ ...entry, status: 404, bytes, duration_ms: elapsedMs(started) });
      }
      return;
    }

    if (pathname === ACME_CHALLENGE_PREFIX || pathname.startsWith(`${ACME_CHALLENGE_PREFIX}/`)) {
      const bytes = sendText(clientResponse, 404, "Challenge not found.\n");
      accessLog({ ...entry, status: 404, bytes, duration_ms: elapsedMs(started) });
      return;
    }
    if (!route) {
      const bytes = sendText(clientResponse, 421, "No route for this hostname.\n");
      accessLog({ ...entry, status: 421, bytes, duration_ms: elapsedMs(started) });
      return;
    }
    const portValue = httpsPort();
    if (!portValue) {
      const bytes = sendText(clientResponse, 503, "Ingress is starting.\n");
      accessLog({ ...entry, status: 503, bytes, duration_ms: elapsedMs(started) });
      return;
    }
    const host = normalizeHost(clientRequest.headers.host);
    const port = portValue === 443 ? "" : `:${portValue}`;
    clientResponse.writeHead(308, { location: `https://${host}${port}${clientRequest.url}`, "content-length": 0 });
    clientResponse.end();
    accessLog({ ...entry, status: 308, bytes: 0, duration_ms: elapsedMs(started) });
  };
}

function forwardHeaders(clientRequest, proto) {
  const headers = {};
  const connectionTokens = new Set(
    String(clientRequest.headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(clientRequest.headers)) {
    if (HOP_BY_HOP.has(name) || FORWARDING.has(name) || connectionTokens.has(name)) continue;
    headers[name] = value;
  }
  const remote = clientRequest.socket.remoteAddress ?? "";
  headers["x-forwarded-for"] = remote;
  headers["x-forwarded-proto"] = proto;
  if (clientRequest.headers.host) headers["x-forwarded-host"] = clientRequest.headers.host;
  // Workers code commonly reads the client address from CF-Connecting-IP.
  headers["cf-connecting-ip"] = remote;
  return headers;
}

function stripHopByHop(rawHeaders) {
  const connectionTokens = new Set();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === "connection") {
      for (const token of rawHeaders[index + 1].split(",")) connectionTokens.add(token.trim().toLowerCase());
    }
  }
  const result = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    if (HOP_BY_HOP.has(name) || connectionTokens.has(name)) continue;
    result.push(rawHeaders[index], rawHeaders[index + 1]);
  }
  return result;
}

export function isLoopbackPeer(address) {
  return /^(?:::ffff:)?127\./.test(address ?? "") || address === "::1";
}

async function checkUpstreams(router) {
  const origins = new Map();
  for (const route of router.routes) origins.set(route.target.origin, route.target);
  const upstreams = {};
  await Promise.all([...origins].map(async ([origin, target]) => {
    upstreams[origin] = (await canConnect(target)) ? "ok" : "unreachable";
  }));
  const status = Object.values(upstreams).every((value) => value === "ok") ? "ok" : "degraded";
  return { status, upstreams };
}

function canConnect({ host, port }, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function loadContexts({ tls, routes, readFile }) {
  const read = (path, label) => {
    if (Buffer.isBuffer(path)) return path;
    try {
      return readFile(path);
    } catch (error) {
      throw new Error(`Could not read ingress TLS ${label} ${path}: ${error.message}`);
    }
  };
  const defaultOptions = { cert: read(tls.cert, "certificate"), key: read(tls.key, "key") };
  const defaultContext = createSecureContext(defaultOptions);
  const routeContexts = routes
    .filter((route) => route.tls)
    .map((route) => ({
      pattern: route.hostname.toLowerCase(),
      context: createSecureContext({
        cert: read(route.tls.cert, "certificate"),
        key: read(route.tls.key, "key"),
      }),
    }))
    .sort((left, right) => specificity(right.pattern) - specificity(left.pattern));
  return {
    defaultOptions,
    forServername(servername) {
      const hostname = normalizeHost(servername ?? "");
      const match = hostname && routeContexts.find((entry) => hostnameMatches(entry.pattern, hostname));
      return match ? match.context : defaultContext;
    },
  };
}

function baseLogEntry(clientRequest, route) {
  return {
    time: new Date().toISOString(),
    remote: clientRequest.socket.remoteAddress,
    method: clientRequest.method,
    host: clientRequest.headers.host,
    // Query strings often carry tokens, so access logs record only the path.
    path: pathOf(clientRequest.url),
    route: route?.hostname,
  };
}

function pathOf(url = "/") {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

function sendText(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
  return Buffer.byteLength(body);
}

function elapsedMs(started) {
  return Number((process.hrtime.bigint() - started) / 1_000n) / 1_000;
}

export function splitHostPort(address) {
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9._-]+)):(\d+)$/.exec(address);
  if (!match) throw new Error(`Invalid listen address ${address}.`);
  return { host: match[1] ?? match[2], port: Number(match[3]) };
}

function listenOn(server, address) {
  const { host, port } = splitHostPort(address);
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(new Error(`Ingress could not listen on ${address}: ${error.message}`));
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
