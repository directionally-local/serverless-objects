import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";

const ROOT_KEYS = new Set(["celld"]);
const CELLD_KEYS = new Set(["bucket", "endpoint", "region", "listen"]);
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
  return parseSobjectsConfig(source, filePath);
}

export function parseSobjectsConfig(source, sourceName = "sobjects.toml") {
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
  return Object.freeze(config);
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
