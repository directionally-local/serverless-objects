import { createHash, createPrivateKey, generateKeyPairSync, X509Certificate, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CompactSign, calculateJwkThumbprint, importJWK } from "jose";
import CSR from "@root/csr";

export const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1_000;
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_POLL_ATTEMPTS = 120;

export function createAcmeCertificateManager({
  config,
  domains,
  stateDirectory,
  challenges = new Map(),
  onCertificate = () => {},
  log = () => {},
  csrLibrary = CSR,
  fetchImpl = globalThis.fetch,
  generateAccountKeyPair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
  generateCertificateKeyPair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!stateDirectory) throw new Error("ACME requires a service state directory.");
  if (!Array.isArray(domains) || domains.length === 0) throw new Error("ACME requires at least one exact hostname.");
  if (typeof fetchImpl !== "function") throw new Error("ACME requires the Node.js fetch API.");

  const identity = createHash("sha256")
    .update(JSON.stringify([config.directoryUrl, config.email, [...domains].sort()]))
    .digest("hex");
  const directory = join(stateDirectory, "acme", identity);
  const accountKeyPath = join(directory, "account-key.json");
  const accountPath = join(directory, "account.json");
  const certificatePath = join(directory, "certificate.json");
  let accountKey;
  let account;
  let current;
  let timer;
  let inFlight;
  let closed = false;

  async function ensureDirectory() {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700).catch(() => {});
    const acmeDirectory = join(stateDirectory, "acme");
    await mkdir(acmeDirectory, { recursive: true, mode: 0o700 });
    await chmod(acmeDirectory, 0o700).catch(() => {});
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => {});
  }

  async function readJson(file) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw new Error(`Could not read ACME state ${file}: ${error.message}`);
    }
  }

  async function writePrivateJson(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
      await chmod(file, 0o600);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function loadAccount() {
    const savedKey = await readJson(accountKeyPath);
    if (savedKey) {
      try {
        createPrivateKey({ key: savedKey, format: "jwk" });
      } catch (error) {
        throw new Error(`Stored ACME account key is invalid: ${error.message}`);
      }
      accountKey = savedKey;
    } else {
      accountKey = generateAccountKeyPair().privateKey.export({ format: "jwk" });
      await writePrivateJson(accountKeyPath, accountKey);
    }

    account = await readJson(accountPath);
    if (account && typeof account.kid !== "string") {
      throw new Error("Stored ACME account record is invalid.");
    }
  }

  async function issueCertificate() {
    const directoryInfo = await loadDirectory();
    const accountPrivateKey = await importJWK(accountKey, "ES256");
    const publicJwk = publicAccountJwk(accountKey);
    const thumbprint = await calculateJwkThumbprint(publicJwk, "sha256");
    let nonce;

    async function request(url, init = {}) {
      const response = await fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      nonce = response.headers.get("replay-nonce") ?? undefined;
      return response;
    }

    async function nextNonce() {
      if (nonce) {
        const value = nonce;
        nonce = undefined;
        return value;
      }
      for (const method of ["HEAD", "GET"]) {
        const response = await request(directoryInfo.newNonce, { method });
        if (response.ok && response.headers.get("replay-nonce")) {
          const value = nonce;
          nonce = undefined;
          return value;
        }
        if (response.status !== 405 && response.status !== 501) {
          throw await acmeResponseError(response, "Could not obtain an ACME replay nonce");
        }
      }
      throw new Error("The ACME server did not provide a replay nonce.");
    }

    async function signedRequest(url, payload, { useJwk = false } = {}) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const protectedHeader = {
          alg: "ES256",
          nonce: await nextNonce(),
          url,
          ...(useJwk ? { jwk: publicJwk } : { kid: account?.kid }),
        };
        const encodedPayload = payload === undefined
          ? new Uint8Array()
          : new TextEncoder().encode(JSON.stringify(payload));
        const compact = await new CompactSign(encodedPayload)
          .setProtectedHeader(protectedHeader)
          .sign(accountPrivateKey);
        const [protectedPart, payloadPart, signaturePart] = compact.split(".");
        const response = await request(url, {
          method: "POST",
          headers: { "content-type": "application/jose+json" },
          body: JSON.stringify({ protected: protectedPart, payload: payloadPart, signature: signaturePart }),
        });
        if (response.ok) return response;
        const problem = await response.clone().json().catch(() => undefined);
        if (problem?.type?.endsWith(":badNonce") && attempt < 2) continue;
        throw await acmeResponseError(response, problem?.detail ?? `ACME request to ${url} failed`);
      }
      throw new Error("The ACME server rejected repeated replay nonces.");
    }

    async function jsonRequest(url, payload, options) {
      const response = await signedRequest(url, payload, options);
      try {
        return await response.json();
      } catch (error) {
        throw new Error(`The ACME server returned invalid JSON from ${url}: ${error.message}`);
      }
    }

    async function ensureAccount() {
      if (account) return account;
      const response = await signedRequest(directoryInfo.newAccount, {
        contact: [`mailto:${config.email}`],
        termsOfServiceAgreed: config.agreeToTerms,
      }, { useJwk: true });
      const kid = response.headers.get("location");
      if (!kid) throw new Error("The ACME server created an account without returning its URL.");
      account = { kid: new URL(kid, config.directoryUrl).toString() };
      await writePrivateJson(accountPath, account);
      log(`Registered ACME account ${account.kid}.`);
      return account;
    }

    await ensureAccount();
    const certificateKey = generateCertificateKeyPair().privateKey.export({ format: "jwk" });
    const privateKeyPem = createPrivateKey({ key: certificateKey, format: "jwk" })
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const csr = await csrLibrary.csr({ key: certificateKey, domains, encoding: "der" });
    const orderResponse = await signedRequest(directoryInfo.newOrder, {
      identifiers: domains.map((value) => ({ type: "dns", value })),
    });
    const orderUrl = orderResponse.headers.get("location");
    if (!orderUrl) throw new Error("The ACME server created an order without returning its URL.");
    const order = await orderResponse.json();
    const authUrls = (order.authorizations ?? []).map((url) => new URL(url, config.directoryUrl).toString());
    if (!order.finalize || authUrls.length === 0) throw new Error("The ACME server returned an incomplete order.");

    const attemptTokens = new Set();
    const pendingChallenges = [];
    try {
      for (const authUrl of authUrls) {
        let authorization = await jsonRequest(authUrl, undefined);
        if (authorization.status === "valid") continue;
        if (authorization.status === "invalid") throw new Error(`ACME authorization failed for ${authorization.identifier?.value ?? "a domain"}.`);
        const hostname = authorization.identifier?.value?.toLowerCase();
        if (!hostname || !domains.includes(hostname)) throw new Error("The ACME server authorized a hostname that was not requested.");
        const challenge = authorization.challenges?.find((item) => item.type === "http-01");
        if (!challenge?.token || !challenge.url) throw new Error(`The ACME server offered no HTTP-01 challenge for ${hostname}.`);
        const keyAuthorization = `${challenge.token}.${thumbprint}`;
        challenges.set(challenge.token, { hostname, keyAuthorization });
        attemptTokens.add(challenge.token);
        pendingChallenges.push({ authUrl, challenge, hostname });
      }

      for (const { challenge } of pendingChallenges) {
        await signedRequest(new URL(challenge.url, config.directoryUrl).toString(), {});
      }
      for (const { authUrl, hostname } of pendingChallenges) {
        await pollResource(authUrl, jsonRequest, (authorization) => {
          if (authorization.status === "invalid") throw new Error(`ACME authorization failed for ${hostname}.`);
          return authorization.status === "valid";
        }, "authorization");
      }
    } finally {
      for (const token of attemptTokens) challenges.delete(token);
    }

    const finalizeUrl = new URL(order.finalize, config.directoryUrl).toString();
    const finalized = await jsonRequest(finalizeUrl, { csr: Buffer.from(csr).toString("base64url") });
    let completedOrder = finalized;
    if (completedOrder.status !== "valid") {
      completedOrder = await pollResource(orderUrl, jsonRequest, (value) => {
        if (value.status === "invalid") throw new Error("The ACME certificate order became invalid.");
        if (value.status === "ready") throw new Error("The ACME order is still ready after finalization; the server did not accept the CSR.");
        return value.status === "valid";
      }, "certificate order");
    }
    if (!completedOrder.certificate) throw new Error("The ACME server completed the order without a certificate URL.");
    const certificateResponse = await signedRequest(new URL(completedOrder.certificate, config.directoryUrl).toString(), undefined);
    const cert = `${(await certificateResponse.text()).trim()}\n`;
    const bundle = validateCertificateBundle({ cert, key: privateKeyPem, domains, now: now() });
    await writePrivateJson(certificatePath, { domains, ...bundle });
    log(`Stored ACME certificate for ${domains.join(", ")}; expires ${new Date(bundle.expiresAt).toISOString()}.`);
    return bundle;
  }

  async function loadDirectory() {
    let response;
    try {
      response = await fetchImpl(config.directoryUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (error) {
      throw new Error(`Could not reach the ACME directory ${config.directoryUrl}: ${error.message}`);
    }
    if (!response.ok) throw await acmeResponseError(response, "Could not load the ACME directory");
    const directoryInfo = await response.json();
    for (const endpoint of ["newNonce", "newAccount", "newOrder"]) {
      if (typeof directoryInfo[endpoint] !== "string") throw new Error(`The ACME directory is missing ${endpoint}.`);
      directoryInfo[endpoint] = new URL(directoryInfo[endpoint], config.directoryUrl).toString();
    }
    return directoryInfo;
  }

  async function pollResource(url, jsonRequest, complete, label) {
    let last;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      last = await jsonRequest(url, undefined);
      if (complete(last)) return last;
      const retryAfter = Number(last.retryAfter);
      await sleep(Number.isFinite(retryAfter) ? Math.max(250, Math.min(retryAfter * 1_000, 5_000)) : 1_000);
    }
    throw new Error(`Timed out waiting for the ACME ${label} to become valid (last status: ${last?.status ?? "unknown"}).`);
  }

  async function loadCertificate() {
    const cached = await readJson(certificatePath);
    if (!cached || !Array.isArray(cached.domains) || cached.domains.join("\0") !== domains.join("\0")) return undefined;
    try {
      return validateCertificateBundle({ cert: cached.cert, key: cached.key, domains, now: now() });
    } catch (error) {
      log(`Ignoring unusable stored ACME certificate: ${error.message}`);
      return undefined;
    }
  }

  function activate(bundle) {
    current = bundle;
    onCertificate(publicCertificate(bundle));
  }

  function scheduleRenewal(delayMs) {
    if (closed) return;
    clearTimer(timer);
    timer = setTimer(() => {
      renewNow().catch((error) => log(`ACME renewal failed: ${error.message}`));
    }, Math.max(0, Math.min(delayMs, 2_147_000_000)));
    timer.unref?.();
  }

  async function renewNow() {
    if (closed) return publicCertificate(current);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const fresh = await issueCertificate();
        if (closed) return publicCertificate(current);
        activate(fresh);
        scheduleRenewal(fresh.expiresAt - now() - RENEW_BEFORE_MS);
        return publicCertificate(current);
      } catch (error) {
        if (!current) throw error;
        log(`ACME renewal failed; keeping the current certificate: ${error.message}`);
        scheduleRenewal(RETRY_AFTER_FAILURE_MS);
        return publicCertificate(current);
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  function publicCertificate(bundle) {
    return bundle && { cert: Buffer.from(bundle.cert), key: Buffer.from(bundle.key) };
  }

  return {
    async start() {
      await ensureDirectory();
      await loadAccount();
      current = await loadCertificate();
      if (!current) {
        activate(await issueCertificate());
      } else {
        onCertificate(publicCertificate(current));
      }
      scheduleRenewal(current.expiresAt - now() - RENEW_BEFORE_MS);
      return publicCertificate(current);
    },
    renewNow,
    close() {
      closed = true;
      clearTimer(timer);
      challenges.clear();
    },
    get certificate() {
      return publicCertificate(current);
    },
  };
}

function publicAccountJwk(privateJwk) {
  return { crv: privateJwk.crv, kty: privateJwk.kty, x: privateJwk.x, y: privateJwk.y };
}

async function acmeResponseError(response, fallback) {
  const body = await response.clone().json().catch(() => undefined);
  const detail = body?.detail ?? body?.title ?? fallback;
  return new Error(`ACME HTTP ${response.status}: ${detail}`);
}

function validateCertificateBundle({ cert, key, domains, now }) {
  if (typeof cert !== "string" || !cert.includes("BEGIN CERTIFICATE") || typeof key !== "string") {
    throw new Error("ACME returned an invalid certificate bundle.");
  }
  const parsed = new X509Certificate(cert);
  const privateKey = createPrivateKey(key);
  if (!parsed.checkPrivateKey(privateKey)) throw new Error("ACME certificate does not match its private key.");
  const expiresAt = Date.parse(parsed.validTo);
  const validFrom = Date.parse(parsed.validFrom);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(validFrom) || expiresAt <= now || validFrom > now + 5 * 60_000) {
    throw new Error("ACME returned a certificate that is not currently valid.");
  }
  for (const domain of domains) {
    if (!parsed.checkHost(domain)) throw new Error(`ACME certificate does not cover ${domain}.`);
  }
  return { cert, key, expiresAt };
}
