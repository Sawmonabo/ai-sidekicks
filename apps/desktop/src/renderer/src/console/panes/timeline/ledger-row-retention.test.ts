// What one derivation's rows keep from the one before it.
//
// The subject is `LedgerRowRetention`, driven THROUGH `deriveLedgerWindow` rather than
// alone: the retention's value is a property of the derivation that uses it — which
// objects reach the feed and which of them are recognisable — and a case that called
// the table directly would prove the table works while saying nothing about whether
// the window is wired to it.
//
// The LOGS are built here rather than taken from `ledger-feed-logs.test-support.ts`
// because two of these cases need two logs that differ in ONE member of ONE event,
// which no shared builder offers and which is the whole instrument: it separates a
// table that compares what it holds from one that trusts a key and serves a stale
// row. The row ids and instants inside them are still that module's — a log written
// against its own clock would be a second fixture epoch, which is the thing a shared
// stamp exists to prevent.

import { describe, expect, it } from "vitest";

import { type ConsoleSessionEvent } from "../../store/index.js";
import { ledgerFixtureEventId, ledgerFixtureStampAt } from "./ledger-feed-logs.test-support.js";
import { LedgerRowRetention } from "./ledger-row-retention.js";
import { deriveLedgerWindow } from "./ledger-window.js";

const SESSION_ID = "session-ledger-row-retention";

/** A log entry the fixture shell can project. The row id it takes is derived from these. */
function logEntry(
  sequence: number,
  payload: Readonly<Record<string, unknown>>,
): ConsoleSessionEvent {
  return {
    id: ledgerFixtureEventId(sequence),
    sessionId: SESSION_ID,
    sequence,
    kind: "user.message",
    occurredAt: ledgerFixtureStampAt(sequence),
    payload,
  };
}

/** A log of `count` entries, each carrying its own payload object. */
function log(count: number): ConsoleSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => logEntry(index, { index }));
}

const LOG_ENTRY_COUNT = 4;

describe("the ledger window's row retention", () => {
  it("publishes the same row objects when the log gained an entry and nothing else moved", () => {
    const retention = new LedgerRowRetention();
    // ONE array of entries, appended to — which is what the store actually holds: it
    // admits an event by publishing a new array over the SAME entry objects. Rebuilding
    // the entries here would hand the projection fresh payload objects and the rows
    // would rightly take new identities, so the case would be measuring the fixture.
    const entries = log(LOG_ENTRY_COUNT);
    const before = deriveLedgerWindow(entries, false, retention);
    const after = deriveLedgerWindow([...entries, logEntry(LOG_ENTRY_COUNT, {})], false, retention);

    // Every row the first pass published is the SAME object in the second, and so is
    // its place in the virtualizer's identity list. Both halves matter: the feed's row
    // memo compares the projected row and the viewport's compares the identity triple,
    // so a pass that renewed either one re-renders the whole mounted window.
    for (const row of before.rows) {
      expect(after.rowsByKey.get(row.id)).toBe(row);
    }
    for (const identity of before.viewportRows) {
      expect(after.viewportRows.find((candidate) => candidate.key === identity.key)).toBe(identity);
    }
    expect(after.rows).toHaveLength(LOG_ENTRY_COUNT + 1);
  });

  it("publishes a new object for a row whose members moved", () => {
    // The negative control on the comparison. Without it the case above would pass
    // over a table that returned whatever it held under a key and never looked at the
    // candidate — which is not a cache but a stale card on screen, and the one failure
    // this whole mechanism can cause.
    const retention = new LedgerRowRetention();
    const first = [logEntry(0, { index: 0 }), logEntry(1, { index: 1 })];
    const before = deriveLedgerWindow(first, false, retention);
    const movedEntry = { ...logEntry(1, { index: 1 }), occurredAt: "2026-06-01T00:00:00.000Z" };
    const after = deriveLedgerWindow(
      [first[0] as ConsoleSessionEvent, movedEntry],
      false,
      retention,
    );

    const unchangedRow = before.rows[0];
    const movedRow = before.rows[1];
    if (unchangedRow === undefined || movedRow === undefined) {
      throw new Error("the fixture log projected fewer rows than it has entries");
    }
    expect(after.rowsByKey.get(unchangedRow.id)).toBe(unchangedRow);
    expect(after.rowsByKey.get(movedRow.id)).not.toBe(movedRow);
    expect(after.rowsByKey.get(movedRow.id)?.timestamp).toBe("2026-06-01T00:00:00.000Z");
  });

  it("negative control: a projection given no retention publishes all-new objects", () => {
    // This is the code that was here, stated as a case: `deriveLedgerWindow` used to
    // mint every row and every identity triple per call, so a log that gained one entry
    // handed the feed a window in which nothing had changed and nothing was
    // recognisable. Every assertion above would pass over a `toBe` that had quietly
    // become a structural compare; this one fails if it ever does.
    const entries = log(LOG_ENTRY_COUNT);
    const before = deriveLedgerWindow(entries, false);
    const after = deriveLedgerWindow(entries, false);

    for (const row of before.rows) {
      expect(after.rowsByKey.get(row.id)).not.toBe(row);
    }
    for (const identity of before.viewportRows) {
      expect(after.viewportRows.find((candidate) => candidate.key === identity.key)).not.toBe(
        identity,
      );
    }
  });

  it("forgets a row the projection stopped publishing", () => {
    // The table holds one pass, not every pass. A row that left and came back
    // unchanged takes a NEW object, which is the observable half of "this can never
    // outgrow the window it describes" — an accumulating map keyed by row id would
    // hand back the object it had been holding since the row left.
    const retention = new LedgerRowRetention();
    const entries = log(LOG_ENTRY_COUNT);
    const held = deriveLedgerWindow(entries, false, retention).rows[0];
    if (held === undefined) {
      throw new Error("the fixture log projected no rows");
    }
    deriveLedgerWindow([], false, retention);
    const readmitted = deriveLedgerWindow(entries, false, retention);

    expect(readmitted.rowsByKey.get(held.id)).not.toBe(held);
  });
});
