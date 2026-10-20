// The benchmark app: the same Worker runs on Cloudflare, Wrangler, celld and
// the native engine. Each route is one measured operation; timing is done by
// the client (Workers clocks don't advance during compute).
import { DurableObject } from "cloudflare:workers";

export class Bench extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  }

  read() {
    return this.ctx.storage.kv.get("count") ?? 0;
  }

  increment() {
    const count = (this.ctx.storage.kv.get("count") ?? 0) + 1;
    this.ctx.storage.kv.put("count", count);
    return count;
  }

  // n rows in one transaction, then a count over the table.
  insertRows(n) {
    this.ctx.storage.transactionSync(() => {
      for (let index = 0; index < n; index += 1) this.ctx.storage.sql.exec("INSERT INTO rows (body) VALUES (?)", `row ${index} ${"x".repeat(64)}`);
    });
    return this.ctx.storage.sql.exec("SELECT count(*) AS n FROM rows").one().n;
  }

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
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
    const id = url.searchParams.get("id") ?? "bench";
    const stub = () => env.BENCH.getByName(id);
    switch (url.pathname) {
      case "/cases":
        return Response.json([]);
      case "/noop":
        return new Response("ok");
      case "/read":
        return Response.json(await stub().read());
      case "/write":
        return Response.json(await stub().increment());
      case "/sql":
        return Response.json(await stub().insertRows(Math.min(Number(url.searchParams.get("n") ?? 100), 1000)));
      case "/ws":
        return stub().fetch(request);
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
