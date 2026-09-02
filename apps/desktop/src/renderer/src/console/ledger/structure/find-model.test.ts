// The find matcher, and the boundary that is the feature.
//
// A find field that searched what it had and said nothing would let a person
// conclude a session does not contain something it does. So the boundary members
// are asserted here beside the matching, and the cap is asserted together with the
// honest uncapped total — a count that silently equalled the cap would tell a
// person their query is narrower than it is.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { FIND_MATCH_CAP } from "./constants.js";
import {
  LEDGER_FIND_SCOPE_NOTE,
  emptyFindResult,
  findInLedger,
  stepFindMatch,
} from "./find-model.js";
import { generalRow, runRow } from "./row-fixtures.js";

function searchWindow(): readonly TimelineRow[] {
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

describe("find — the boundary is a member of the result", () => {
  it("states its scope in one sentence the field and this test both read", () => {
    expect(LEDGER_FIND_SCOPE_NOTE).toBe("Searched loaded rows only.");
  });

  it("reports what was searched and whether more exists, even with no query", () => {
    const result = emptyFindResult(3, true);
    expect(result.searchedRowCount).toBe(3);
    expect(result.hasEarlierRows).toBe(true);
    expect(result.matches).toStrictEqual([]);
  });

  it("carries both halves of the boundary through a real query", () => {
    const result = findInLedger(searchWindow(), "deploy", true);
    expect(result.searchedRowCount).toBe(3);
    expect(result.hasEarlierRows).toBe(true);
  });

  it("negative control: a complete window says so", () => {
    expect(findInLedger(searchWindow(), "deploy", false).hasEarlierRows).toBe(false);
  });
});

describe("find — what a query matches", () => {
  it("matches a row's summary, case-insensitively", () => {
    const result = findInLedger(searchWindow(), "deploy", false);
    expect(result.matches).toStrictEqual([{ rowId: "r1", sequence: 1, matchedIn: "summary" }]);
    expect(result.query).toBe("deploy");
  });

  it("matches the wire-verbatim event type when the summary does not carry it", () => {
    const result = findInLedger(searchWindow(), "rolled_back", false);
    expect(result.matches).toStrictEqual([{ rowId: "r2", sequence: 2, matchedIn: "type" }]);
  });

  it("negative control: the payload is not searched", () => {
    // `g1`'s payload contains "deploy war room". A substring hit inside an open
    // record would rank a row a person cannot see the match in.
    const matchedRowIds = findInLedger(searchWindow(), "war room", false).matches.map(
      (match) => match.rowId,
    );
    expect(matchedRowIds).toStrictEqual([]);
  });

  it("matches nothing on an empty or whitespace-only query", () => {
    for (const query of ["", "   ", "\t\n"]) {
      const result = findInLedger(searchWindow(), query, false);
      expect(result.matches).toStrictEqual([]);
      expect(result.totalMatchCount).toBe(0);
      expect(result.searchedRowCount).toBe(3);
    }
  });

  it("negative control: an empty query does not silently match everything", () => {
    // Highlighting every row the moment the field is focused is the failure this
    // guards; "everything" is what the ledger already shows.
    expect(findInLedger(searchWindow(), "", false).matches.length).not.toBe(3);
  });

  it("trims the query it reports, so the field echoes what it searched for", () => {
    expect(findInLedger(searchWindow(), "  deploy  ", false).query).toBe("deploy");
  });
});

describe("find — the cap bounds the walk and never the count", () => {
  /** One more row than the walk can hold, plus five, all matching. */
  function oversizedWindow(): readonly TimelineRow[] {
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
    const result = findInLedger(oversizedWindow(), "recurring", false);
    expect(result.matches).toHaveLength(FIND_MATCH_CAP);
    expect(result.totalMatchCount).toBe(FIND_MATCH_CAP + 5);
    expect(result.searchedRowCount).toBe(FIND_MATCH_CAP + 5);
  });

  it("negative control: under the cap the two numbers agree", () => {
    // Which is what shows the divergence above is the cap reporting itself rather
    // than the counter being wrong.
    const result = findInLedger(searchWindow(), "e", false);
    expect(result.totalMatchCount).toBe(result.matches.length);
  });
});

describe("find — stepping the walk", () => {
  const result = findInLedger(
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
    false,
  );

  it("walks forward and wraps at the end", () => {
    // Unlike the rail, find wraps — the counter shows "3 of 3" turning into
    // "1 of 3", so the wrap is visible rather than a jump with no explanation.
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

  it("negative control: there is nothing to walk with no matches", () => {
    const empty = findInLedger(searchWindow(), "no row says this", false);
    expect(stepFindMatch(empty, 0, "next")).toBeUndefined();
  });
});
