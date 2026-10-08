// The superseded mark a rollback writes onto the rows a store holds, driven through the store's
// apply path. An off-by-one cut dims the turn the person rewound to, an epoch-blind one dims a
// re-executed turn, and a mark that lives only beside its boundary row comes undone when the
// window lets that row go; none of them throws, so each row's mark is asserted.

import { describe, expect, it } from "vitest";

import { eventOfKind } from "#test/helpers/session/events.js";
import type { ProjectedSessionEvent } from "../../entities/vocabulary.js";
import { heldRowCursor } from "../../state.js";
import { SessionStore } from "../../store.js";
import { markSupersededByRollback } from "./superseded.js";

const SESSION_ID = "session-superseded";

/** One run row: its run, where the daemon stamped it, and the mark it arrived with, if any. */
interface RunRowInput {
  readonly sequence: number;
  readonly runId?: string;
  readonly epoch?: number;
  readonly position: number;
  readonly arrivedMarkedAt?: number;
}

function runRow(input: RunRowInput): ProjectedSessionEvent {
  return {
    ...eventOfKind(SESSION_ID, "run.running", input.sequence, { runId: input.runId ?? "run-a" }),
    runStamp: {
      position: input.position,
      epoch: input.epoch ?? 0,
      ...(input.arrivedMarkedAt === undefined
        ? {}
        : { superseded: { targetPosition: input.arrivedMarkedAt } }),
    },
  };
}

/** The `run.rolled_back` boundary that rewound `epoch` of run-a to `targetPosition`. */
function rollback(sequence: number, epoch: number, targetPosition: number): ProjectedSessionEvent {
  return {
    ...eventOfKind(SESSION_ID, "run.rolled_back", sequence, {
      sessionId: SESSION_ID,
      runId: "run-a",
      runVersion: sequence,
      targetPosition,
    }),
    runStamp: { position: targetPosition, epoch },
  };
}

/** Rows of run-a at `positions` in `epoch`, from `firstSequence` on. */
function turns(firstSequence: number, epoch: number, positions: readonly number[]) {
  return positions.map((position, index) =>
    runRow({ sequence: firstSequence + index, epoch, position }),
  );
}

/**
 * Each held run row as `run epoch:position` and its cut, or `current`; a boundary row reads as
 * `rollback` before it.
 */
function marksOf(store: SessionStore): string[] {
  return store.snapshot().transcript.flatMap((row) => {
    if (row.runStamp === undefined) {
      return [];
    }
    const name = row.kind === "run.rolled_back" ? "rollback" : String(row.payload?.["runId"]);
    const cut = row.runStamp.superseded?.targetPosition;
    return [
      `${name} ${String(row.runStamp.epoch)}:${String(row.runStamp.position)} ` +
        (cut === undefined ? "current" : `cut ${String(cut)}`),
    ];
  });
}

/** A store whose window a read placed with `rows`, the stream then following it. */
function storeHolding(rows: readonly ProjectedSessionEvent[]): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialize({ cursor: rows.at(-1)?.sequence ?? 0, entities: [], transcript: rows });
  return store;
}

describe("a rollback marks the rows it supersedes on the rows themselves", () => {
  it("marks the held rows of its run above the cut by position, never by sequence", () => {
    const store = storeHolding([
      runRow({ sequence: 1, position: 1 }),
      runRow({ sequence: 2, position: 4 }),
      runRow({ sequence: 3, position: 3 }),
      runRow({ sequence: 4, position: 2 }),
      runRow({ sequence: 5, runId: "run-b", position: 9 }),
    ]);

    store.applyBatch([rollback(6, 0, 2)]);

    expect(marksOf(store)).toStrictEqual([
      "run-a 0:1 current",
      "run-a 0:4 cut 2",
      "run-a 0:3 cut 2",
      // The row at the cut is the turn rewound to.
      "run-a 0:2 current",
      "run-b 0:9 current",
      "rollback 0:2 current",
    ]);
  });

  it("keeps the daemon's stamp on rows arriving after it, and never marks a new epoch", () => {
    const store = storeHolding(turns(1, 0, [1, 2, 3]));
    store.applyBatch([rollback(4, 0, 2)]);

    store.applyBatch([
      // A late straggler above the cut, stamped superseded by the daemon.
      runRow({ sequence: 5, position: 5, arrivedMarkedAt: 2 }),
      // One ranking into the surviving history, stamped current.
      runRow({ sequence: 6, position: 2 }),
      // The re-executed turn reuses position 3 in the next epoch.
      runRow({ sequence: 7, epoch: 1, position: 3 }),
    ]);

    expect(marksOf(store).slice(4)).toStrictEqual([
      "run-a 0:5 cut 2",
      "run-a 0:2 current",
      "run-a 1:3 current",
    ]);
  });

  it("marks a held window across earlier rollbacks as a read after the boundary would", () => {
    // A window opened after a rollback cut epoch 0 at 5: epoch 1's turns, and epoch 0 stragglers
    // below the cut, current, and above it, stamped by the daemon.
    const store = storeHolding([
      runRow({ sequence: 12, epoch: 1, position: 6 }),
      runRow({ sequence: 13, position: 2 }),
      runRow({ sequence: 14, position: 4 }),
      runRow({ sequence: 15, position: 7, arrivedMarkedAt: 5 }),
      runRow({ sequence: 16, epoch: 1, position: 7 }),
    ]);

    store.applyBatch([rollback(17, 1, 3)]);
    // The window lets the boundary row go; the marks stay on the rows.
    const held = store.snapshot().transcript;
    store.releaseOutside(heldRowCursor(held[0]!), heldRowCursor(held.at(-2)!));

    // A read after the boundary stamps each epoch at the lowest cut at that epoch or later.
    expect(marksOf(store)).toStrictEqual([
      "run-a 1:6 cut 3",
      "run-a 0:2 current",
      "run-a 0:4 cut 3",
      "run-a 0:7 cut 3",
      "run-a 1:7 cut 3",
    ]);
  });

  it("changes nothing when a replay folds a rollback again over the rows after it", () => {
    // A replay folds again over the window's own rows, which already hold the re-executed epoch
    // and the marks this rollback wrote.
    const held = [
      runRow({ sequence: 6, position: 6, arrivedMarkedAt: 5 }),
      rollback(11, 0, 5),
      runRow({ sequence: 12, epoch: 1, position: 6 }),
      runRow({ sequence: 13, epoch: 1, position: 7 }),
    ];

    expect(markSupersededByRollback(held, rollback(11, 0, 5))).toBe(held);
  });

  it.each([
    {
      sequence: "10→5, re-execute, 7→6",
      secondCut: 6,
      marks: [
        ...[1, 2, 3, 4, 5].map((position) => `run-a 0:${String(position)} current`),
        ...[6, 7, 8, 9, 10].map((position) => `run-a 0:${String(position)} cut 5`),
        "rollback 0:5 current",
        "run-a 1:6 current",
        "run-a 1:7 cut 6",
        "rollback 1:6 current",
      ],
    },
    {
      sequence: "10→5, re-execute to 7, 7→3",
      secondCut: 3,
      marks: [
        ...[1, 2, 3].map((position) => `run-a 0:${String(position)} current`),
        ...[4, 5, 6, 7, 8, 9, 10].map((position) => `run-a 0:${String(position)} cut 3`),
        "rollback 0:5 cut 3",
        "run-a 1:6 cut 3",
        "run-a 1:7 cut 3",
        "rollback 1:3 current",
      ],
    },
  ])("marks each epoch of the $sequence lineage at its own cut", ({ secondCut, marks }) => {
    const store = storeHolding(turns(1, 0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    store.applyBatch([rollback(11, 0, 5), ...turns(12, 1, [6, 7])]);
    store.applyBatch([rollback(14, 1, secondCut)]);

    expect(marksOf(store)).toStrictEqual(marks);
  });
});
