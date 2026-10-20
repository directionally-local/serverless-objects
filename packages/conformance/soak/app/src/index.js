// The soak app. Every write is checkable: the soak client records which
// appends were acknowledged and compares them with what each ledger holds.
import { DurableObject } from "cloudflare:workers";

// An append-only ledger per object. The client numbers its appends.
export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)");
  }

  append(seq, body) {
    this.ctx.storage.sql.exec("INSERT INTO entries (seq, body, at) VALUES (?, ?, ?) ON CONFLICT(seq) DO NOTHING", seq, body, Date.now());
    return seq;
  }

  // Every stored sequence number, and whether the database is intact.
  state() {
    const seqs = this.ctx.storage.sql.exec("SELECT seq FROM entries ORDER BY seq").toArray().map((row) => row.seq);
    const integrity = this.ctx.storage.sql.exec("PRAGMA quick_check").one().quick_check;
    return { seqs, integrity };
  }
}

// An alarm that re-arms itself and records when it fired.
export class Ticker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fires (at INTEGER NOT NULL)");
  }

  async start(periodMs) {
    this.ctx.storage.kv.put("period", periodMs);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + periodMs);
    return true;
  }

  async alarm() {
    this.ctx.storage.sql.exec("INSERT INTO fires (at) VALUES (?)", Date.now());
    this.ctx.storage.sql.exec("DELETE FROM fires WHERE at < ?", Date.now() - 3 * 86_400_000);
    await this.ctx.storage.setAlarm(Date.now() + (this.ctx.storage.kv.get("period") ?? 10_000));
  }

  fires(since) {
    return this.ctx.storage.sql.exec("SELECT at FROM fires WHERE at >= ? ORDER BY at", since).toArray().map((row) => row.at);
  }
}

// Hibernatable WebSocket echo.
export class Echo extends DurableObject {
  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    socket.send(message);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "default";
    switch (url.pathname) {
      case "/health":
        return new Response("ok");
      case "/append":
        return Response.json(await env.LEDGER.getByName(name).append(Number(url.searchParams.get("seq")), "x".repeat(200)));
      case "/ledger":
        return Response.json(await env.LEDGER.getByName(name).state());
      case "/tick/start":
        return Response.json(await env.TICKER.getByName(name).start(Number(url.searchParams.get("period") ?? 10_000)));
      case "/tick/fires":
        return Response.json(await env.TICKER.getByName(name).fires(Number(url.searchParams.get("since") ?? 0)));
      case "/echo":
        return env.ECHO.getByName(name).fetch(request);
      // Fault injection: an uncaught error kills the engine thread serving this request.
      case "/fault/crash-thread":
        setTimeout(() => {
          throw new Error("soak: injected thread crash");
        });
        return new Response("crashing");
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
