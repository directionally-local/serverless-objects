// Messages between the native engine's threads (--threads): calls with
// replies over a MessagePort, Requests and Responses with their bodies
// transferred as streams, and WebSocket ends relayed through a port.
import { MessageChannel } from "node:worker_threads";
import { READY_STATE } from "./websocket.js";

// One side of a request/reply conversation over a port. handle(type,
// payload) answers the other side's requests; its result is
// { value, transfer } or a plain value.
export class PortChannel {
  #port;
  #next = 0;
  #pending = new Map();
  #closed = false;

  constructor(port, handle = async () => { throw new Error("This channel takes no requests."); }) {
    this.#port = port;
    port.on("message", (message) => void this.#receive(message, handle));
    port.on("close", () => this.close(new Error("The engine thread went away.")));
  }

  // Lets the process exit while this channel is open.
  unref() {
    this.#port.unref?.();
    return this;
  }

  request(type, payload, transfer = []) {
    if (this.#closed) return Promise.reject(new Error("The engine thread is not running."));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#port.postMessage({ kind: "request", id, type, payload }, transfer);
    });
  }

  post(type, payload, transfer = []) {
    if (!this.#closed) this.#port.postMessage({ kind: "event", type, payload }, transfer);
  }

  // Fails every request still waiting for a reply.
  close(error = new Error("The channel closed.")) {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
    // A Worker has no close(); its channel ends when the thread exits.
    this.#port.close?.();
  }

  async #receive(message, handle) {
    if (message.kind === "reply") {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.ok) pending?.resolve(message.value);
      else pending?.reject(message.error);
      return;
    }
    if (message.kind === "event") return void handle(message.type, message.payload);
    try {
      const result = await handle(message.type, message.payload);
      const { value, transfer = [] } = result && typeof result === "object" && "transfer" in result ? result : { value: result };
      if (!this.#closed) this.#port.postMessage({ kind: "reply", id: message.id, ok: true, value }, transfer);
    } catch (error) {
      if (!this.#closed) this.#port.postMessage({ kind: "reply", id: message.id, ok: false, error: cloneable(error) });
    }
  }
}

// Errors cross threads as a structured clone, keeping name and message.
function cloneable(error) {
  try {
    return structuredClone(error);
  } catch {
    return new Error(String(error?.message ?? error));
  }
}

export function encodeRequest(request) {
  const body = request.body;
  return {
    value: { url: request.url, method: request.method, headers: [...request.headers], body },
    transfer: body ? [body] : [],
  };
}

export function decodeRequest({ url, method, headers, body }) {
  return new Request(url, { method, headers, ...(body ? { body, duplex: "half" } : {}) });
}

// A 101 response's WebSocket end stays in this thread; the other thread gets
// a port that relays it.
export function encodeResponse(response) {
  const headers = [...response.headers];
  if (response.status === 101 && response.webSocket) {
    const { port1, port2 } = new MessageChannel();
    relayEnd(response.webSocket, port1);
    return { value: { status: 101, statusText: response.statusText, headers, webSocket: port2 }, transfer: [port2] };
  }
  const body = response.body;
  return { value: { status: response.status, statusText: response.statusText, headers, body }, transfer: body ? [body] : [] };
}

export function decodeResponse({ status, statusText, headers, body, webSocket }) {
  if (status === 101) return new Response(null, { status: 101, statusText, headers, webSocket: new RemoteEnd(webSocket) });
  // Responses with these statuses cannot have a body.
  return new Response([101, 204, 205, 304].includes(status) ? null : body, { status, statusText, headers });
}

// Forwards what `end` would deliver to its owner over the port, and applies
// what comes back: the thread that has the network socket drives `end`.
export function relayEnd(end, port) {
  end.takeOver((_end, event) => {
    port.postMessage(event.type === "error" ? { type: "error", message: String(event.error?.message ?? event.error) } : event);
    if (event.type === "close") setImmediate(() => port.close());
  });
  port.on("message", (operation) => {
    try {
      if (operation.op === "send") end.send(operation.data);
      else if (operation.op === "close") end.close(operation.code, operation.reason);
      else if (operation.op === "fail") end.fail(new Error(operation.message));
    } catch {
      // The end already closed; nothing to deliver.
    }
  });
  port.on("close", () => {
    if (end.readyState < READY_STATE.CLOSED) end.fail(new Error("connection lost"));
  });
}

// A WebSocket end that lives in another thread, with the interface the
// network bridge (connect) and relayEnd use: takeOver, send, close, fail.
export class RemoteEnd {
  #port;
  #sink;
  #held = [];
  readyState = READY_STATE.OPEN;

  constructor(port) {
    this.#port = port;
    port.on("message", (event) => {
      if (event.type === "close") this.readyState = READY_STATE.CLOSED;
      const delivered = event.type === "error" ? { type: "error", error: new Error(event.message) } : event;
      if (this.#sink) this.#sink(this, delivered);
      else this.#held.push(delivered);
    });
    port.on("close", () => {
      if (this.readyState === READY_STATE.CLOSED) return;
      this.readyState = READY_STATE.CLOSED;
      this.#sink?.(this, { type: "close", code: 1006, reason: "", clean: false });
    });
  }

  takeOver(sink) {
    this.#sink = sink;
    for (const event of this.#held.splice(0)) sink(this, event);
  }

  send(data) {
    if (this.readyState !== READY_STATE.OPEN) throw new TypeError("WebSocket send() after close");
    this.#port.postMessage({ op: "send", data });
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= READY_STATE.CLOSING) return;
    this.readyState = READY_STATE.CLOSING;
    this.#port.postMessage({ op: "close", code, reason });
  }

  fail(error) {
    if (this.readyState === READY_STATE.CLOSED) return;
    this.readyState = READY_STATE.CLOSED;
    this.#port.postMessage({ op: "fail", message: String(error?.message ?? error) });
    setImmediate(() => this.#port.close());
  }
}

// Which of `count` shards owns an object, from its 64-hex ID.
export function shardOf(id, count) {
  return Number.parseInt(String(id).slice(0, 8), 16) % count;
}
