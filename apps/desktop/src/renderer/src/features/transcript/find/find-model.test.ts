// The find matcher and its boundary: the cap is asserted beside the uncapped total, so a
// capped count cannot understate how broad the query is.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import { describe, expect, it } from "vitest";

import { findInTranscript, stepFindMatch } from "./find-model.js";
import { generalRow, runRow } from "../transcript-event-rows.test-support.js";
import { FIND_MATCH_CAP } from "./find-model.js";

function searchWindow(): readonly TranscriptEventRow[] {
  return [
    runRow({
      id: "r1",
      sequence: 1,
      type: "run.running",
      runId: "run-a",
      position: 1,
      summary: "Rewrote the DEPLOY plan",
    }),
    runRow({
      id: "r2",
      sequence: 2,
      type: "run.rolled_back",
      runId: "run-a",
      position: 2,
      summary: "history moved",
    }),
    generalRow({
      id: "g1",
      sequence: 3,
      type: "session.renamed",
      category: "session_lifecycle",
      summary: "renamed the session",
      payload: { newName: "deploy war room" },
    }),
  ];
}

describe("find — what a query matches", () => {
  it("matches a row's summary, case-insensitively", () => {
    const result = findInTranscript(searchWindow(), "deploy");
    expect(result.matches).toStrictEqual([{ rowId: "r1", sequence: 1, matchedIn: "summary" }]);
    expect(result.query).toBe("deploy");
  });

  it("matches the wire-verbatim event type when the summary does not carry it", () => {
    const result = findInTranscript(searchWindow(), "rolled_back");
    expect(result.matches).toStrictEqual([{ rowId: "r2", sequence: 2, matchedIn: "type" }]);
  });

  it("matches nothing on an empty or whitespace-only query", () => {
    for (const query of ["", "   ", "\t\n"]) {
      const result = findInTranscript(searchWindow(), query);
      expect(result.matches).toStrictEqual([]);
      expect(result.totalMatchCount).toBe(0);
      expect(result.searchedRowCount).toBe(3);
    }
  });
});

describe("find — the cap bounds the walk and never the count", () => {
  function oversizedWindow(): readonly TranscriptEventRow[] {
    return Array.from({ length: FIND_MATCH_CAP + 5 }, (_unused, index) =>
      runRow({
        id: `row-${String(index)}`,
        sequence: index + 1,
        type: "run.running",
        runId: "run-a",
        position: index + 1,
        summary: "recurring line",
      }),
    );
  }

  it("walks at most the cap and reports the true total", () => {
    const result = findInTranscript(oversizedWindow(), "recurring");
    expect(result.matches).toHaveLength(FIND_MATCH_CAP);
    expect(result.totalMatchCount).toBe(FIND_MATCH_CAP + 5);
    expect(result.searchedRowCount).toBe(FIND_MATCH_CAP + 5);
  });
});

describe("find — stepping the walk", () => {
  const result = findInTranscript(
    [
      runRow({
        id: "r1",
        sequence: 1,
        type: "run.running",
        runId: "run-a",
        position: 1,
        summary: "hit one",
      }),
      runRow({
        id: "r2",
        sequence: 2,
        type: "run.running",
        runId: "run-a",
        position: 2,
        summary: "hit two",
      }),
      runRow({
        id: "r3",
        sequence: 3,
        type: "run.running",
        runId: "run-a",
        position: 3,
        summary: "hit three",
      }),
    ],
    "hit",
  );

  it("walks forward and wraps at the end", () => {
    // Find wraps; "3 of 3" turning into "1 of 3" makes the wrap visible.
    expect(stepFindMatch(result, 0, "next")?.index).toBe(1);
    expect(stepFindMatch(result, 2, "next")?.index).toBe(0);
  });

  it("walks backward and wraps at the start rather than landing on -1", () => {
    // JavaScript's `%` keeps the sign of the dividend, which is exactly how a
    // backward step from the first match becomes an index nothing holds.
    const stepped = stepFindMatch(result, 0, "previous");
    expect(stepped?.index).toBe(2);
    expect(stepped?.match.rowId).toBe("r3");
  });

  it("there is nothing to walk with no matches", () => {
    const empty = findInTranscript(searchWindow(), "no row says this");
    expect(stepFindMatch(empty, 0, "next")).toBeUndefined();
  });
});

describe("find — the first step, before anything is selected", () => {
  /** A window whose every row matches `hit`, so the match list is exactly `count` long. */
  function windowOfMatches(count: number): readonly TranscriptEventRow[] {
    return Array.from({ length: count }, (_unused, index) =>
      runRow({
        id: `hit-${String(index + 1)}`,
        sequence: index + 1,
        type: "run.running",
        runId: "run-a",
        position: index + 1,
        summary: "hit",
      }),
    );
  }

  function resultOver(count: number): ReturnType<typeof findInTranscript> {
    return findInTranscript(windowOfMatches(count), "hit");
  }

  const entries: readonly {
    readonly matchCount: number;
    readonly forwardRowId: string | undefined;
    readonly backwardRowId: string | undefined;
  }[] = [
    { matchCount: 0, forwardRowId: undefined, backwardRowId: undefined },
    { matchCount: 1, forwardRowId: "hit-1", backwardRowId: "hit-1" },
    { matchCount: 2, forwardRowId: "hit-1", backwardRowId: "hit-2" },
    { matchCount: 7, forwardRowId: "hit-1", backwardRowId: "hit-7" },
  ];

  it("enters the list at the first match going forward and the last going back", () => {
    for (const entry of entries) {
      const result = resultOver(entry.matchCount);
      expect(stepFindMatch(result, -1, "next")?.match.rowId).toBe(entry.forwardRowId);
      expect(stepFindMatch(result, -1, "previous")?.match.rowId).toBe(entry.backwardRowId);
    }
  });

  it("reports the entry position as an index the counter can render", () => {
    // The index drives the counter's "1 of 7" and "7 of 7"; the right row under the wrong index
    // would still read wrong.
    const result = resultOver(7);
    expect(stepFindMatch(result, -1, "next")?.index).toBe(0);
    expect(stepFindMatch(result, -1, "previous")?.index).toBe(6);
  });

  it("entering is not stepping — a selected walk still moves by one", () => {
    // Fails if the unselected arm were applied to every index: a backward step
    // from match 3 of 7 would then land on the last match rather than on match 2.
    const result = resultOver(7);
    expect(stepFindMatch(result, 2, "previous")?.index).toBe(1);
    expect(stepFindMatch(result, 2, "next")?.index).toBe(3);
  });
});
