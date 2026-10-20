// Autopilot runs as Durable Objects. A small HTTP API over RunObject and
// RunRegistry; a real executor would call the same RPC methods.
//
//   POST /runs                         {id, task, workspace?}   create a run
//   POST /runs/:id/<method>            [...args]                call a RunObject method
//   GET  /runs/:id/stream?stream=session|run&after=N            NDJSON, or a WebSocket
//   GET  /registry?status=             list runs in the workspace
//   POST /registry/reconcile                                    after an executor restart
import { RunObject, RunRegistry } from "@serverless-objects/autopilot";

export { RunRegistry };

const WORKSPACE = "demo";
const METHODS = new Set([
  "get", "transition", "resume", "recordToolIntent", "recordToolResult", "recordCheckpoint", "recordUsage",
  "appendSessionEvents", "listEvents", "listSessionEvents", "scheduleTimer", "cancelTimer", "listTimers", "reconcileInterrupted",
]);

// The demo's executor: a wake appends a session event so it shows up in Camouflage.
export class Run extends RunObject {
  async onWake(event) {
    this.appendSessionEvents([{
      event_type: "BackgroundTaskUpdate",
      payload: { task_id: event.timerId, label: `woke on ${event.condition} timer`, state: "done" },
    }]);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] === "registry") {
        const registry = env.RUN_REGISTRY.getByName(WORKSPACE);
        if (parts[1] === "reconcile" && request.method === "POST") return Response.json(await registry.reconcile());
        return Response.json(await registry.list({ status: url.searchParams.get("status") ?? undefined }));
      }
      if (parts[0] !== "runs") return new Response("not found", { status: 404 });
      if (parts.length === 1 && request.method === "POST") {
        const { id, task, cwd = "/workspace" } = await request.json();
        return Response.json(await env.RUNS.getByName(id).create({ id, task, cwd, workspace: WORKSPACE }));
      }
      const run = env.RUNS.getByName(parts[1]);
      if (parts[2] === "stream") return run.fetch(request);
      if (request.method === "POST" && METHODS.has(parts[2])) {
        const body = await request.text();
        const args = body ? JSON.parse(body) : [];
        return Response.json((await run[parts[2]](...args)) ?? null);
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error?.message ?? error) }, { status: 400 });
    }
  },
};
