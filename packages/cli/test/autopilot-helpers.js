import { DatabaseSync } from "node:sqlite";

// The { exec, transaction } adapter over node:sqlite, matching durableObjectSql().
export function memoryDb() {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => db.prepare(query).all(...bindings),
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export function clock(start = 1_000_000) {
  const state = { now: start };
  return {
    now: () => state.now,
    advance: (ms) => { state.now += ms; },
    set: (value) => { state.now = value; },
  };
}

export function ids(prefix = "t") {
  let next = 0;
  return () => `${prefix}${++next}`;
}

export const RUN = { id: "run-1", workspace: "acme", cwd: "/workspace", task: "Fix the flaky test" };
