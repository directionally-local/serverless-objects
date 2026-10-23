import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, createServer as createTcpServer } from "node:net";
import { networkInterfaces } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { afterEach, test } from "node:test";
import { createRouter, HEALTH_PATH, hostnameMatches, isLoopbackPeer, startIngress } from "../src/ingress.js";

const fixture = (name) => new URL(`./fixtures/tls/${name}`, import.meta.url).pathname;
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startUpstream() {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.stringify({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(200, { "content-type": "application/json", "x-upstream": "yes", connection: "keep-alive" });
      response.end(payload);
    });
  });
  server.on("upgrade", (request, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `X-Seen-Host: ${request.headers.host}\r\nX-Seen-Proto: ${request.headers["x-forwarded-proto"]}\r\n\r\n`,
    );
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
    socket.on("end", () => socket.end());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function ingress(options) {
  const instance = await startIngress({ listen: "127.0.0.1:0", ...options });
  cleanups.push(() => instance.close());
  return instance;
}

function get(port, { host, path = "/", headers = {}, method = "GET", body, secure = false, servername } = {}) {
  return new Promise((resolve, reject) => {
    const send = secure ? httpsRequest : httpRequest;
    const request = send({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { host, ...headers },
      servername,
      rejectUnauthorized: false,
      agent: false,
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text, socket: response.socket }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("matches exact hostnames before wildcards and catch-alls", () => {
  const router = createRouter([
    { hostname: "*", upstream: "http://127.0.0.1:1" },
    { hostname: "*.example.test", upstream: "http://127.0.0.1:2" },
    { hostname: "api.example.test", upstream: "http://127.0.0.1:3" },
  ]);
  assert.equal(router.match("API.example.test:443").target.port, 3);
  assert.equal(router.match("chat.example.test").target.port, 2);
  assert.equal(router.match("example.test").target.port, 1);
  assert.equal(router.match(undefined), undefined);
  assert.equal(hostnameMatches("*.example.test", "example.test"), false);
  assert.equal(hostnameMatches("*.example.test", "a.b.example.test"), true);
  assert.throws(() => createRouter([]), /at least one route/);
  assert.throws(() => createRouter([{ hostname: "a", upstream: "https://127.0.0.1:1" }]), /must use http/);
});

test("proxies requests, rewrites forwarding headers, and logs without query strings", async () => {
  const upstream = await startUpstream();
  const log = [];
  const { address } = await ingress({
    routes: [{ hostname: "app.example.test", upstream }],
    accessLog: (entry) => log.push(entry),
  });

  const response = await get(address.port, {
    host: "app.example.test",
    path: "/items?token=secret",
    method: "POST",
    body: "hello",
    headers: { "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "6.6.6.6", "x-sobjects-inspect": "guess", "x-app": "1" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-upstream"], "yes");
  const echoed = JSON.parse(response.text);
  assert.equal(echoed.url, "/items?token=secret");
  assert.equal(echoed.body, "hello");
  assert.equal(echoed.headers.host, "app.example.test");
  assert.equal(echoed.headers["x-app"], "1");
  assert.equal(echoed.headers["x-forwarded-for"], "127.0.0.1");
  assert.equal(echoed.headers["cf-connecting-ip"], "127.0.0.1");
  assert.equal(echoed.headers["x-forwarded-proto"], "http");
  assert.equal(echoed.headers["x-sobjects-inspect"], undefined);

  assert.equal(log.length, 1);
  assert.equal(log[0].path, "/items");
  assert.equal(log[0].status, 200);
  assert.equal(log[0].route, "app.example.test");
  assert.equal(log[0].bytes, Buffer.byteLength(response.text));
});

test("rejects unknown hosts and reports unavailable upstreams", async () => {
  const { address } = await ingress({
    routes: [{ hostname: "app.example.test", upstream: "http://127.0.0.1:1" }],
  });
  assert.equal((await get(address.port, { host: "other.example.test" })).status, 421);
  assert.equal((await get(address.port, { host: "app.example.test" })).status, 502);

  const health = await get(address.port, { host: "anything", path: HEALTH_PATH });
  assert.equal(health.status, 503);
  assert.deepEqual(JSON.parse(health.text), {
    status: "degraded",
    upstreams: { "http://127.0.0.1:1": "unreachable" },
  });
});

const externalAddress = Object.values(networkInterfaces()).flat()
  .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;

test("hides upstream addresses from remote health checks", { skip: !externalAddress && "no non-loopback IPv4 address" }, async () => {
  const { address } = await ingress({ listen: "0.0.0.0:0", routes: [{ hostname: "*", upstream: "http://127.0.0.1:1" }] });
  const remote = await new Promise((resolve, reject) => {
    httpRequest({ host: externalAddress, port: address.port, path: HEALTH_PATH, headers: { host: "x" }, agent: false }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
    }).on("error", reject).end();
  });
  assert.equal(remote.status, 503);
  assert.deepEqual(JSON.parse(remote.text), { status: "degraded" });
  const local = await get(address.port, { host: "x", path: HEALTH_PATH });
  assert.deepEqual(JSON.parse(local.text).upstreams, { "http://127.0.0.1:1": "unreachable" });
});

test("recognizes loopback peers", () => {
  for (const address of ["127.0.0.1", "127.8.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackPeer(address), true, address);
  for (const address of ["10.0.0.1", "::ffff:10.0.0.1", "192.0.2.127", "fe80::1", "", undefined]) assert.equal(isLoopbackPeer(address), false, address);
});

test("health checks share one upstream connection", async () => {
  let connections = 0;
  const upstream = createTcpServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => upstream.close(resolve)));
  const { address } = await ingress({ routes: [{ hostname: "*", upstream: `http://127.0.0.1:${upstream.address().port}` }] });
  const results = await Promise.all(Array.from({ length: 20 }, () => get(address.port, { host: "x", path: HEALTH_PATH })));
  assert.ok(results.every((result) => result.status === 200));
  assert.equal((await get(address.port, { host: "x", path: HEALTH_PATH })).status, 200);
  assert.equal(connections, 1);
});

test("reports healthy upstreams", async () => {
  const upstream = await startUpstream();
  const { address } = await ingress({ routes: [{ hostname: "*", upstream }] });
  const health = await get(address.port, { host: "x", path: HEALTH_PATH });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.text).status, "ok");
});

test("tunnels WebSocket upgrades in both directions", async () => {
  const upstream = await startUpstream();
  const log = [];
  const { address } = await ingress({
    routes: [{ hostname: "app.example.test", upstream }],
    accessLog: (entry) => log.push(entry),
  });

  const socket = connect(address.port, "127.0.0.1");
  cleanups.push(() => socket.destroy());
  let received = "";
  socket.on("data", (chunk) => { received += chunk; });
  socket.write(
    "GET /socket HTTP/1.1\r\nHost: app.example.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  await waitFor(() => received.includes("\r\n\r\n"), 2_000, () => received);
  assert.match(received, /^HTTP\/1\.1 101/);
  assert.match(received, /X-Seen-Host: app\.example\.test/);
  assert.match(received, /X-Seen-Proto: http/);

  socket.write("ping");
  await waitFor(() => received.endsWith("echo:ping"), 2_000, () => JSON.stringify(received));
  socket.destroy();
  await waitFor(() => log.length === 1, 2_000, () => "no access log entry");
  assert.equal(log[0].status, 101);
  assert.equal(log[0].upgrade, true);
});

test("terminates TLS with per-route certificates selected by SNI", async () => {
  const upstream = await startUpstream();
  const { address } = await ingress({
    tls: { cert: fixture("default-cert.pem"), key: fixture("default-key.pem") },
    routes: [
      { hostname: "default.example.test", upstream },
      {
        hostname: "other.example.test",
        upstream,
        tls: { cert: fixture("other-cert.pem"), key: fixture("other-key.pem") },
      },
    ],
  });

  assert.equal(await peerCommonName(address.port, "default.example.test"), "default.example.test");
  assert.equal(await peerCommonName(address.port, "other.example.test"), "other.example.test");

  const response = await get(address.port, {
    host: "other.example.test",
    servername: "other.example.test",
    secure: true,
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).headers["x-forwarded-proto"], "https");
});

test("redirects plaintext requests for known hosts to HTTPS", async () => {
  const upstream = await startUpstream();
  const instance = await startIngress({
    listen: "127.0.0.1:0",
    redirectHttp: "127.0.0.1:0",
    tls: { cert: fixture("default-cert.pem"), key: fixture("default-key.pem") },
    routes: [{ hostname: "app.example.test", upstream }],
  });
  cleanups.push(() => instance.close());
  const redirect = instance.servers[1].address();
  const response = await get(redirect.port, { host: "app.example.test", path: "/a?b=c" });
  assert.equal(response.status, 308);
  assert.equal(response.headers.location, `https://app.example.test:${instance.address.port}/a?b=c`);
  assert.equal((await get(redirect.port, { host: "evil.test" })).status, 421);
});

test("serves active HTTP-01 challenges on the redirect listener and keeps normal redirects", async () => {
  const upstream = await startUpstream();
  const log = [];
  const instance = await startIngress({
    listen: "127.0.0.1:0",
    redirectHttp: "127.0.0.1:0",
    acme: { domains: ["default.example.test"] },
    routes: [{ hostname: "default.example.test", upstream }],
    accessLog: (entry) => log.push(entry),
    createAcmeManager: ({ challenges, onCertificate }) => ({
      async start() {
        challenges.set("token-123", {
          hostname: "default.example.test",
          keyAuthorization: "token-123.account-thumbprint",
        });
        const certificate = {
          cert: readFileSync(fixture("default-cert.pem")),
          key: readFileSync(fixture("default-key.pem")),
        };
        onCertificate(certificate);
        return certificate;
      },
      close() {},
    }),
  });
  cleanups.push(() => instance.close());
  const redirectPort = instance.servers[1].address().port;
  const challengePath = "/.well-known/acme-challenge/token-123";

  const challenge = await get(redirectPort, { host: "default.example.test", path: challengePath });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.text, "token-123.account-thumbprint");
  assert.equal((await get(redirectPort, { host: "other.example.test", path: challengePath })).status, 404);
  assert.equal((await get(redirectPort, { host: "default.example.test", path: "/.well-known/acme-challenge/missing" })).status, 404);

  const redirect = await get(redirectPort, { host: "default.example.test", path: "/app?secret=ignored" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, `https://default.example.test:${instance.address.port}/app?secret=ignored`);
  assert.equal(log[0].path, "/.well-known/acme-challenge/:token");
});

test("reloads certificates from disk", async () => {
  const upstream = await startUpstream();
  let certificate = "default";
  const { address, reloadCertificates } = await ingress({
    tls: { cert: "cert", key: "key" },
    routes: [{ hostname: "*", upstream }],
    readFile: (path) => readFileSync(fixture(`${certificate}-${path}.pem`)),
  });
  assert.equal(await peerCommonName(address.port, "a.test"), "default.example.test");
  certificate = "other";
  reloadCertificates();
  assert.equal(await peerCommonName(address.port, "a.test"), "other.example.test");
});

test("fails clearly when certificate files are missing", async () => {
  await assert.rejects(
    startIngress({
      listen: "127.0.0.1:0",
      tls: { cert: "/missing/cert.pem", key: "/missing/key.pem" },
      routes: [{ hostname: "*", upstream: "http://127.0.0.1:1" }],
    }),
    /Could not read ingress TLS certificate \/missing\/cert\.pem/,
  );
});

function peerCommonName(port, servername) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false }, () => {
      const name = socket.getPeerCertificate().subject.CN;
      socket.end();
      resolve(name);
    });
    socket.on("error", reject);
  });
}

async function waitFor(predicate, timeoutMs = 2_000, describe = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for condition. ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("close tears down open WebSocket tunnels", async () => {
  const upstream = await startUpstream();
  const instance = await startIngress({ listen: "127.0.0.1:0", routes: [{ hostname: "*", upstream }] });
  const socket = connect(instance.address.port, "127.0.0.1");
  let received = "";
  let closed = false;
  socket.on("data", (chunk) => { received += chunk; });
  socket.on("close", () => { closed = true; });
  socket.write("GET / HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  await waitFor(() => received.includes("\r\n\r\n"));
  await instance.close();
  await waitFor(() => closed);
});
