// Agents SDK conformance app. Server-side checks run inside the agent and
// answer {pass, detail} at /case/<name>; the runner drives the client
// protocol (routing, identity and state frames, callable RPC) over WebSocket.
import { Agent, callable, getAgentByName, routeAgentRequest } from "agents";

const json = (body, status = 200) => Response.json(body, { status });

function check(name, condition, detail) {
  if (!condition) throw new Error(`${name}: ${detail === undefined ? "failed" : JSON.stringify(detail)}`);
}

export class Probe extends Agent {
  initialState = { count: 0, ticks: 0 };

  @callable()
  increment(by = 1) {
    this.setState({ ...this.state, count: this.state.count + by });
    return this.state.count;
  }

  @callable()
  whoami() {
    return { name: this.name, className: this.constructor.name };
  }

  stateCase() {
    this.setState({ count: 0, ticks: 0 });
    this.setState({ ...this.state, count: 2 });
    check("state", this.state.count === 2, this.state);
    return "setState and this.state";
  }

  sqlCase() {
    this.sql`DROP TABLE IF EXISTS notes`;
    this.sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)`;
    for (const body of ["a", "b"]) this.sql`INSERT INTO notes (body) VALUES (${body})`;
    const rows = this.sql`SELECT body FROM notes ORDER BY id`;
    check("tagged sql", rows.map((row) => row.body).join() === "a,b", rows);
    return "this.sql tagged template";
  }

  async scheduleCase() {
    for (const schedule of this.getSchedules()) await this.cancelSchedule(schedule.id);
    const delayed = await this.schedule(3600, "tick", { from: "delay" });
    const cron = await this.schedule("0 * * * *", "tick", { from: "cron" });
    check("types", delayed.type === "delayed" && cron.type === "cron", [delayed.type, cron.type]);
    check("listed", this.getSchedules().length === 2, this.getSchedules());
    check("cancel", (await this.cancelSchedule(delayed.id)) === true && this.getSchedules().length === 1);
    await this.cancelSchedule(cron.id);
    return "delayed and cron schedules, list, cancel";
  }

  async arm(seconds) {
    this.setState({ ...this.state, ticks: 0 });
    await this.schedule(seconds, "tick", { from: "fire" });
    return this.getSchedules().length;
  }

  ticks() {
    return { ticks: this.state.ticks, lastTick: this.state.lastTick ?? null };
  }

  tick(payload) {
    this.setState({ ...this.state, ticks: this.state.ticks + 1, lastTick: payload.from });
  }
}

const CASES = {
  state: async (env) => (await probe(env, "state")).stateCase(),
  sql: async (env) => (await probe(env, "sql")).sqlCase(),
  schedules: async (env) => (await probe(env, "schedules")).scheduleCase(),
  async "get-agent-by-name"(env) {
    const who = await (await probe(env, "named")).whoami();
    check("identity", who.name === "named" && who.className === "Probe", who);
    return "getAgentByName, this.name, and class name";
  },
};

function probe(env, name) {
  return getAgentByName(env.Probe, name);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/cases") return json(Object.keys(CASES));
    if (url.pathname === "/schedule/arm") {
      const seconds = Number(url.searchParams.get("seconds") ?? 2);
      return json({ pending: await (await probe(env, "fire")).arm(seconds) });
    }
    if (url.pathname === "/schedule/status") return json(await (await probe(env, "fire")).ticks());
    if (url.pathname.startsWith("/case/")) {
      const name = url.pathname.slice("/case/".length);
      if (!CASES[name]) return json({ error: "unknown case" }, 404);
      try {
        return json({ pass: true, detail: await CASES[name](env) });
      } catch (error) {
        return json({ pass: false, detail: String(error?.message ?? error) });
      }
    }
    return (await routeAgentRequest(request, env)) ?? json({ error: "not found" }, 404);
  },
};
