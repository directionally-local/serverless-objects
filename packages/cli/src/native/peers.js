// Calls between native-engine nodes (--peer-listen): a stub for an object
// that another node runs sends the call to that node's peer listener.
//
//   POST /peer/call    body: v8.serialize({ method, args }) -> v8.serialize({ ok, value | error })
//   *    /peer/fetch   the object's fetch: method, URL and headers in x-sobjects-peer-request,
//                      the body streamed; with Upgrade: sobjects-socket, a WebSocket the
//                      object accepts is relayed over the upgraded connection
//
// Every request is signed with the cluster secret (HMAC-SHA256 over a kind,
// timestamp, single-use nonce, path, target, method, and a digest of the call
// body or of the request's method, URL and headers), accepted within 30
// seconds and only once. Replies are signed over the request's nonce, so a
// caller knows it reached a node that holds the secret. Fetch bodies and
// relayed WebSocket messages are not covered, and nothing is encrypted:
// keep peer listeners on a private network. A node never forwards a peer
// request again, and answers 409 only when it hasn't run anything.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { deserialize, serialize } from "node:v8";
import { READY_STATE } from "./websocket.js";

const CLOCK_WINDOW_MS = 30_000;
// Cloudflare's limit for one RPC call's arguments.
const MAX_CALL_BYTES = 32 * 1024 * 1024;
const MAX_SOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;
const H = {
  target: "x-sobjects-peer-target",
  request: "x-sobjects-peer-request",
  time: "x-sobjects-peer-time",
  nonce: "x-sobjects-peer-nonce",
  signature: "x-sobjects-peer-signature",
  reply: "x-sobjects-peer-reply",
  // Marks a response as the peer's own failure, not the object's response.
  error: "x-sobjects-peer-error",
  // The object's fetch threw: the body is the serialized error.
  exception: "x-sobjects-peer-exception",
};
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "content-length"]);

export class NotOwner extends Error {
  constructor(message = "This node doesn't run that object.") {
    super(message);
    this.name = "NotOwner";
  }
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function signature(secret, fields) {
  return createHmac("sha256", secret).update(fields.join("\n")).digest("hex");
}

function sameSignature(expected, actual) {
  return typeof actual === "string" && /^[0-9a-f]{64}$/.test(actual) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

// Fields a request signature covers.
function requestFields(kind, { time, nonce, path, target, method, digest }) {
  return [`sobjects-peer-${kind}`, time, nonce, path, target, method, digest];
}

function replyFields(nonce, status, bodyDigest = "") {
  return ["sobjects-peer-reply", nonce, String(status), bodyDigest];
}

export class PeerServer {
  #secret;
  #serve;
  #log;
  #nonces = new Map();
  #sockets = new Set();

  // serve.call(target, method, args) and serve.fetch(target, request) run the
  // object here; they throw NotOwner (with beforeRun) if it isn't this node's.
  constructor({ secret, serve, log = () => {} }) {
    this.#secret = secret;
    this.#serve = serve;
    this.#log = log;
  }

  listen({ host, port }) {
    this.server = createServer((req, res) => void this.#request(req, res));
    this.server.on("upgrade", (req, socket, head) => void this.#upgrade(req, socket, head));
    return new Promise((resolveListen, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolveListen(this.server.address());
      });
    });
  }

  close() {
    return new Promise((resolveClose) => {
      if (!this.server) return resolveClose();
      this.server.close(() => resolveClose());
      // Other nodes keep connections alive between calls; relayed sockets are upgraded ones.
      this.server.closeAllConnections();
      for (const socket of this.#sockets) socket.destroy();
    });
  }

  // The request's target if its signature is good and its nonce unused.
  #authorize(req, kind, path, digest) {
    const time = req.headers[H.time];
    const nonce = req.headers[H.nonce];
    const target = req.headers[H.target] ?? "";
    if (!time || !nonce || !/^[0-9a-f]{32}$/.test(nonce) || Math.abs(Date.now() - Number(time)) > CLOCK_WINDOW_MS) return null;
    const expected = signature(this.#secret, requestFields(kind, { time, nonce, path, target, method: req.method, digest }));
    if (!sameSignature(expected, req.headers[H.signature])) return null;
    const now = Date.now();
    for (const [seen, expires] of this.#nonces) if (expires < now) this.#nonces.delete(seen);
    if (this.#nonces.has(nonce)) return null;
    this.#nonces.set(nonce, now + 2 * CLOCK_WINDOW_MS);
    try {
      return { target: JSON.parse(target), nonce };
    } catch {
      return null;
    }
  }

  #reply(nonce, status, bodyDigest) {
    return signature(this.#secret, replyFields(nonce, status, bodyDigest));
  }

  async #request(req, res) {
    const path = new URL(req.url, "http://peer").pathname;
    const peerError = (status, message, nonce) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { "content-type": "text/plain", [H.error]: "1", ...(nonce ? { [H.reply]: this.#reply(nonce, status) } : {}) }).end(message);
    };
    try {
      if (path === "/peer/call") {
        const body = await readBody(req, MAX_CALL_BYTES);
        const auth = this.#authorize(req, "call", path, sha256(body));
        if (!auth) return peerError(401, "unauthorized");
        const { method, args } = deserialize(body);
        let reply;
        try {
          reply = { ok: true, value: await this.#serve.call(auth.target, method, args) };
        } catch (error) {
          if (error instanceof NotOwner && error.beforeRun) return peerError(409, error.message, auth.nonce);
          reply = { ok: false, error: cloneable(error) };
        }
        const bytes = serialize(reply);
        res.writeHead(200, { "content-type": "application/octet-stream", [H.reply]: this.#reply(auth.nonce, 200, sha256(bytes)) }).end(bytes);
      } else if (path === "/peer/fetch") {
        const meta = req.headers[H.request] ?? "";
        const auth = this.#authorize(req, "fetch", path, sha256(meta));
        if (!auth) return peerError(401, "unauthorized");
        let response;
        try {
          response = await this.#serve.fetch(auth.target, decodePeerRequest(meta, req));
        } catch (error) {
          if (error instanceof NotOwner && error.beforeRun) return peerError(409, error.message, auth.nonce);
          // The object's fetch threw: the caller throws the same error.
          const bytes = serialize(cloneable(error));
          return res.writeHead(500, { "content-type": "application/octet-stream", [H.exception]: "1", [H.reply]: this.#reply(auth.nonce, 500, sha256(bytes)) }).end(bytes);
        }
        if (response.status === 101) throw new TypeError("A 101 response needs a WebSocket upgrade request.");
        res.writeHead(response.status, response.statusText, { ...nodeHeaders(response.headers), [H.reply]: this.#reply(auth.nonce, response.status) });
        if (response.body) await pipeline(Readable.fromWeb(response.body), res).catch(() => res.destroy());
        else res.end();
      } else {
        peerError(404, "not found");
      }
    } catch (error) {
      if (error?.status !== 413) this.#log(`peer request failed: ${error?.stack ?? error}`);
      peerError(error?.status === 413 ? 413 : 502, String(error?.message ?? error));
    }
  }

  // A WebSocket for an object: its fetch answers 101, and the object's end
  // is relayed over this upgraded connection.
  async #upgrade(req, socket, head) {
    socket.on("error", () => {});
    const refuse = (status, text, nonce) => {
      const reply = nonce ? `${H.reply}: ${this.#reply(nonce, status)}\r\n` : "";
      socket.end(`HTTP/1.1 ${status} ${text}\r\n${H.error}: 1\r\n${reply}connection: close\r\ncontent-length: 0\r\n\r\n`);
    };
    const path = new URL(req.url, "http://peer").pathname;
    const meta = req.headers[H.request] ?? "";
    const auth = path === "/peer/fetch" && req.headers.upgrade === "sobjects-socket" ? this.#authorize(req, "socket", path, sha256(meta)) : null;
    if (!auth) return refuse(401, "Unauthorized");
    let response;
    try {
      response = await this.#serve.fetch(auth.target, decodePeerRequest(meta, null));
    } catch (error) {
      if (error instanceof NotOwner && error.beforeRun) return refuse(409, "Conflict", auth.nonce);
      return refuse(500, "Internal Server Error", auth.nonce);
    }
    if (response.status !== 101 || !response.webSocket) {
      // The object refused the WebSocket: the caller gets its response.
      const body = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
      const headers = Object.entries(nodeHeaders(response.headers)).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}\r\n`)).join("");
      socket.write(`HTTP/1.1 ${response.status} ${response.statusText || "Error"}\r\n${headers}${H.reply}: ${this.#reply(auth.nonce, response.status)}\r\nconnection: close\r\ncontent-length: ${body.length}\r\n\r\n`);
      return socket.end(body);
    }
    const protocol = response.headers.get("sec-websocket-protocol");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: sobjects-socket\r\nconnection: Upgrade\r\n${H.reply}: ${this.#reply(auth.nonce, 101)}\r\n${protocol ? `sec-websocket-protocol: ${protocol}\r\n` : ""}\r\n`);
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    relayEndOverSocket(response.webSocket, socket, head);
  }
}

export class PeerClient {
  #secret;

  constructor({ secret }) {
    this.#secret = secret;
  }

  #sign(kind, path, target, method, digest) {
    const time = String(Date.now());
    const nonce = randomBytes(16).toString("hex");
    const targetJson = JSON.stringify(target);
    return {
      nonce,
      headers: { [H.target]: targetJson, [H.time]: time, [H.nonce]: nonce, [H.signature]: signature(this.#secret, requestFields(kind, { time, nonce, path, target: targetJson, method, digest })) },
    };
  }

  // A reply must carry the node's signature over our nonce (and, for calls, the body).
  #checkReply(headers, nonce, status, bodyDigest = "") {
    if (!sameSignature(signature(this.#secret, replyFields(nonce, status, bodyDigest)), headers[H.reply])) {
      throw new Error("The other node's reply isn't signed with this cluster's secret.");
    }
  }

  async call(addr, target, method, args) {
    const body = serialize({ method, args });
    const { nonce, headers } = this.#sign("call", "/peer/call", target, "POST", sha256(body));
    const response = await send(new URL("/peer/call", addr), { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body });
    const bytes = await readBody(response, Infinity);
    if (response.statusCode === 409) {
      this.#checkReply(response.headers, nonce, 409);
      throw new NotOwner(bytes.toString("utf8"));
    }
    if (response.statusCode !== 200) throw new Error(`The node at ${addr} refused the call (${response.statusCode}): ${bytes.toString("utf8")}`);
    this.#checkReply(response.headers, nonce, 200, sha256(bytes));
    const reply = deserialize(bytes);
    if (!reply.ok) throw reply.error;
    return reply.value;
  }

  async fetch(addr, target, request) {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return this.#webSocket(addr, target, request);
    const meta = JSON.stringify({ url: request.url, method: request.method, headers: [...request.headers] });
    const { nonce, headers } = this.#sign("fetch", "/peer/fetch", target, "POST", sha256(meta));
    const response = await send(new URL("/peer/fetch", addr), { method: "POST", headers: { ...headers, [H.request]: meta }, body: request.body ? Readable.fromWeb(request.body) : null });
    const status = response.statusCode;
    if (response.headers[H.error]) {
      const text = (await readBody(response, 64 * 1024)).toString("utf8");
      if (status === 409) {
        this.#checkReply(response.headers, nonce, 409);
        throw new NotOwner(text);
      }
      throw new Error(`The node at ${addr} refused the request (${status}): ${text}`);
    }
    if (response.headers[H.exception]) {
      const bytes = await readBody(response, Infinity);
      this.#checkReply(response.headers, nonce, status, sha256(bytes));
      throw deserialize(bytes);
    }
    this.#checkReply(response.headers, nonce, status);
    // Responses with these statuses cannot have a body.
    const body = [204, 205, 304].includes(status) || request.method === "HEAD" ? null : Readable.toWeb(response);
    if (!body) response.resume();
    return new Response(body, { status, statusText: response.statusMessage, headers: webHeaders(response.headers) });
  }

  // Asks the owner for the object's WebSocket; returns a 101 response whose
  // end relays it over the upgraded connection.
  async #webSocket(addr, target, request) {
    const headers = [...request.headers].filter(([name]) => !/^(upgrade|connection|sec-websocket-(key|version|extensions|accept))$/i.test(name));
    const meta = JSON.stringify({ url: request.url, method: "GET", headers: [...headers, ["upgrade", "websocket"]] });
    const { nonce, headers: signed } = this.#sign("socket", "/peer/fetch", target, "GET", sha256(meta));
    const { socket, response, head } = await upgrade(new URL("/peer/fetch", addr), { ...signed, [H.request]: meta, connection: "Upgrade", upgrade: "sobjects-socket" });
    if (!socket) {
      const body = await readBody(response, MAX_CALL_BYTES);
      if (response.headers[H.error] && !response.headers[H.reply]) throw new Error(`The node at ${addr} refused the request (${response.statusCode}).`);
      this.#checkReply(response.headers, nonce, response.statusCode);
      if (response.headers[H.error]) {
        if (response.statusCode === 409) throw new NotOwner(body.toString("utf8"));
        throw new Error(`The node at ${addr} refused the WebSocket (${response.statusCode}).`);
      }
      return new Response(body, { status: response.statusCode, statusText: response.statusMessage, headers: webHeaders(response.headers) });
    }
    try {
      this.#checkReply(response.headers, nonce, 101);
    } catch (error) {
      socket.destroy();
      throw error;
    }
    const protocol = response.headers["sec-websocket-protocol"];
    return new Response(null, { status: 101, headers: protocol ? { "sec-websocket-protocol": protocol } : {}, webSocket: new SocketEnd(socket, head) });
  }
}

// ---- WebSocket relay over an upgraded connection ------------------------------
// Messages are [4-byte length][1-byte kind][payload]: kind 0 is JSON control
// ({op} from the caller, {type} events from the owner), 1 text, 2 binary.
// Close codes pass through unchanged.

function encodeMessage(kind, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length + 1, 0);
  header[4] = kind;
  return Buffer.concat([header, payload]);
}

const encodeControl = (value) => encodeMessage(0, Buffer.from(JSON.stringify(value)));

function encodeData(data) {
  if (typeof data === "string") return encodeMessage(1, Buffer.from(data, "utf8"));
  return encodeMessage(2, Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
}

function messageReader(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    try {
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length < 1 || length > MAX_SOCKET_MESSAGE_BYTES + 1) throw new Error("bad relay message");
        if (buffer.length < 4 + length) return;
        const kind = buffer[4];
        const payload = Buffer.from(buffer.subarray(5, 4 + length));
        buffer = buffer.subarray(4 + length);
        if (kind === 0) onMessage(JSON.parse(payload.toString("utf8")));
        else if (kind === 1) onMessage({ data: payload.toString("utf8") });
        else onMessage({ data: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) });
      }
    } catch (error) {
      onError(error);
    }
  };
}

// The owner's side: what the object's end delivers goes to the caller; what
// the caller sends is applied to the end.
function relayEndOverSocket(end, socket, head) {
  socket.setNoDelay(true);
  end.takeOver((_end, event) => {
    if (socket.destroyed) return;
    if (event.type === "message") socket.write(encodeData(event.data));
    else socket.write(encodeControl(event.type === "error" ? { type: "error", message: String(event.error?.message ?? event.error) } : event));
    if (event.type === "close") socket.end();
  });
  const read = messageReader((message) => {
    try {
      if (message.data !== undefined) end.send(message.data);
      else if (message.op === "close") end.close(message.code, message.reason);
      else if (message.op === "fail") end.fail(new Error(message.message));
    } catch {
      // The end already closed.
    }
  }, () => socket.destroy());
  if (head?.length) read(head);
  socket.on("data", read);
  socket.on("end", () => socket.end());
  socket.on("close", () => {
    if (end.readyState < READY_STATE.CLOSED) end.fail(new Error("connection lost"));
  });
}

// The caller's side: a WebSocket end on another node, with the interface the
// network bridge (connect) and the thread relay use: takeOver, send, close, fail.
class SocketEnd {
  #socket;
  #sink;
  #held = [];
  readyState = READY_STATE.OPEN;

  constructor(socket, head) {
    this.#socket = socket;
    socket.setNoDelay(true);
    const deliver = (event) => (this.#sink ? this.#sink(this, event) : this.#held.push(event));
    const read = messageReader((message) => {
      if (message.data !== undefined) return deliver({ type: "message", data: message.data });
      if (message.type === "close") this.readyState = READY_STATE.CLOSED;
      deliver(message.type === "error" ? { type: "error", error: new Error(message.message) } : message);
    }, () => socket.destroy());
    if (head?.length) read(head);
    socket.on("data", read);
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    socket.on("close", () => {
      if (this.readyState === READY_STATE.CLOSED) return;
      this.readyState = READY_STATE.CLOSED;
      deliver({ type: "close", code: 1006, reason: "", clean: false });
    });
  }

  takeOver(sink) {
    this.#sink = sink;
    for (const event of this.#held.splice(0)) sink(this, event);
  }

  send(data) {
    if (this.readyState !== READY_STATE.OPEN) throw new TypeError("WebSocket send() after close");
    this.#socket.write(encodeData(data));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= READY_STATE.CLOSING) return;
    this.readyState = READY_STATE.CLOSING;
    if (!this.#socket.destroyed) this.#socket.write(encodeControl({ op: "close", code, reason }));
  }

  fail(error) {
    if (this.readyState === READY_STATE.CLOSED) return;
    this.readyState = READY_STATE.CLOSED;
    if (!this.#socket.destroyed) this.#socket.end(encodeControl({ op: "fail", message: String(error?.message ?? error) }));
  }
}

// ---- HTTP helpers ---------------------------------------------------------------

function unreachable(url, error) {
  const reason = error?.code ?? error?.message ?? error;
  return new Error(`The node at ${url.origin} didn't answer (${reason}); if it stopped, another node takes its objects once its lease runs out.`);
}

// One request to another node; the response isn't decoded.
function send(url, { method, headers, body }) {
  return new Promise((resolveResponse, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method, headers }, resolveResponse);
    request.on("error", (error) => reject(unreachable(url, error)));
    if (!body) request.end();
    else if (Buffer.isBuffer(body)) request.end(body);
    else pipeline(body, request).catch((error) => request.destroy(error));
  });
}

function upgrade(url, headers) {
  return new Promise((resolveUpgrade, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "GET", headers });
    request.on("upgrade", (response, socket, head) => resolveUpgrade({ response, socket, head }));
    request.on("response", (response) => resolveUpgrade({ response }));
    request.on("error", (error) => reject(unreachable(url, error)));
    request.end();
  });
}

function decodePeerRequest(meta, req) {
  const { url, method, headers } = JSON.parse(meta);
  const hasBody = req && method !== "GET" && method !== "HEAD";
  return new Request(url, { method, headers, ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}) });
}

async function readBody(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`The call is larger than ${limit} bytes.`), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function nodeHeaders(headers) {
  const result = {};
  for (const [name, value] of headers) if (name !== "set-cookie" && !HOP_BY_HOP.has(name)) result[name] = value;
  const cookies = headers.getSetCookie();
  if (cookies.length) result["set-cookie"] = cookies;
  return result;
}

function webHeaders(nodeHeadersObject) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeHeadersObject)) {
    if (HOP_BY_HOP.has(name) || name.startsWith("x-sobjects-peer-")) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

function cloneable(error) {
  try {
    serialize(error);
    return error;
  } catch {
    return new Error(String(error?.message ?? error));
  }
}
