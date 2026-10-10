// The find matcher: what each row is searched by, the cap asserted beside the uncapped total so a
// capped count cannot understate how broad the query is, and what a held search reads again.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import { describe, expect, it } from "vitest";

import {
  FIND_MATCH_CAP,
  FindMatchList,
  FoldedMatchCount,
  findInTranscript,
  stepFindMatch,
  type FindResult,
} from "./matcher.js";
import { generalRow, runRow, userMessageRow } from "../event-rows.test-support.js";
import { type SystemMessageReading } from "../system-messages/classifier.js";

/** A window with no system message in it. */
const NO_SYSTEM_MESSAGES: ReadonlyMap<string, SystemMessageReading> = new Map();

/** The system message a rollback row draws, keyed by its row. */
const ROLLBACK_LINE = new Map<string, SystemMessageReading>([
  ["s1", { kind: "rollback", label: "Rolled back to the deploy", rowId: "s1", timestamp: "" }],
]);

function searchWindow(): readonly TranscriptEventRow[] {
  return [
    userMessageRow({ id: "u1", sequence: 1, message: "Rewrite the DEPLOY plan" }),
    runRow({
      id: "t1",
      sequence: 2,
      type: "tool.invoked",
      runId: "run-a",
      position: 2,
      payload: { toolName: "run_checks" },
    }),
    generalRow({ id: "s1", sequence: 3, type: "run.rolled_back" }),
    generalRow({
      id: "g1",
      sequence: 4,
      type: "session.renamed",
      category: "session_lifecycle",
      payload: { newName: "deploy war room" },
    }),
  ];
}

/** The ids of the rows `query` matches in the search window. */
function matchedRowIds(query: string): readonly string[] {
  return findInTranscript(searchWindow(), query, ROLLBACK_LINE).matches.map((match) => match.rowId);
}

describe("find — what a query matches", () => {
  it("matches a person's whole message, case-insensitively", () => {
    // The words sit past 4096 characters, so a search of a cut copy would miss them.
    const message = `${"and keep going ".repeat(300)}until the very end`;
    const rows = [userMessageRow({ id: "long", sequence: 1, message })];
    expect(findInTranscript(rows, "Until The Very End", new Map()).matches).toStrictEqual([
      { rowId: "long", sequence: 1 },
    ]);
    expect(matchedRowIds("deploy")).toStrictEqual(["u1", "s1"]);
  });

  it("matches a tool row's heading as the card draws it", () => {
    expect(matchedRowIds("run_checks running")).toStrictEqual(["t1"]);
  });

  it("matches a system message's line", () => {
    expect(matchedRowIds("rolled back")).toStrictEqual(["s1"]);
  });

  it("matches no wire type, and no payload a row does not draw", () => {
    for (const query of ["user.message", "invoked", "run.rolled_back", "war room"]) {
      expect(matchedRowIds(query)).toStrictEqual([]);
    }
  });

  it("matches nothing on an empty or whitespace-only query", () => {
    for (const query of ["", "   ", "\t\n"]) {
      const result = findInTranscript(searchWindow(), query, ROLLBACK_LINE);
      expect(result.matches).toStrictEqual([]);
      expect(result.totalMatchCount).toBe(0);
      expect(result.searchedRowCount).toBe(4);
    }
  });
});

describe("find — the cap bounds the walk and never the count", () => {
  function oversizedWindow(): readonly TranscriptEventRow[] {
    return Array.from({ length: FIND_MATCH_CAP + 5 }, (_unused, index) =>
      userMessageRow({
        id: `row-${String(index)}`,
        sequence: index + 1,
        message: "recurring line",
      }),
    );
  }

  it("walks at most the cap and reports the true total", () => {
    const result = findInTranscript(oversizedWindow(), "recurring", new Map());
    expect(result.matches).toHaveLength(FIND_MATCH_CAP);
    expect(result.totalMatchCount).toBe(FIND_MATCH_CAP + 5);
    expect(result.searchedRowCount).toBe(FIND_MATCH_CAP + 5);
  });

  it("reads, held across a list growing past the cap, what a whole search reads", () => {
    // Every third row says nothing the query finds, so the held list must skip rows, and the
    // matches run past the cap, so it must stop the walk there and keep counting.
    const grown = Array.from({ length: FIND_MATCH_CAP * 2 }, (_unused, index) =>
      userMessageRow({
        id: `row-${String(index)}`,
        sequence: index + 1,
        message: index % 3 === 2 ? "quiet line" : "recurring line",
      }),
    );
    const held = new FindMatchList();
    const published: { readonly result: FindResult; readonly text: string }[] = [];
    let rows: readonly TranscriptEventRow[] = [];
    for (const row of grown) {
      rows = [...rows, row];
      const result = held.resultOf(rows, " Recurring ", NO_SYSTEM_MESSAGES);
      const text = JSON.stringify(result);
      expect(text).toBe(JSON.stringify(findInTranscript(rows, " Recurring ", NO_SYSTEM_MESSAGES)));
      published.push({ result, text });
    }
    expect(published.at(-1)?.result.matches).toHaveLength(FIND_MATCH_CAP);
    // A row projected again with new words stops matching, so the held list gives it up.
    const reworded = rows.map((row) =>
      row.id === "row-0"
        ? userMessageRow({ id: row.id, sequence: row.sequence, message: "quiet" })
        : row,
    );
    expect(held.resultOf(reworded, " Recurring ", NO_SYSTEM_MESSAGES)).toStrictEqual(
      findInTranscript(reworded, " Recurring ", NO_SYSTEM_MESSAGES),
    );
    // Nothing a step published changed under a later one.
    expect(published.filter(({ result, text }) => JSON.stringify(result) !== text)).toStrictEqual(
      [],
    );
  });
});

describe("find — a held search over a growing log", () => {
  it("reads only the rows an append added", () => {
    let labelReads = 0;
    /** A rollback's line that counts each time Find reads it. */
    function countedLine(rowId: string): SystemMessageReading {
      return {
        kind: "rollback",
        get label() {
          labelReads += 1;
          return "Rolled back";
        },
        rowId,
        timestamp: "",
      };
    }
    const rowsAt = (count: number): readonly TranscriptEventRow[] =>
      Array.from({ length: count }, (_unused, index) =>
        generalRow({ id: `s${String(index)}`, sequence: index + 1, type: "run.rolled_back" }),
      );
    const linesAt = (rows: readonly TranscriptEventRow[]) =>
      new Map(rows.map((row) => [row.id, countedLine(row.id)]));
    const held = new FindMatchList();
    const first = rowsAt(20);
    held.resultOf(first, "rolled", linesAt(first));
    labelReads = 0;

    const grown = [...first, ...rowsAt(21).slice(20)];
    const result = held.resultOf(grown, "rolled", linesAt(grown));

    expect(result.totalMatchCount).toBe(21);
    expect(labelReads).toBe(1);
  });
});

describe("find — stepping the walk", () => {
  const result = findInTranscript(
    [
      userMessageRow({ id: "r1", sequence: 1, message: "hit one" }),
      userMessageRow({ id: "r2", sequence: 2, message: "hit two" }),
      userMessageRow({ id: "r3", sequence: 3, message: "hit three" }),
    ],
    "hit",
    NO_SYSTEM_MESSAGES,
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
    const empty = findInTranscript(searchWindow(), "no row says this", ROLLBACK_LINE);
    expect(stepFindMatch(empty, 0, "next")).toBeUndefined();
  });
});

describe("find — the first step, before anything is selected", () => {
  /** A window whose every row matches `hit`, so the match list is exactly `count` long. */
  function windowOfMatches(count: number): readonly TranscriptEventRow[] {
    return Array.from({ length: count }, (_unused, index) =>
      userMessageRow({ id: `hit-${String(index + 1)}`, sequence: index + 1, message: "hit" }),
    );
  }

  function resultOver(count: number): ReturnType<typeof findInTranscript> {
    return findInTranscript(windowOfMatches(count), "hit", NO_SYSTEM_MESSAGES);
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

describe("find — the matches a run fold withholds, held across what it reports", () => {
  function foldedRow(sequence: number, message: string): TranscriptEventRow {
    return userMessageRow({ id: `folded-${String(sequence)}`, sequence, message });
  }

  it("counts what a whole count over each list counts", () => {
    const hit = foldedRow(10, "hit");
    const undrawn = foldedRow(20, "hit, drawn as nothing");
    const systemMessage = foldedRow(30, "hit, a system message");
    const miss = foldedRow(40, "miss");
    const joined = foldedRow(25, "hit, let go into the middle");
    const reworded = userMessageRow({ id: hit.id, sequence: hit.sequence, message: "reworded" });
    const outOfOrder = [foldedRow(50, "hit"), foldedRow(45, "hit")];
    const systemMessages = new Map<string, SystemMessageReading>([
      [
        systemMessage.id,
        {
          kind: "rollback",
          label: "Rolled back to the hit",
          rowId: systemMessage.id,
          timestamp: "",
        },
      ],
    ]);
    // The system message's row left the window with the third list, so its reading went with it;
    // the fourth list is out of log order.
    const steps: readonly {
      readonly rows: readonly TranscriptEventRow[];
      readonly systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>;
      readonly count: number;
    }[] = [
      { rows: [hit, undrawn, systemMessage, miss], systemMessageByRowId: systemMessages, count: 2 },
      {
        rows: [hit, undrawn, joined, systemMessage, miss],
        systemMessageByRowId: systemMessages,
        count: 3,
      },
      { rows: [reworded, undrawn, joined, miss], systemMessageByRowId: new Map(), count: 1 },
      { rows: [reworded, ...outOfOrder], systemMessageByRowId: new Map(), count: 2 },
    ];
    const drawsBody = (row: TranscriptEventRow): boolean =>
      row.id !== undrawn.id && row.id !== systemMessage.id;
    const held = new FoldedMatchCount();
    const counted = steps.map((step) =>
      held.countOf(step.rows, "HIT", step.systemMessageByRowId, drawsBody),
    );
    expect(counted).toStrictEqual(steps.map((step) => step.count));
  });
});
