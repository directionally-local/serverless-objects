// A small S3 client (AWS Signature V4 over node:crypto) for the native
// engine's backups: get, put (optionally conditional), delete and list.
// Works with AWS S3 and S3-compatible stores such as Cloudflare R2.
import { createHash, createHmac } from "node:crypto";

export class S3Error extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// bucketUri: s3://bucket/optional/prefix. endpoint: e.g. https://<account>.r2.cloudflarestorage.com
// (path-style); without one, AWS virtual-hosted URLs are used.
export function parseBucketUri(uri) {
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(uri ?? "");
  if (!match) throw new Error(`Invalid bucket URI ${uri}; expected s3://bucket/optional/prefix.`);
  return { bucket: match[1], prefix: (match[2] ?? "").replace(/^\/+|\/+$/g, "") };
}

export class S3Client {
  #bucket;
  #endpoint;
  #region;
  #credentials;
  #fetch;
  #now;

  constructor({ bucket, endpoint, region, credentials, fetchImpl = globalThis.fetch, now = () => new Date() }) {
    if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
      throw new Error("S3 credentials are missing; set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
    }
    this.#bucket = bucket;
    this.#region = region || "us-east-1";
    this.#endpoint = endpoint ? endpoint.replace(/\/+$/, "") : undefined;
    this.#credentials = credentials;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  static fromEnvironment({ bucketUri, endpoint, region, env = process.env, fetchImpl, now }) {
    const { bucket, prefix } = parseBucketUri(bucketUri);
    const client = new S3Client({
      bucket,
      endpoint: endpoint ?? env.S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL,
      region: region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN },
      fetchImpl,
      now,
    });
    return { client, prefix };
  }

  // Returns { body, etag } or null when the key does not exist.
  async get(key) {
    const response = await this.#send("GET", key);
    if (response.status === 404) return null;
    await expectOk(response, `GET ${key}`);
    return { body: Buffer.from(await response.arrayBuffer()), etag: response.headers.get("etag") };
  }

  // ifNoneMatch: "*" creates only; ifMatch: an ETag replaces only that version.
  // Returns the new ETag, or null when the condition failed.
  async put(key, body, { ifMatch, ifNoneMatch, contentType = "application/octet-stream" } = {}) {
    const headers = { "content-type": contentType };
    if (ifMatch) headers["if-match"] = ifMatch;
    if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;
    const response = await this.#send("PUT", key, { body: Buffer.from(body), headers });
    if (response.status === 412 || response.status === 409) {
      await response.arrayBuffer();
      return null;
    }
    await expectOk(response, `PUT ${key}`);
    return response.headers.get("etag");
  }

  async delete(key) {
    const response = await this.#send("DELETE", key);
    if (response.status === 404) return;
    await expectOk(response, `DELETE ${key}`);
  }

  // Every object under a prefix, in key order: [{ key, etag, size }].
  async list(prefix) {
    const objects = [];
    let token;
    do {
      const query = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
      const response = await this.#send("GET", "", { query });
      await expectOk(response, `LIST ${prefix}`);
      const xml = await response.text();
      for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const field = (name) => unescapeXml(new RegExp(`<${name}>([^<]*)</${name}>`).exec(entry)?.[1] ?? "");
        objects.push({ key: field("Key"), etag: field("ETag"), size: Number(field("Size")) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescapeXml(/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? "") : undefined;
    } while (token);
    return objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async #send(method, key, { body, headers = {}, query = {} } = {}) {
    const encodedKey = key.split("/").map(encodeRfc3986).join("/");
    let url;
    let canonicalPath;
    if (this.#endpoint) {
      url = new URL(`${this.#endpoint}/${this.#bucket}${key ? `/${encodedKey}` : ""}`);
      canonicalPath = url.pathname;
    } else {
      url = new URL(`https://${this.#bucket}.s3.${this.#region}.amazonaws.com/${encodedKey}`);
      canonicalPath = url.pathname;
    }
    const sortedQuery = Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(String(value))}`).join("&");
    if (sortedQuery) url.search = sortedQuery;

    const date = this.#now();
    const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));
    const allHeaders = {
      ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)])),
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(this.#credentials.sessionToken ? { "x-amz-security-token": this.#credentials.sessionToken } : {}),
    };
    const names = Object.keys(allHeaders).sort();
    const canonicalRequest = [
      method,
      canonicalPath,
      sortedQuery,
      ...names.map((name) => `${name}:${allHeaders[name].trim()}`),
      "",
      names.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${day}/${this.#region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    let signingKey = hmac(`AWS4${this.#credentials.secretAccessKey}`, day);
    for (const part of [this.#region, "s3", "aws4_request"]) signingKey = hmac(signingKey, part);
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const requestHeaders = { ...allHeaders };
    delete requestHeaders.host;
    requestHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${this.#credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    try {
      return await this.#fetch(url, { method, headers: requestHeaders, body, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      // fetch() reports network failures as "fetch failed"; the cause names them.
      const reason = error?.cause?.code ?? error?.cause?.message ?? error?.name ?? "error";
      throw new S3Error(`S3 ${method} ${url.host} failed: ${reason}`, 0, reason);
    }
  }
}

async function expectOk(response, what) {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  throw new S3Error(`S3 ${what} failed: HTTP ${response.status}${code ? ` ${code}` : ""}`, response.status, code);
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Named and numeric character references: SeaweedFS, for one, writes ETag
// quotes as &#34;.
const XML_ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

function unescapeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== "#") return XML_ENTITIES[entity] ?? match;
    const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
