// PartyServer conformance app. `Chat` is an unmodified `partyserver` Server
// with hibernation enabled, so the checks exercise PartyServer's own routing,
// connection manager, attachment handling and alarm plumbing rather than a
// hand-written Durable Object. Server-side checks answer {pass, detail} at
// /case/<name>; the runner drives the WebSocket protocol.
import { Server, getServerByName, routePartykitRequest } from "partyserver";

const json = (body, status = 200) => Response.json(body, { status });

function check(name, condition, detail) {
  if (!condition) throw new Error(`${name}: ${detail === undefined ? "failed" : JSON.stringify(detail)}`);
}

export class Chat extends Server {
  // Hibernation is what makes PartyServer use ctx.acceptWebSocket() and
  // rehydrate connections from their attachments after eviction.
  static options = { hibernate: true };

  onStart() {
    // A fresh instance id per construction lets the runner prove that an
    // evicted object was really replaced.
    this.instanceId = crypto.randomUUID();
    this.sql`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, body TEXT)`;
  }

  onConnect(connection) {
    connection.send(JSON.stringify({
      type: "welcome",
      id: connection.id,
      room: this.name,
      instance: this.instanceId,
      connections: this.connectionCount(),
    }));
  }

  onMessage(connection, message) {
    const data = JSON.parse(String(message));
    if (data.type === "broadcast") {
      this.broadcast(JSON.stringify({
        type: "broadcast",
        from: connection.id,
        body: data.body,
        connections: this.connectionCount(),
      }));
    } else if (data.type === "attach") {
      connection.serializeAttachment(data.value);
      connection.send(JSON.stringify({ type: "attached", attachment: connection.deserializeAttachment() }));
    } else if (data.type === "attachment") {
      connection.send(JSON.stringify({
        type: "attachment",
        attachment: connection.deserializeAttachment(),
        instance: this.instanceId,
        connections: this.connectionCount(),
      }));
    } else if (data.type === "count") {
      connection.send(JSON.stringify({ type: "count", connections: this.connectionCount() }));
    } else if (data.type === "store") {
      this.sql`INSERT INTO messages (body) VALUES (${data.body})`;
      connection.send(JSON.stringify({ type: "stored", messages: this.messages() }));
    } else if (data.type === "messages") {
      connection.send(JSON.stringify({ type: "messages", messages: this.messages() }));
    }
  }

  onRequest(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/info")) {
      return json({ room: this.name, instance: this.instanceId, connections: this.connectionCount(), messages: this.messages() });
    }
    return json({ error: "not found" }, 404);
  }

  onAlarm() {
    this.ctx.storage.put("alarmFired", Date.now());
  }

  connectionCount() {
    let count = 0;
    for (const _connection of this.getConnections()) count += 1;
    return count;
  }

  messages() {
    return [...this.sql`SELECT body FROM messages ORDER BY id`].map((row) => row.body);
  }

  // RPC surface used by getServerByName() checks.
  async info() {
    return { room: this.name, instance: this.instanceId, messages: this.messages() };
  }

  async store(body) {
    this.sql`INSERT INTO messages (body) VALUES (${body})`;
    return this.messages();
  }

  async reset() {
    this.sql`DELETE FROM messages`;
    await this.ctx.storage.delete("alarmFired");
    await this.ctx.storage.deleteAlarm();
    return this.messages();
  }

  async armAlarm(ms) {
    await this.ctx.storage.setAlarm(Date.now() + ms);
    return this.ctx.storage.getAlarm();
  }

  async alarmStatus() {
    return { fired: (await this.ctx.storage.get("alarmFired")) ?? null, pending: await this.ctx.storage.getAlarm() };
  }
}

const CASES = {
  async storage(env) {
    const chat = await chatByName(env, "storage");
    await chat.reset();
    const messages = await chat.store("first");
    check("insert", messages.join() === "first", messages);
    const more = await chat.store("second");
    check("append", more.join() === "first,second", more);
    return "this.sql create, insert and ordered select";
  },
  async addressing(env) {
    const chat = await chatByName(env, "addressing");
    const info = await chat.info();
    check("name", info.room === "addressing", info);
    check("instance", typeof info.instance === "string" && info.instance.length > 0, info);
    return "getServerByName, this.name and onStart";
  },
  async alarm(env) {
    const chat = await chatByName(env, "alarm");
    await chat.reset();
    const pending = await chat.armAlarm(1_000);
    check("armed", typeof pending === "number" && pending > Date.now(), pending);
    const deadline = Date.now() + 20_000;
    let status = await chat.alarmStatus();
    while (Date.now() < deadline) {
      if (status.fired) return "setAlarm, onAlarm and getAlarm";
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await chat.alarmStatus();
    }
    throw new Error(`alarm: did not fire before timeout ${JSON.stringify(status)}`);
  },
};

function chatByName(env, name) {
  return getServerByName(env.Chat, name);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/cases") return json(Object.keys(CASES));
    if (url.pathname.startsWith("/case/")) {
      const name = url.pathname.slice("/case/".length);
      if (!CASES[name]) return json({ error: "unknown case" }, 404);
      try {
        return json({ pass: true, detail: await CASES[name](env) });
      } catch (error) {
        return json({ pass: false, detail: String(error?.message ?? error) });
      }
    }
    return (await routePartykitRequest(request, env)) ?? json({ error: "not found" }, 404);
  },
};
