import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LedgerJournal, alarmGaps } from "../soak/journal.js";

const SOAK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "soak");

test("the soak image requires an explicit SOBJECTS_VERSION", async () => {
  const dockerfile = await readFile(path.join(SOAK_DIR, "Dockerfile"), "utf8");
  const arg = /^ARG SOBJECTS_VERSION(.*)$/m.exec(dockerfile);
  assert.ok(arg, "the Dockerfile declares ARG SOBJECTS_VERSION");
  // A default would let a bare build silently test an old release.
  assert.equal(arg[1].trim(), "", "ARG SOBJECTS_VERSION must not have a default");
  assert.match(dockerfile, /test -n "\$SOBJECTS_VERSION"/, "the build fails when the version is missing");
});

test("an acknowledged append that is missing is a violation; unacknowledged ones are not", () => {
  const journal = new LedgerJournal();
  for (let index = 0; index < 5; index += 1) {
    const seq = journal.send();
    if (seq === 3) journal.failed(seq);
    else journal.acked(seq);
  }
  assert.deepEqual(journal.verify([1, 2, 4, 5]).violations, []);
  // Found stored after all: guarded from now on.
  assert.deepEqual(journal.verify([1, 2, 3, 4, 5]).violations, []);
  assert.deepEqual(journal.verify([1, 4, 5]).violations, ["lost acknowledged seq 2", "lost acknowledged seq 3"]);
  // Reported once.
  assert.deepEqual(journal.verify([1, 4, 5]).violations, []);
  assert.deepEqual(journal.verify([1, 2, 3, 4, 5, 9]).violations, ["holds seq 9, which was never sent"]);
});

test("a wipe excuses only appends acknowledged within the recovery window, and remembers them", () => {
  const journal = new LedgerJournal();
  const now = 1_000_000;
  for (let seq = 1; seq <= 4; seq += 1) journal.acked(journal.send(), now - (5 - seq) * 10_000);
  // seq 1 acked 40 s before the wipe, seq 4 10 s before.
  assert.equal(journal.wiped(now, 25_000), 2);
  const { violations, excusedNow } = journal.verify([1]);
  assert.deepEqual(violations, ["lost acknowledged seq 2"]);
  assert.equal(excusedNow, 2);
  // Later checks remember the excused losses, and survive a save and load.
  const reloaded = new LedgerJournal(JSON.parse(JSON.stringify(journal)));
  assert.deepEqual(reloaded.verify([1, 2]).violations, []);
});

test("alarm gaps exclude planned downtime", () => {
  const fires = [0, 30_000, 60_000, 400_000, 430_000];
  assert.equal(alarmGaps(fires, 30_000, []).length, 1);
  assert.equal(alarmGaps(fires, 30_000, [[70_000, 360_000]]).length, 0);
});
