// WebSockets for the native engine: the Workers WebSocketPair API, and a small
// RFC 6455 server that connects a pair's client end to an upgraded HTTP socket.
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 5_000;
export const READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

class MessageEvent extends Event {
  constructor(data) {
    super("message");
    this.data = data;
  }
}

class CloseEvent extends Event {
  constructor(code, reason, wasClean) {
    super("close");
    this.code = code;
    this.reason = reason;
    this.wasClean = wasClean;
  }
}

class ErrorEvent extends Event {
  constructor(error) {
    super("error");
    this.error = error;
    this.message = String(error?.message ?? error);
  }
}

// One end of a WebSocketPair. Data sent on one end arrives at the other.
export class WorkersWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  #peer;
  #owner;
  #accepted = false;
  #pending = [];
  #attachment;
  #sink;
  readyState = READY_STATE.OPEN;
  url = null;
  protocol = "";
  extensions = "";

  link(peer) {
    this.#peer = peer;
  }

  // Events arrive only after accept(); until then they are held. A socket
  // accepted this way keeps the accepting object in memory while it is open.
  accept() {
    if (this.#accepted) return;
    this.#owner = WorkersWebSocket.ownerOf?.();
    this.#owner?.pinSocket(this);
    this.#open();
  }

  // The engine takes over delivery instead of event listeners (hibernation API).
  takeOver(sink) {
    this.#sink = sink;
    if (!this.#accepted) this.#open();
  }

  #open() {
    this.#accepted = true;
    const pending = this.#pending.splice(0);
    for (const event of pending) this.#dispatch(event);
  }

  #release() {
    const owner = this.#owner;
    this.#owner = undefined;
    owner?.unpinSocket(this);
  }

  send(data) {
    if (this.readyState !== READY_STATE.OPEN) throw new TypeError("WebSocket send() after close");
    this.#peer.#receive({ type: "message", data: normalize(data) });
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= READY_STATE.CLOSING) return;
    this.readyState = READY_STATE.CLOSING;
    this.#peer.#receive({ type: "close", code, reason });
  }

  serializeAttachment(value) {
    this.#attachment = value === undefined ? undefined : structuredClone(value);
  }

  deserializeAttachment() {
    return this.#attachment === undefined ? null : structuredClone(this.#attachment);
  }

  // The network side of this end failed: the other end sees an error and an
  // abnormal close (1006).
  fail(error) {
    if (this.readyState === READY_STATE.CLOSED) return;
    this.readyState = READY_STATE.CLOSED;
    this.#release();
    this.#peer.#receive({ type: "error", error });
    this.#peer.#receive({ type: "close", code: 1006, reason: "", clean: false });
  }

  #receive(event) {
    if (event.type === "close") {
      if (this.readyState === READY_STATE.CLOSED) return;
      const wasOpen = this.readyState === READY_STATE.OPEN;
      this.readyState = READY_STATE.CLOSED;
      this.#release();
      if (wasOpen && event.clean !== false) this.#peer.#acknowledgeClose(event.code, event.reason);
    }
    if (this.#accepted) this.#dispatch(event);
    else this.#pending.push(event);
  }

  // The peer closed first; this end is closed too once the peer is told.
  #acknowledgeClose(code, reason) {
    if (this.readyState === READY_STATE.CLOSED) return;
    this.readyState = READY_STATE.CLOSED;
    this.#release();
    const event = { type: "close", code, reason, clean: true, echo: true };
    if (this.#accepted) this.#dispatch(event);
    else this.#pending.push(event);
  }

  #dispatch(event) {
    setImmediate(() => {
      if (this.#sink) return this.#sink(this, event);
      if (event.type === "message") this.dispatchEvent(new MessageEvent(event.data));
      else if (event.type === "close") this.dispatchEvent(new CloseEvent(event.code ?? 1005, event.reason ?? "", event.clean !== false));
      else if (event.type === "error") this.dispatchEvent(new ErrorEvent(event.error));
    });
  }
}

export class WebSocketPair {
  constructor() {
    const client = new WorkersWebSocket();
    const server = new WorkersWebSocket();
    client.link(server);
    server.link(client);
    this[0] = client;
    this[1] = server;
  }

  *[Symbol.iterator]() {
    yield this[0];
    yield this[1];
  }
}

export class WebSocketRequestResponsePair {
  constructor(request, response) {
    if (typeof request !== "string" || typeof response !== "string") throw new TypeError("Auto-response request and response must be strings.");
    this.request = request;
    this.response = response;
  }
}

function normalize(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  throw new TypeError("WebSocket send() takes a string, ArrayBuffer or typed array.");
}

export function acceptKey(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

// Completes the handshake and relays frames between the TCP socket and the
// client end of a WebSocketPair.
// Whether an upgraded socket's client is gone. Its "end" may have fired
// before anyone listened (nothing reads an upgraded socket until a handler
// attaches), so destroyed alone isn't enough.
export function socketGone(socket) {
  return socket.destroyed || socket.readableEnded;
}

// With connections, the socket registers a goAway() there that a draining
// engine calls: the client gets 1001, and the object sees the socket close.
export function connect(socket, head, request, response, connections) {
  const end = response.webSocket;
  if (socketGone(socket)) {
    socket.destroy();
    end.fail?.(new Error("connection lost"));
    return;
  }
  const protocol = response.headers.get("sec-websocket-protocol");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(request.headers.get("sec-websocket-key"))}`,
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
    "",
    "",
  ].join("\r\n"));
  socket.setNoDelay(true);

  let closing = false;
  let sentClose = false;
  let closeTimer;
  const finish = () => {
    clearTimeout(closeTimer);
    socket.destroy();
  };

  // Server to client: what the Worker sends on its end arrives here.
  end.takeOver((_self, event) => {
    if (event.type === "message") {
      if (!socket.destroyed) socket.write(encodeFrame(typeof event.data === "string" ? 0x1 : 0x2, Buffer.from(typeof event.data === "string" ? event.data : new Uint8Array(event.data))));
    } else if (event.type === "close") {
      if (socket.destroyed) return;
      // After goAway() the client already has our close frame.
      if (!sentClose) socket.write(encodeClose(event.code, event.reason));
      sentClose = true;
      if (event.echo) return finish();
      if (closing) return;
      closing = true;
      closeTimer = setTimeout(finish, CLOSE_TIMEOUT_MS);
    }
  });

  // Client to server.
  const parser = new FrameParser((opcode, payload) => {
    if (opcode === 0x1) end.send(payload.toString("utf8"));
    else if (opcode === 0x2) end.send(new Uint8Array(payload));
    else if (opcode === 0x9) socket.write(encodeFrame(0xa, payload));
    else if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      if (closing) return finish();
      end.close(code, reason);
    }
  }, (error) => {
    socket.write(encodeClose(1002, error.message.slice(0, 100)));
    end.fail(error);
    finish();
  });
  if (connections) {
    const connection = {
      goAway() {
        if (closing || socket.destroyed) return;
        closing = true;
        sentClose = true;
        socket.write(encodeClose(1001, "server restarting"));
        closeTimer = setTimeout(finish, CLOSE_TIMEOUT_MS);
        end.close(1001, "server restarting");
      },
    };
    connections.add(connection);
    socket.once("close", () => connections.delete(connection));
  }
  if (head?.length) parser.push(head);
  socket.on("data", (chunk) => parser.push(chunk));
  socket.on("error", () => {});
  // A client that only half-closes (FIN) is done: close our side too.
  socket.on("end", () => {
    if (end.readyState < READY_STATE.CLOSED) end.fail(new Error("connection closed"));
    socket.end();
  });
  socket.on("close", () => {
    clearTimeout(closeTimer);
    if (end.readyState < READY_STATE.CLOSED) end.fail(new Error("connection lost"));
  });
}

export function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeClose(code, reason) {
  if (code === 1005 || code === 1006 || code === undefined) return encodeFrame(0x8, Buffer.alloc(0));
  const reasonBytes = Buffer.from(reason ?? "", "utf8").subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeFrame(0x8, payload);
}

// Parses masked client frames, reassembling fragmented messages.
export class FrameParser {
  #buffer = Buffer.alloc(0);
  // Chunks received since the last parse, joined only once a frame can be
  // complete: re-concatenating the buffer on every chunk made one large frame
  // quadratic in its size.
  #pending = [];
  #pendingBytes = 0;
  #needed = 2;
  #fragments = [];
  #fragmentBytes = 0;
  #fragmentOpcode = 0;
  #onFrame;
  #onError;
  #failed = false;

  constructor(onFrame, onError) {
    this.#onFrame = onFrame;
    this.#onError = onError;
  }

  push(chunk) {
    if (this.#failed) return;
    this.#pending.push(chunk);
    this.#pendingBytes += chunk.length;
    if (this.#buffer.length + this.#pendingBytes < this.#needed) return;
    if (this.#buffer.length) this.#pending.unshift(this.#buffer);
    this.#buffer = this.#pending.length === 1 ? this.#pending[0] : Buffer.concat(this.#pending);
    this.#pending = [];
    this.#pendingBytes = 0;
    try {
      while (this.#parseOne());
    } catch (error) {
      this.#failed = true;
      this.#onError(error);
    }
  }

  #parseOne() {
    const buffer = this.#buffer;
    this.#needed = 2;
    if (buffer.length < 2) return false;
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    if (buffer[0] & 0x70) throw new Error("unsupported extension bits");
    const masked = (buffer[1] & 0x80) !== 0;
    if (!masked) throw new Error("client frames must be masked");
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return (this.#needed = 4), false;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return (this.#needed = 10), false;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error("message too big");
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_MESSAGE_BYTES) throw new Error("message too big");
    if (buffer.length < offset + 4 + length) return (this.#needed = offset + 4 + length), false;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3];
    this.#buffer = buffer.subarray(offset + 4 + length);

    if (opcode >= 0x8) {
      if (!fin || length > 125) throw new Error("invalid control frame");
      this.#onFrame(opcode, payload);
      return true;
    }
    if (opcode === 0x0) {
      if (!this.#fragmentOpcode) throw new Error("unexpected continuation frame");
      // A running total, not a re-sum per frame: a flood of empty continuation
      // frames made the re-sum quadratic and stalled the event loop for seconds.
      if (payload.length) this.#fragments.push(payload);
      this.#fragmentBytes += payload.length;
    } else {
      if (this.#fragmentOpcode) throw new Error("expected a continuation frame");
      this.#fragmentOpcode = opcode;
      this.#fragments = [payload];
      this.#fragmentBytes = payload.length;
    }
    if (this.#fragmentBytes > MAX_MESSAGE_BYTES) throw new Error("message too big");
    if (fin) {
      const message = this.#fragments.length === 1 ? this.#fragments[0] : Buffer.concat(this.#fragments, this.#fragmentBytes);
      const messageOpcode = this.#fragmentOpcode;
      this.#fragments = [];
      this.#fragmentBytes = 0;
      this.#fragmentOpcode = 0;
      this.#onFrame(messageOpcode, message);
    }
    return true;
  }
}
