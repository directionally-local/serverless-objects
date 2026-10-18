import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";

const ROOT_KEYS = new Set(["celld", "ingress"]);
const CELLD_KEYS = new Set(["bucket", "endpoint", "region", "listen"]);
const INGRESS_KEYS = new Set(["listen", "redirect_http", "access_log", "tls", "routes"]);
const TLS_KEYS = new Set(["cert", "key"]);
const ROUTE_KEYS = new Set(["hostname", "upstream", "tls"]);
const DEFAULT_LISTEN = "127.0.0.1:8080";

export async function loadSobjectsConfig(filePath) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Could not find ${filePath}. Create an sobjects.toml with a [celld] table and a bucket.`,
      );
    }
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
  return parseSobjectsConfig(source, filePath, { baseDirectory: dirname(filePath) });
}

export function parseSobjectsConfig(source, sourceName = "sobjects.toml", { baseDirectory = process.cwd() } = {}) {
  let parsed;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new Error(`Invalid TOML in ${sourceName}: ${error.message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${sourceName} must contain a [celld] table.`);

  rejectUnknownKeys(parsed, ROOT_KEYS, sourceName);
  const celld = parsed.celld;
  if (!isRecord(celld)) throw new Error(`${sourceName} must contain a [celld] table.`);
  rejectUnknownKeys(celld, CELLD_KEYS, `${sourceName} [celld]`);

  const bucket = requireString(celld.bucket, `${sourceName} [celld].bucket`);
  if (!/^(?:s3|gs|az):\/\/[^/\s]+(?:\/[^\s]*)?$/.test(bucket)) {
    throw new Error(
      `${sourceName} [celld].bucket must be an s3://, gs://, or az:// URI with a bucket/container name.`,
    );
  }

  const listen = celld.listen === undefined
    ? DEFAULT_LISTEN
    : requireString(celld.listen, `${sourceName} [celld].listen`);
  validateListenAddress(listen, `${sourceName} [celld].listen`);

  const config = { bucket, listen };
  if (celld.endpoint !== undefined) {
    config.endpoint = requireString(celld.endpoint, `${sourceName} [celld].endpoint`);
    let endpoint;
    try {
      endpoint = new URL(config.endpoint);
    } catch {
      throw new Error(`${sourceName} [celld].endpoint must be a valid http(s) URL.`);
    }
    if (!(["http:", "https:"].includes(endpoint.protocol))) {
      throw new Error(`${sourceName} [celld].endpoint must use http or https.`);
    }
  }
  if (celld.region !== undefined) {
    config.region = requireString(celld.region, `${sourceName} [celld].region`);
  }
  if (parsed.ingress !== undefined) {
    config.ingress = parseIngress(parsed.ingress, config, sourceName, baseDirectory);
  }
  return Object.freeze(config);
}

function parseIngress(ingress, celld, sourceName, baseDirectory) {
  const table = `${sourceName} [ingress]`;
  if (!isRecord(ingress)) throw new Error(`${table} must be a table.`);
  rejectUnknownKeys(ingress, INGRESS_KEYS, table);

  const listen = requireString(ingress.listen, `${table}.listen`);
  validateListenAddress(listen, `${table}.listen`);
  if (portOf(listen) === portOf(celld.listen) && sameHost(listen, celld.listen)) {
    throw new Error(`${table}.listen must differ from [celld].listen; the ingress proxies to celld.`);
  }

  const tls = ingress.tls === undefined
    ? undefined
    : parseTls(ingress.tls, `${table}.tls`, baseDirectory);
  if (!tls && !isLoopback(listen)) {
    throw new Error(
      `${table}.listen ${listen} is not loopback; add [ingress.tls] cert and key before exposing the ingress.`,
    );
  }

  let redirectHttp;
  if (ingress.redirect_http !== undefined) {
    if (!tls) throw new Error(`${table}.redirect_http requires [ingress.tls].`);
    redirectHttp = requireString(ingress.redirect_http, `${table}.redirect_http`);
    validateListenAddress(redirectHttp, `${table}.redirect_http`);
  }

  let accessLog;
  if (ingress.access_log !== undefined) {
    accessLog = requireString(ingress.access_log, `${table}.access_log`);
    if (accessLog !== "-") accessLog = resolvePath(accessLog, baseDirectory);
  }

  if (!Array.isArray(ingress.routes) || ingress.routes.length === 0) {
    throw new Error(`${table} requires at least one [[ingress.routes]] entry with a hostname.`);
  }
  const defaultUpstream = `http://${loopbackFor(celld.listen)}`;
  const seen = new Set();
  const routes = ingress.routes.map((route, index) => {
    const label = `${table}.routes[${index}]`;
    if (!isRecord(route)) throw new Error(`${label} must be a table.`);
    rejectUnknownKeys(route, ROUTE_KEYS, label);
    const hostname = requireString(route.hostname, `${label}.hostname`).toLowerCase();
    if (!/^(?:\*|(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/.test(hostname)) {
      throw new Error(`${label}.hostname must be a hostname, a *.wildcard hostname, or *.`);
    }
    if (seen.has(hostname)) throw new Error(`${label}.hostname ${hostname} is listed more than once.`);
    seen.add(hostname);

    const result = { hostname, upstream: defaultUpstream };
    if (route.upstream !== undefined) {
      result.upstream = requireString(route.upstream, `${label}.upstream`);
      let url;
      try {
        url = new URL(result.upstream);
      } catch {
        throw new Error(`${label}.upstream must be an http:// URL.`);
      }
      if (url.protocol !== "http:" || url.pathname !== "/" || url.search) {
        throw new Error(`${label}.upstream must be an http:// origin without a path.`);
      }
      result.upstream = url.origin;
    }
    if (route.tls !== undefined) {
      if (!tls) throw new Error(`${label}.tls requires a default [ingress.tls] certificate.`);
      result.tls = parseTls(route.tls, `${label}.tls`, baseDirectory);
    }
    return Object.freeze(result);
  });

  const result = { listen, routes: Object.freeze(routes) };
  if (tls) result.tls = tls;
  if (redirectHttp) result.redirectHttp = redirectHttp;
  if (accessLog) result.accessLog = accessLog;
  return Object.freeze(result);
}

function parseTls(value, label, baseDirectory) {
  if (!isRecord(value)) throw new Error(`${label} must be a table with cert and key.`);
  rejectUnknownKeys(value, TLS_KEYS, label);
  return Object.freeze({
    cert: resolvePath(requireString(value.cert, `${label}.cert`), baseDirectory),
    key: resolvePath(requireString(value.key, `${label}.key`), baseDirectory),
  });
}

function resolvePath(value, baseDirectory) {
  return isAbsolute(value) ? value : resolve(baseDirectory, value);
}

function hostOf(address) {
  return address.slice(0, address.lastIndexOf(":")).replace(/^\[(.*)\]$/, "$1");
}

function portOf(address) {
  return Number(address.slice(address.lastIndexOf(":") + 1));
}

function sameHost(left, right) {
  const wildcard = new Set(["0.0.0.0", "::"]);
  const a = hostOf(left);
  const b = hostOf(right);
  return a === b || wildcard.has(a) || wildcard.has(b);
}

function isLoopback(address) {
  const host = hostOf(address);
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

function loopbackFor(address) {
  const host = hostOf(address);
  const port = portOf(address);
  if (host === "0.0.0.0" || host === "localhost") return `127.0.0.1:${port}`;
  if (host === "::") return `[::1]:${port}`;
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function rejectUnknownKeys(record, allowed, sourceName) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Unknown config key '${key}' in ${sourceName}.`);
  }
}

function requireString(value, key) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

function validateListenAddress(value, key) {
  const match = value.match(/^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+):(\d+)$/);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error(`${key} must be a host:port address with a port from 1 to 65535.`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
