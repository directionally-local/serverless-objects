import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";

const ROOT_KEYS = new Set(["celld", "ingress", "admin"]);
const CELLD_KEYS = new Set(["bucket", "endpoint", "region", "listen", "internal_listen"]);
const ADMIN_KEYS = new Set(["listen"]);
const INGRESS_KEYS = new Set(["listen", "redirect_http", "access_log", "tls", "acme", "routes"]);
const TLS_KEYS = new Set(["cert", "key"]);
const ACME_KEYS = new Set(["email", "agree_to_terms", "directory_url"]);
const ROUTE_KEYS = new Set(["hostname", "upstream", "tls"]);
const DEFAULT_LISTEN = "127.0.0.1:8080";
const DEFAULT_ACME_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";

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
  if (celld.internal_listen !== undefined) {
    config.internalListen = requireString(celld.internal_listen, `${sourceName} [celld].internal_listen`);
    validateListenAddress(config.internalListen, `${sourceName} [celld].internal_listen`);
  }
  if (parsed.admin !== undefined) {
    const table = `${sourceName} [admin]`;
    if (!isRecord(parsed.admin)) throw new Error(`${table} must be a table.`);
    rejectUnknownKeys(parsed.admin, ADMIN_KEYS, table);
    const listen = requireString(parsed.admin.listen, `${table}.listen`);
    validateListenAddress(listen, `${table}.listen`);
    if (!isLoopback(listen)) {
      throw new Error(`${table}.listen must be a loopback address; the admin API has no authentication.`);
    }
    config.admin = Object.freeze({ listen });
    // The admin API reads celld's operator listener, so it needs a known port.
    config.internalListen ??= `127.0.0.1:${portOf(config.listen) + 1}`;
  }
  if (config.internalListen) {
    if (!isLoopback(config.internalListen)) {
      throw new Error(
        `${sourceName} [celld].internal_listen must be loopback; celld's operator API there is unauthenticated.`,
      );
    }
    const taken = [config.listen, config.admin?.listen].filter(Boolean);
    if (taken.some((address) => portOf(address) === portOf(config.internalListen) && sameHost(address, config.internalListen))) {
      throw new Error(`${sourceName} [celld].internal_listen must not reuse another listener's address.`);
    }
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
  const acme = ingress.acme === undefined
    ? undefined
    : parseAcme(ingress.acme, `${table}.acme`);
  if (tls && acme) throw new Error(`${table} must configure either [ingress.tls] or [ingress.acme], not both.`);
  if (!tls && !acme && !isLoopback(listen)) {
    throw new Error(
      `${table}.listen ${listen} is not loopback; add [ingress.tls] cert and key or [ingress.acme] before exposing the ingress.`,
    );
  }

  let redirectHttp;
  if (ingress.redirect_http !== undefined) {
    if (!tls && !acme) throw new Error(`${table}.redirect_http requires [ingress.tls] or [ingress.acme].`);
    redirectHttp = requireString(ingress.redirect_http, `${table}.redirect_http`);
    validateListenAddress(redirectHttp, `${table}.redirect_http`);
  }
  if (acme && !redirectHttp) {
    throw new Error(`${table}.acme requires redirect_http on port 80 for HTTP-01 validation.`);
  }
  if (acme && portOf(redirectHttp) !== 80) {
    throw new Error(`${table}.acme requires [ingress].redirect_http to listen on port 80 for HTTP-01 validation.`);
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
      if (!tls && !acme) throw new Error(`${label}.tls requires a default [ingress.tls] or [ingress.acme] certificate.`);
      result.tls = parseTls(route.tls, `${label}.tls`, baseDirectory);
    }
    return Object.freeze(result);
  });

  const result = { listen, routes: Object.freeze(routes) };
  if (tls) result.tls = tls;
  if (acme) {
    const domains = routes.filter((route) => !route.tls).map((route) => route.hostname);
    if (domains.length === 0) throw new Error(`${table}.acme has no route that needs an ACME certificate.`);
    const unsupported = domains.find((hostname) => hostname === "*" || hostname.startsWith("*."));
    if (unsupported) throw new Error(`${table}.acme cannot issue HTTP-01 certificates for wildcard route ${unsupported}.`);
    result.acme = Object.freeze({ ...acme, domains: Object.freeze(domains) });
  }
  if (redirectHttp) result.redirectHttp = redirectHttp;
  if (accessLog) result.accessLog = accessLog;
  return Object.freeze(result);
}

function parseAcme(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be a table.`);
  rejectUnknownKeys(value, ACME_KEYS, label);
  const email = requireString(value.email, `${label}.email`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`${label}.email must be a valid contact email address.`);
  }
  if (value.agree_to_terms !== true) {
    throw new Error(`${label}.agree_to_terms must be true to enable automatic certificate issuance.`);
  }
  const directoryUrl = value.directory_url === undefined
    ? DEFAULT_ACME_DIRECTORY
    : requireString(value.directory_url, `${label}.directory_url`);
  let parsed;
  try {
    parsed = new URL(directoryUrl);
  } catch {
    throw new Error(`${label}.directory_url must be a valid HTTPS URL (HTTP is allowed only for loopback test servers).`);
  }
  const localHttp = parsed.protocol === "http:" && (
    parsed.hostname === "localhost" || parsed.hostname === "::1" || /^127\./.test(parsed.hostname)
  );
  if ((parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label}.directory_url must use HTTPS (HTTP is allowed only for loopback test servers) and must not include credentials or a fragment.`);
  }
  return Object.freeze({ email, agreeToTerms: true, directoryUrl: parsed.toString() });
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
