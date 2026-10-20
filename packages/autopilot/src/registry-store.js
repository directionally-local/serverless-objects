// The cross-run index one RunRegistry object keeps for a workspace: the
// queries Autopilot's global RunStore answers today (list by status, find
// runs to reconcile). Run objects report each change; the run object stays
// the source of truth, and refresh() repairs a stale row.
import { RUN_STATUSES } from "./run-store.js";

const MAX_PAGE = 500;

export class RegistryStore {
  #db;

  constructor(db) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      stop_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at)");
  }

  // Reports can arrive out of order; an older report never overwrites a newer one.
  upsert(summary) {
    if (typeof summary?.id !== "string" || !RUN_STATUSES.includes(summary.status)) throw new Error("invalid run summary");
    this.#db.exec(
      `INSERT INTO runs (id, task, status, stop_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET task = excluded.task, status = excluded.status,
         stop_reason = excluded.stop_reason, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= runs.updated_at`,
      summary.id, summary.task, summary.status, summary.stopReason ?? null, summary.createdAt, summary.updatedAt,
    );
  }

  get(id) {
    const [row] = this.#db.exec("SELECT * FROM runs WHERE id = ?", id);
    return row ? rowToSummary(row) : null;
  }

  list({ status, limit = 50 } = {}) {
    if (status !== undefined && !RUN_STATUSES.includes(status)) throw new Error(`Unknown run status: ${status}`);
    const capped = Math.max(1, Math.min(MAX_PAGE, Math.trunc(Number(limit) || 50)));
    const rows = status
      ? this.#db.exec("SELECT * FROM runs WHERE status = ? ORDER BY updated_at DESC LIMIT ?", status, capped)
      : this.#db.exec("SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?", capped);
    return rows.map(rowToSummary);
  }

  idsWithStatus(status) {
    return this.#db.exec("SELECT id FROM runs WHERE status = ? ORDER BY updated_at", status).map((row) => row.id);
  }
}

function rowToSummary(row) {
  return {
    id: row.id,
    task: row.task,
    status: row.status,
    stopReason: row.stop_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
