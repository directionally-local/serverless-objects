// What the soak client knows about each ledger: which appends it sent, which
// were acknowledged, and which may be missing for a documented reason (a disk
// wipe loses writes acknowledged within the backup window). verify() compares
// that with what a ledger holds.

// Acknowledged appends are remembered with their times only this long; older
// ones are older than any recovery window.
const RECENT_MS = 15 * 60_000;

export class LedgerJournal {
  constructor(saved) {
    this.next = saved?.next ?? 1;
    // Sent but not acknowledged: each may or may not have been stored.
    this.uncertain = new Set(saved?.uncertain ?? []);
    // Acknowledged, then lost within a recovery window.
    this.excused = new Set(saved?.excused ?? []);
    // Acknowledged and lost without an excuse: reported once.
    this.lost = new Set(saved?.lost ?? []);
    this.recent = saved?.recent ?? [];
  }

  send() {
    return this.next++;
  }

  acked(seq, at = Date.now()) {
    this.recent.push([seq, at]);
    while (this.recent.length && at - this.recent[0][1] > RECENT_MS) this.recent.shift();
  }

  failed(seq) {
    this.uncertain.add(seq);
  }

  // A wipe at `at` may lose appends acknowledged after `at - windowMs`.
  wiped(at, windowMs) {
    const atRisk = new Set(this.recent.filter(([, ackedAt]) => ackedAt > at - windowMs).map(([seq]) => seq));
    this.atRisk = atRisk;
    return atRisk.size;
  }

  // seqs: what the ledger holds. Returns violations; settles what it learned.
  verify(seqs) {
    const violations = [];
    const held = new Set(seqs);
    let excusedNow = 0;
    for (const seq of held) {
      if (seq < 1 || seq >= this.next) violations.push(`holds seq ${seq}, which was never sent`);
    }
    const sentBeforeVerify = this.next;
    for (let seq = 1; seq < sentBeforeVerify; seq += 1) {
      if (held.has(seq) || this.uncertain.has(seq) || this.excused.has(seq) || this.lost.has(seq)) continue;
      if (this.atRisk?.has(seq)) {
        this.excused.add(seq);
        excusedNow += 1;
        continue;
      }
      this.lost.add(seq);
      violations.push(`lost acknowledged seq ${seq}`);
    }
    // An unacknowledged append found stored is guarded from now on; one not
    // found stays uncertain (its request may still have been running).
    for (const seq of this.uncertain) if (held.has(seq)) this.uncertain.delete(seq);
    this.atRisk = undefined;
    return { violations, excusedNow };
  }

  toJSON() {
    return { next: this.next, uncertain: [...this.uncertain], excused: [...this.excused], lost: [...this.lost], recent: this.recent };
  }
}

// Gaps between alarm fires longer than the period plus slack, excluding time
// the engine was down on purpose.
export function alarmGaps(fires, periodMs, downtime, slackMs = 60_000) {
  const gaps = [];
  for (let index = 1; index < fires.length; index += 1) {
    const [from, to] = [fires[index - 1], fires[index]];
    const down = downtime.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, to) - Math.max(start, from)), 0);
    if (to - from - down > periodMs + slackMs) gaps.push({ from, to, gapMs: to - from, downMs: down });
  }
  return gaps;
}
