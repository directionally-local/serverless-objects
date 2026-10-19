import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createAcmeCertificateManager } from "../src/acme.js";

const stateDirectories = [];
const fixturePath = new URL("./fixtures/tls/default-cert.pem", import.meta.url);
const keyPath = new URL("./fixtures/tls/default-key.pem", import.meta.url);
const fixtureKeyGenerator = () => ({ privateKey: createPrivateKey(readFileSync(keyPath)) });

const endpoints = {
  directory: "https://acme.test/directory",
  nonce: "https://acme.test/nonce",
  account: "https://acme.test/account/1",
  newOrder: "https://acme.test/order",
  order: "https://acme.test/orders/1",
  authorization: "https://acme.test/authz/1",
  challenge: "https://acme.test/challenges/1",
  finalize: "https://acme.test/orders/1/finalize",
  certificate: "https://acme.test/certificates/1",
};

const fakeCertificate = readFileSync(fixturePath, "utf8");

afterEach(async () => {
  await Promise.all(stateDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-acme-test-"));
  stateDirectories.push(directory);
  return directory;
}

function fakeAcme({ challenges = new Map(), failNewOrder = () => false } = {}) {
  let nonceCounter = 0;
  let orderPolls = 0;
  let challengePresented = false;
  let finalized = false;
  let finalizationCount = 0;
  let newOrderCount = 0;
  const requests = [];

  function json(status, body, headers = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "replay-nonce": `nonce-${++nonceCounter}`,
        ...headers,
      },
    });
  }

  async function fetchImpl(input, init = {}) {
    const url = String(input);
    const method = init.method ?? "GET";
    requests.push({ url, method });
    if (url === endpoints.directory && method === "GET") {
      return json(200, {
        newNonce: endpoints.nonce,
        newAccount: endpoints.account,
        newOrder: endpoints.newOrder,
      });
    }
    if (url === endpoints.nonce && method === "HEAD") {
      return new Response(null, { status: 204, headers: { "replay-nonce": `nonce-${++nonceCounter}` } });
    }
    if (method !== "POST") return json(405, { detail: "POST required" });

    const jws = JSON.parse(String(init.body));
    const encodedHeader = jws.protected;
    const encodedPayload = jws.payload;
    assert.ok(encodedHeader && jws.signature);
    const protectedHeader = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    const payloadText = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const payload = payloadText ? JSON.parse(payloadText) : undefined;
    assert.equal(protectedHeader.url, url);
    assert.match(protectedHeader.nonce, /^nonce-/);
    assert.equal(init.headers["content-type"], "application/jose+json");

    if (url === endpoints.account) {
      assert.equal(protectedHeader.alg, "ES256");
      assert.equal(protectedHeader.jwk.kty, "EC");
      assert.equal(protectedHeader.jwk.d, undefined);
      assert.deepEqual(payload, {
        contact: ["mailto:ops@example.com"],
        termsOfServiceAgreed: true,
      });
      return json(201, { status: "valid" }, { location: endpoints.account });
    }
    if (url === endpoints.newOrder) {
      newOrderCount += 1;
      if (failNewOrder()) return json(503, { detail: "simulated issuer outage" });
      assert.equal(protectedHeader.kid, endpoints.account);
      assert.deepEqual(payload.identifiers, [{ type: "dns", value: "default.example.test" }]);
      return json(201, {
        status: "pending",
        authorizations: [endpoints.authorization],
        finalize: endpoints.finalize,
      }, { location: endpoints.order });
    }
    if (url === endpoints.authorization) {
      if (payload !== undefined) assert.deepEqual(payload, {});
      if (challengePresented) {
        return json(200, { status: "valid", identifier: { type: "dns", value: "default.example.test" } });
      }
      return json(200, {
        status: "pending",
        identifier: { type: "dns", value: "default.example.test" },
        challenges: [{ type: "http-01", url: endpoints.challenge, token: "fake-token" }],
      });
    }
    if (url === endpoints.challenge) {
      assert.deepEqual(payload, {});
      assert.equal(challenges.get("fake-token")?.hostname, "default.example.test");
      assert.match(challenges.get("fake-token")?.keyAuthorization, /^fake-token\.[A-Za-z0-9_-]+$/);
      challengePresented = true;
      return json(200, { status: "pending" });
    }
    if (url === endpoints.finalize) {
      finalizationCount += 1;
      assert.equal(typeof payload.csr, "string");
      assert.ok(Buffer.from(payload.csr, "base64url").length > 20);
      finalized = true;
      return json(200, { status: "processing" });
    }
    if (url === endpoints.order) {
      assert.equal(payload, undefined, "order polling must use POST-as-GET");
      if (!finalized) return json(200, { status: "ready" });
      orderPolls += 1;
      return json(200, orderPolls === 1
        ? { status: "processing" }
        : { status: "valid", certificate: endpoints.certificate });
    }
    if (url === endpoints.certificate) {
      assert.equal(payload, undefined, "certificate retrieval must use POST-as-GET");
      return new Response(fakeCertificate, {
        status: 200,
        headers: {
          "content-type": "application/pem-certificate-chain",
          "replay-nonce": `nonce-${++nonceCounter}`,
        },
      });
    }
    return json(404, { detail: `Unexpected ACME endpoint ${url}` });
  }

  return {
    fetchImpl,
    requests,
    get orderPolls() { return orderPolls; },
    get finalizationCount() { return finalizationCount; },
    get newOrderCount() { return newOrderCount; },
  };
}

const config = {
  email: "ops@example.com",
  agreeToTerms: true,
  directoryUrl: endpoints.directory,
};

function timers() {
  const scheduled = [];
  return {
    scheduled,
    setTimer(fn, delay) {
      const timer = { fn, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimer() {},
  };
}

function makeManager({ stateDirectory, issuer, challenges = new Map(), log = () => {}, timer = timers() }) {
  return {
    challenges,
    timer,
    manager: createAcmeCertificateManager({
      config,
      domains: ["default.example.test"],
      stateDirectory,
      challenges,
      fetchImpl: issuer.fetchImpl,
      generateCertificateKeyPair: fixtureKeyGenerator,
      log,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      sleep: async () => {},
    }),
  };
}

test("performs ACME HTTP-01 issuance, securely persists state, and reuses a valid cached certificate", async () => {
  const stateDirectory = await makeStateDirectory();
  const challengeTokens = new Map();
  const issuer = fakeAcme({ challenges: challengeTokens });
  const timer = timers();
  const { manager } = makeManager({ stateDirectory, issuer, challenges: challengeTokens, timer });

  const certificate = await manager.start();
  assert.ok(certificate.cert.includes(Buffer.from("BEGIN CERTIFICATE")));
  assert.equal(challengeTokens.size, 0);
  assert.equal(issuer.finalizationCount, 1);
  assert.equal(issuer.orderPolls, 2);
  assert.equal(timer.scheduled.length, 1);

  const acmeDirectory = join(stateDirectory, "acme");
  const [identity] = await readdir(acmeDirectory);
  const identityDirectory = join(acmeDirectory, identity);
  for (const name of ["account-key.json", "account.json", "certificate.json"]) {
    const file = join(identityDirectory, name);
    assert.equal((await stat(file)).mode & 0o777, 0o600, `${name} permissions`);
    assert.ok((await readFile(file, "utf8")).length > 0);
  }
  assert.equal((await stat(identityDirectory)).mode & 0o777, 0o700);
  manager.close();

  const cachedIssuer = fakeAcme();
  const cached = makeManager({ stateDirectory, issuer: cachedIssuer, timer }).manager;
  const reused = await cached.start();
  assert.deepEqual(reused, certificate);
  assert.equal(cachedIssuer.newOrderCount, 0);
  cached.close();
});

test("keeps a valid certificate and schedules retry if order creation fails during renewal", async () => {
  const stateDirectory = await makeStateDirectory();
  let failing = false;
  const logs = [];
  const challengeTokens = new Map();
  const issuer = fakeAcme({ challenges: challengeTokens, failNewOrder: () => failing });
  const { manager } = makeManager({ stateDirectory, issuer, challenges: challengeTokens, log: (message) => logs.push(message) });
  const initial = await manager.start();
  failing = true;
  const stillServing = await manager.renewNow();
  assert.deepEqual(stillServing, initial);
  assert.equal(issuer.newOrderCount, 2);
  assert.equal(challengeTokens.size, 0);
  assert.ok(logs.some((message) => message.includes("keeping the current certificate")));
  manager.close();
});
