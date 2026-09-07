// The band fold, driven with no store and no React — what it removes and what it keeps.
//
// The subject is the pass rather than the screen, because the two things that can go
// wrong here are invisible in a mounted feed: a band whose header never appears, and a
// fold that removes a row the rewind actually left standing.

import { describe, expect, it } from "vitest";

import { deriveLedgerWindow, type LedgerWindowModel } from "../window/ledger-window.js";
import { LedgerRowRetention } from "../window/ledger-row-retention.js";
import { type ConsoleSessionEvent } from "../../../store/index.js";
import { ledgerFixtureStampAt } from "./ledger-feed-logs.test-support.js";
import { foldSupersededBands } from "./ledger-superseded-fold.js";

const SESSION_ID = "019b793b-7b60-740e-8110-d1a4c1150333";
const RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150222";

/** Four turns of one run, then a rollback that rewound past the first of them. */
function rewoundLog(targetPosition: number): readonly ConsoleSessionEvent[] {
  const turns: ConsoleSessionEvent[] = Array.from({ length: 4 }, (_unused, index) => ({
    id: `turn-${String(index)}`,
    sessionId: SESSION_ID,
    sequence: index,
    kind: "assistant.message",
    occurredAt: ledgerFixtureStampAt(index),
    payload: { sessionId: SESSION_ID, runId: RUN_ID },
  }));
  return [
    ...turns,
    {
      id: "boundary",
      sessionId: SESSION_ID,
      sequence: turns.length,
      kind: "run.rolled_back",
      occurredAt: ledgerFixtureStampAt(turns.length),
      payload: { sessionId: SESSION_ID, runId: RUN_ID, runVersion: 6, targetPosition },
    },
  ];
}

function rewoundWindow(targetPosition = 1): LedgerWindowModel {
  return deriveLedgerWindow(rewoundLog(targetPosition), false);
}

/** Every viewport key the fold published, headers included. */
function viewportKeys(model: LedgerWindowModel): readonly string[] {
  return model.viewportRows.map((viewportRow) => viewportRow.key);
}

describe("the band fold — a header for every band, whether or not it is folded", () => {
  it("derives at least one band from a rewound log, or the rest of this file is vacuous", () => {
    expect(rewoundWindow().supersededBandByHeaderKey.size).toBeGreaterThan(0);
  });

  it("gives an OPEN band a header and removes none of its rows", () => {
    const model = rewoundWindow();
    const folded = foldSupersededBands(model, new Set(), new LedgerRowRetention());
    const [bandKey] = [...model.supersededBandByHeaderKey.keys()];
    expect(viewportKeys(folded.window)).toContain(bandKey);
    expect(folded.removedRows).toStrictEqual([]);
    expect(folded.window.rows).toHaveLength(model.rows.length);
  });

  it("removes a folded band's rows from the viewport and keeps its header", () => {
    const model = rewoundWindow();
    const [bandKey] = [...model.supersededBandByHeaderKey.keys()];
    if (bandKey === undefined) {
      throw new Error("the rewound window derived no band");
    }
    const band = model.supersededBandByHeaderKey.get(bandKey);
    const folded = foldSupersededBands(model, new Set([bandKey]), new LedgerRowRetention());
    const keys = viewportKeys(folded.window);
    expect(keys).toContain(bandKey);
    for (const rowId of band?.rowIds ?? []) {
      expect(keys).not.toContain(rowId);
      expect(folded.window.rowsByKey.has(rowId)).toBe(false);
    }
    expect(folded.removedRows).toHaveLength(band?.rowIds.length ?? -1);
  });

  it("negative control: the rows the rewind left standing survive a fold", () => {
    const model = rewoundWindow();
    const [bandKey] = [...model.supersededBandByHeaderKey.keys()];
    if (bandKey === undefined) {
      throw new Error("the rewound window derived no band");
    }
    const bandRowIds = new Set(model.supersededBandByHeaderKey.get(bandKey)?.rowIds ?? []);
    const survivors = model.rows.filter((row) => !bandRowIds.has(row.id)).map((row) => row.id);
    expect(survivors.length).toBeGreaterThan(0);
    const folded = foldSupersededBands(model, new Set([bandKey]), new LedgerRowRetention());
    for (const rowId of survivors) {
      expect(viewportKeys(folded.window)).toContain(rowId);
    }
  });

  it("publishes the window untouched when no rollback rewound anything", () => {
    const model = deriveLedgerWindow(rewoundLog(1).slice(0, 4), false);
    const folded = foldSupersededBands(model, new Set(), new LedgerRowRetention());
    expect(folded.window).toBe(model);
    expect(folded.removedRows).toStrictEqual([]);
  });

  it("holds a header's identity across two passes, so the row it drew is not redrawn", () => {
    const model = rewoundWindow();
    const retention = new LedgerRowRetention();
    const first = foldSupersededBands(model, new Set(), retention);
    const second = foldSupersededBands(model, new Set(), retention);
    const [bandKey] = [...model.supersededBandByHeaderKey.keys()];
    const headerOf = (folded: LedgerWindowModel): unknown =>
      folded.viewportRows.find((viewportRow) => viewportRow.key === bandKey);
    expect(headerOf(second.window)).toBe(headerOf(first.window));
  });

  it("passes an upstream row through with the identity it arrived with", () => {
    const model = rewoundWindow();
    const folded = foldSupersededBands(model, new Set(), new LedgerRowRetention());
    const upstream = model.viewportRows[0];
    expect(folded.window.viewportRows).toContain(upstream);
  });
});
