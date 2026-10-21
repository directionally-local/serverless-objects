import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";
import { parseNativeDevArgs } from "./native/dev.js";

const ROOT_KEYS = new Set(["celld", "native", "ingress", "admin"]);
const NATIVE_KEYS = new Set(["project", "listen", "data_dir", "idle_evict_seconds", "threads", "thread_stall_seconds", "thread_memory_mb", "drain_seconds", "backup", "cluster"]);
const NATIVE_BACKUP_KEYS = new Set(["bucket", "mode", "interval_seconds", "retention_days", "endpoint", "region"]);
const NATIVE_CLUSTER_KEYS = new Set(["node_name", "lease_seconds", "peer_listen", "peer_advertise"]);
const CELLD_KEYS = new Set(["bucket", "endpoint", "region", "listen", "internal_listen"]);
const ADMIN_KEYS = new Set(["listen"]);
const INGRESS_KEYS = new Set(["listen", "redirect_http", "access_log", "tls", "acme", "routes"]);
const TLS_KEYS = new Set(["cert", "key"]);
const ACME_KEYS = new Set(["email", "agree_to_terms", "directory_url"]);
const ROUTE_KEYS = new Set(["hostname", "upstream", "tls"]);
const DEFAULT_LISTEN = "127.0.0.1:8080";
const DEFAULT_NATIVE_LISTEN = "127.0.0.1:8787";
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
  const config = parseSobjectsConfig(source, filePath, { baseDirectory: dirname(filePath) });
  if (config.native) {
    // Checked here so a service unit fails at install, not in a restart loop.
    try {
      await access(config.native.project);
    } catch {
      throw new Error(`${filePath} [native].project ${config.native.project} does not exist.`);
    }
  }
  return config;
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
  if (parsed.native !== undefined) {
    if (parsed.celld !== undefined) throw new Error(`${sourceName} must contain either [celld] or [native], not both.`);
    return parseNative(parsed, sourceName, baseDirectory);
  }
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

// [native] runs a project on the native engine: `sobjects up` starts it as
// `sobjects dev <project> --engine native` with the options below, so the
// flag parser stays the one place that checks them.
function parseNative(parsed, sourceName, baseDirectory) {
  const table = `${sourceName} [native]`;
  const native = parsed.native;
  if (!isRecord(native)) throw new Error(`${table} must be a table.`);
  rejectUnknownKeys(native, NATIVE_KEYS, table);
  if (parsed.admin !== undefined) {
    throw new Error(`${sourceName} [admin] is not available with [native] yet; it reads celld's operator API.`);
  }

  const project = resolvePath(requireString(native.project, `${table}.project`), baseDirectory);
  const listen = native.listen === undefined
    ? DEFAULT_NATIVE_LISTEN
    : requireString(native.listen, `${table}.listen`);
  validateListenAddress(listen, `${table}.listen`);
  // Node may bind "localhost" to ::1, while the ingress and clients use 127.0.0.1.
  const host = hostOf(listen) === "localhost" ? "127.0.0.1" : hostOf(listen);
  const args = [project, "--engine", "native", "--host", host, "--port", String(portOf(listen))];
  const env = {};
  const option = (key, flag, source = native, label = table) => {
    if (source[key] === undefined) return;
    if (typeof source[key] !== "number") throw new Error(`${label}.${key} must be a number.`);
    args.push(flag, String(source[key]));
  };
  let dataDirectory;
  if (native.data_dir !== undefined) {
    dataDirectory = resolvePath(requireString(native.data_dir, `${table}.data_dir`), baseDirectory);
  }
  option("idle_evict_seconds", "--idle-evict-seconds");
  option("threads", "--threads");
  option("thread_stall_seconds", "--thread-stall-seconds");
  option("thread_memory_mb", "--thread-memory-mb");
  option("drain_seconds", "--drain-seconds");

  let mode;
  if (native.backup !== undefined) {
    const label = `${table}.backup`;
    if (!isRecord(native.backup)) throw new Error(`${label} must be a table.`);
    rejectUnknownKeys(native.backup, NATIVE_BACKUP_KEYS, label);
    const bucket = requireString(native.backup.bucket, `${label}.bucket`);
    if (!/^s3:\/\/[^/\s]+(?:\/[^\s]*)?$/.test(bucket)) throw new Error(`${label}.bucket must be an s3:// URI with a bucket name.`);
    // A server should not lose acknowledged writes with its disk, so durable is the default here.
    mode = native.backup.mode === undefined ? "durable" : requireString(native.backup.mode, `${label}.mode`);
    if (!["interval", "durable"].includes(mode)) throw new Error(`${label}.mode must be "durable" or "interval".`);
    args.push("--backup-bucket", bucket, "--backup-mode", mode);
    option("interval_seconds", "--backup-interval-seconds", native.backup, label);
    option("retention_days", "--backup-retention-days", native.backup, label);
    if (native.backup.endpoint !== undefined) {
      const endpoint = requireString(native.backup.endpoint, `${label}.endpoint`);
      let url;
      try {
        url = new URL(endpoint);
      } catch {
        throw new Error(`${label}.endpoint must be a valid http(s) URL.`);
      }
      if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${label}.endpoint must use http or https.`);
      env.S3_ENDPOINT = endpoint;
    }
    if (native.backup.region !== undefined) env.AWS_REGION = requireString(native.backup.region, `${label}.region`);
  }

  if (native.cluster !== undefined) {
    const label = `${table}.cluster`;
    if (!isRecord(native.cluster)) throw new Error(`${label} must be a table.`);
    rejectUnknownKeys(native.cluster, NATIVE_CLUSTER_KEYS, label);
    if (mode !== "durable") throw new Error(`${label} needs [native.backup] with mode "durable".`);
    if (native.threads) throw new Error(`${label} can't be combined with [native].threads yet.`);
    args.push("--node-name", requireString(native.cluster.node_name, `${label}.node_name`));
    option("lease_seconds", "--lease-seconds", native.cluster, label);
    if (native.cluster.peer_listen !== undefined) {
      const peerListen = requireString(native.cluster.peer_listen, `${label}.peer_listen`);
      validateListenAddress(peerListen, `${label}.peer_listen`);
      if (portOf(peerListen) === portOf(listen) && sameHost(peerListen, listen)) {
        throw new Error(`${label}.peer_listen must differ from [native].listen.`);
      }
      args.push("--peer-listen", peerListen);
    }
    if (native.cluster.peer_advertise !== undefined) {
      if (native.cluster.peer_listen === undefined) throw new Error(`${label}.peer_advertise needs peer_listen.`);
      args.push("--peer-advertise", requireString(native.cluster.peer_advertise, `${label}.peer_advertise`));
    }
  }

  try {
    parseNativeDevArgs(args, baseDirectory);
  } catch (error) {
    throw new Error(`${table}: ${error.message}`);
  }

  const config = { listen, native: Object.freeze({ project, args: Object.freeze(args), env: Object.freeze(env), dataDirectory }) };
  if (parsed.ingress !== undefined) {
    config.ingress = parseIngress(parsed.ingress, config, sourceName, baseDirectory, "[native].listen");
    const peerListen = native.cluster?.peer_listen;
    if (peerListen && [config.ingress.listen, config.ingress.redirectHttp].some((address) => address && portOf(address) === portOf(peerListen) && sameHost(address, peerListen))) {
      throw new Error(`${table}.cluster.peer_listen must differ from the [ingress] listeners.`);
    }
  }
  return Object.freeze(config);
}

function parseIngress(ingress, celld, sourceName, baseDirectory, upstreamName = "[celld].listen") {
  const table = `${sourceName} [ingress]`;
  if (!isRecord(ingress)) throw new Error(`${table} must be a table.`);
  rejectUnknownKeys(ingress, INGRESS_KEYS, table);

  const listen = requireString(ingress.listen, `${table}.listen`);
  validateListenAddress(listen, `${table}.listen`);
  if (portOf(listen) === portOf(celld.listen) && sameHost(listen, celld.listen)) {
    throw new Error(`${table}.listen must differ from ${upstreamName}; the ingress proxies to it.`);
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
