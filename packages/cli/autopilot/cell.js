// A RunObject that executes its task with Autopilot inside a Hotcell cell.
//
//   import { AutopilotCellRun } from "serverless-objects/autopilot/cell";
//   export class Run extends AutopilotCellRun {}
//
//   await env.RUNS.getByName(id).create({ id, workspace, cwd: "/workspace", task });
//   await env.RUNS.getByName(id).start({ model: "moonshotai/kimi-k2.6" });
//
// The object reaches the Hotcell daemon at HOTCELL_ENDPOINT (default
// http://127.0.0.1:4750) with HOTCELL_API_KEY. The cell gets a gateway token
// for model calls, never a provider key.
import { HotcellClient } from "@hotcell/sdk";
import { CellExecutor } from "./cell-executor.js";
import { RunObject } from "./index.js";

export { DEFAULT_IMAGE, DEFAULT_MODEL, DEFAULT_PACKAGE } from "./cell-executor.js";

export class AutopilotCellRun extends RunObject {
  #executor;

  constructor(ctx, env) {
    super(ctx, env);
    const client = new HotcellClient({
      endpoint: env.HOTCELL_ENDPOINT || "http://127.0.0.1:4750",
      apiKey: env.HOTCELL_API_KEY || undefined,
    });
    this.#executor = new CellExecutor({
      db: this.db,
      run: this.runHost,
      connect: async (cellId, createOptions) => {
        if (!cellId) return client.getSandbox(undefined, createOptions);
        const cell = await client.getSandbox(cellId);
        if (cell.status === "stopped") await cell.start();
        return cell;
      },
    });
  }

  alarmAt() {
    return #executor in this ? this.#executor.nextAt() : null;
  }

  async onAlarm() {
    await this.#executor.step();
  }

  // Options: model, packageSpec (autopilot-ai@<version>), image, egress (Hotcell policy).
  async start(options) {
    const state = await this.#executor.start(options);
    await this.syncAlarm();
    return state;
  }

  // Resume a run paused for input. A cell run continues in the same cell
  // session with a follow-up prompt (options.message); other runs resume as usual.
  async resume(budgets, options = {}) {
    if (!this.#executor.state()) return super.resume(budgets);
    const check = this.#executor.resumable();
    if (!check.ok) throw new Error(`Cannot resume: ${check.reason}`);
    const run = await super.resume(budgets);
    this.#executor.continueTurn(options);
    await this.syncAlarm();
    return run;
  }

  async cancel() {
    const state = await this.#executor.cancel();
    await this.syncAlarm();
    return state;
  }

  executorState() {
    return this.#executor.state();
  }
}
