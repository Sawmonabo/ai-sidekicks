// A repair read landing on a store that already holds a window: where it takes the stream up
// again, what the window keeps while the replay runs, and what it holds once whole. Cases assert
// the rows and the partitions the window ends with, since a repair that reads whole over a missing
// row, a lost page or a lost projection is the failure guarded here.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { describe, expect, it } from "vitest";

import { eventOfKind } from "#test/helpers/session/events.js";
import { MAX_REPAIRABLE_SEQUENCE_GAP } from "./caps.js";
import type { EntityProjectorTable, ProjectedSessionEvent } from "./entities/vocabulary.js";
import type { RepairReopening, SessionBaseState, SessionStoreState } from "./state.js";
import { SessionStore } from "./store.js";

const SESSION_ID = "session-1";

/** A repair that reopens the stream at the window's head. */
const AT_HEAD: RepairReopening = { from: "head", headCursor: undefined };

/** A repair read's base state, which carries no rows and no live runs here. */
const REPAIR_READ: SessionBaseState = { entities: [] };

function eventAt(sequence: number): ProjectedSessionEvent {
  return eventOfKind(SESSION_ID, "run.starting", sequence);
}

function eventsAt(sequences: readonly number[]): ProjectedSessionEvent[] {
  return sequences.map(eventAt);
}

function sequencesOf(state: SessionStoreState): number[] {
  return state.transcript.map((event) => event.sequence);
}

function cursorAt(sequence: number): EventCursor {
  return eventAt(sequence).cursor as EventCursor;
}

/** A repair that reopens the stream after the held row at `sequence`. */
function afterRow(sequence: number): RepairReopening {
  return { from: "row", rowCursor: cursorAt(sequence) };
}

/** A repair read's base state with the stream reopened after the row at `sequence`. */
function readAfterRow(sequence: number): SessionBaseState {
  return { entities: [], streamAfterCursor: cursorAt(sequence) };
}

/** One run per `run.starting` row, named for its sequence; the row at `failingSequence` throws. */
function runPerRow(failingSequence?: number): EntityProjectorTable {
  return {
    "run.starting": (event) => {
      if (event.sequence === failingSequence) {
        throw new TypeError("the payload was not the shape this projector claims");
      }
      return [
        { operation: "upsert", entity: { kind: "run", id: `run-${String(event.sequence)}` } },
      ];
    },
  };
}

/** The runs a state projects, by the sequence each was named for, ascending. */
function runSequencesOf(state: SessionStoreState): number[] {
  return Object.keys(state.partitions.run)
    .map((runId) => Number(runId.slice("run-".length)))
    .sort((left, right) => left - right);
}

describe("a repair read lands on a store that already holds a window", () => {
  it("keeps a degraded window on screen until its replay passes the rows it held", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ cursor: 5, entities: [] });
    store.applyBatch(eventsAt([6, 8]));
    // A row the old stream hands over before the read lands still joins the window.
    store.applyBatch(eventsAt([9]));
    const held = store.snapshot();
    expect(held.degradedCause).toBe("sequence-gap");
    const published: SessionStoreState[] = [];
    const unsubscribe = store.readable.subscribe((state) => published.push(state));

    expect(store.repair(REPAIR_READ, AT_HEAD)).toBe(true);
    store.applyBatch(eventsAt([6, 7]));
    store.applyBatch(eventsAt([8]));
    expect(store.snapshot().transcript).toBe(held.transcript);
    store.applyBatch(eventsAt([9, 10]));
    unsubscribe();

    // Every state before the swap still holds the rows and says it is behind.
    const beforeSwap = published.slice(0, -1);
    expect(beforeSwap.length).toBeGreaterThan(0);
    for (const state of beforeSwap) {
      expect(state).toMatchObject({ degradedCause: "sequence-gap", isReplaying: true });
      expect(sequencesOf(state)).toStrictEqual([6, 8, 9]);
    }
    // The swap lands the hole's row, and the rows the window held keep their identity.
    const swapped = store.snapshot();
    expect(swapped).toMatchObject({ degradedCause: undefined, isReplaying: false, gaps: [] });
    expect(sequencesOf(swapped)).toStrictEqual([6, 7, 8, 9, 10]);
    expect(swapped.transcript[0]).toBe(held.transcript[0]);
    expect(swapped.cursor).toBe(10);
  });

  it("keeps a cause raised during the replay past the swap, so the next read still repairs", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ cursor: 5, entities: [] });
    store.applyBatch(eventsAt([6, 8]));
    store.repair(REPAIR_READ, AT_HEAD);

    // The replay's stream is lost before it passes the rows held.
    store.markDegraded("stream-diverged");
    store.applyBatch(eventsAt([6, 7, 8]));

    // Swapped in whole, the store would refuse the read the lost stream asked for.
    expect(store.snapshot().degradedCause).toBe("stream-diverged");
    expect(store.repair(REPAIR_READ, AT_HEAD)).toBe(true);
  });

  it("leaves a WHOLE store untouched by any read, whatever it names", () => {
    // Guards against admitting every read, which would rebuild the projection on each focus
    // refresh and empty the transcript for a base state carrying none.
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ cursor: 0, entities: [] });
    store.apply(eventAt(1));
    const before = store.snapshot();

    expect(store.initialize({ entities: [] })).toBe(false);
    expect(store.initialize({ cursor: 9, entities: [] })).toBe(false);
    expect(store.repair(readAfterRow(1), afterRow(1))).toBe(false);

    expect(store.snapshot()).toBe(before);
    expect(sequencesOf(store.snapshot())).toStrictEqual([1]);
  });

  it("marks a healthy store degraded with the cause it is handed", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ cursor: 0, entities: [] });

    store.markDegraded("subscription-closed");

    expect(store.snapshot().degradedCause).toBe("subscription-closed");
  });
});

describe("a repair takes the stream up again from the last row the window holds whole", () => {
  it("replays a hole from the row before it, onto the partitions that stood there", () => {
    const store = new SessionStore({ sessionId: SESSION_ID, projectors: runPerRow() });
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt([1, 2, 3]));
    store.applyBatch(eventsAt([5, 6]));
    const held = store.snapshot();
    expect(held.repairResumePoint).toMatchObject({ kind: "checkpoint", cursor: 3 });
    const published: SessionStoreState[] = [];
    const unsubscribe = store.readable.subscribe((state) => published.push(state));

    // Only the hole and what followed it are sent again.
    expect(store.repair(readAfterRow(3), afterRow(3))).toBe(true);
    store.applyBatch(eventsAt([4, 5]));
    store.applyBatch(eventsAt([6, 7]));
    unsubscribe();

    for (const state of published.slice(0, -1)) {
      expect(state).toMatchObject({ degradedCause: "sequence-gap", isReplaying: true });
      expect(sequencesOf(state)).toStrictEqual([1, 2, 3, 5, 6]);
    }
    const swapped = store.snapshot();
    expect(swapped).toMatchObject({ degradedCause: undefined, isReplaying: false, gaps: [] });
    expect(sequencesOf(swapped)).toStrictEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(swapped.transcript.slice(0, 3)).toStrictEqual(held.transcript.slice(0, 3));
    expect(swapped.transcript[0]).toBe(held.transcript[0]);
    // Rows 1 to 3 were never sent again; their runs stand from the checkpoint.
    expect(runSequencesOf(swapped)).toStrictEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it.each([
    { fault: "a hole", projectors: runPerRow(), rows: [1, 2, 4], then: [5, 6, 8] },
    { fault: "a projector that throws", projectors: runPerRow(3), rows: [1, 2, 3], then: [4, 6] },
    {
      fault: "a sequence past the repairable gap",
      projectors: runPerRow(),
      rows: [1, 2, MAX_REPAIRABLE_SEQUENCE_GAP + 4],
      then: [3, 4, 6],
    },
    {
      fault: "a sequence no run can carry",
      projectors: runPerRow(),
      rows: [1, 2, Number.NaN],
      then: [3, 4, 6],
    },
  ])("sets the checkpoint at the row before $fault, and a later hole keeps it", (scenario) => {
    const store = new SessionStore({ sessionId: SESSION_ID, projectors: scenario.projectors });
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt(scenario.rows));
    // Rows that fold whole, then a hole, which would set a checkpoint of its own.
    store.applyBatch(eventsAt(scenario.then));

    const point = store.snapshot().repairResumePoint;
    expect(point).toMatchObject({ kind: "checkpoint", cursor: 2, rowCursor: cursorAt(2) });
    expect(point.kind === "checkpoint" && Object.keys(point.partitions.run).sort()).toStrictEqual([
      "run-1",
      "run-2",
    ]);
  });

  it("stands a window that lost only its stream whole, replaying nothing", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt([1, 2, 3]));
    store.markDegraded("stream-diverged");
    const held = store.snapshot();

    expect(store.repair(readAfterRow(3), afterRow(3))).toBe(true);

    expect(store.snapshot()).toMatchObject({ degradedCause: undefined, isReplaying: false });
    expect(store.snapshot().transcript).toBe(held.transcript);
    // The stream after the newest row sends what follows; a row it sends again is a duplicate.
    expect(store.applyBatch(eventsAt([3, 4])).duplicates).toBe(1);
    expect(sequencesOf(store.snapshot())).toStrictEqual([1, 2, 3, 4]);
  });

  it("replays from the head when the fault came before any row the stream sent", () => {
    const store = new SessionStore({ sessionId: SESSION_ID, projectors: runPerRow(1) });
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt([1, 2]));
    const held = store.snapshot();
    expect(held.repairResumePoint).toStrictEqual({ kind: "head" });

    // No row precedes the fault, so a read after a row cannot be taken up and is refused.
    expect(store.repair(readAfterRow(1), afterRow(1))).toBe(false);
    expect(store.snapshot()).toBe(held);
    expect(store.repair(REPAIR_READ, AT_HEAD)).toBe(true);
    expect(store.snapshot().isReplaying).toBe(true);
  });

  it("replays a hole the replay opened from the replay's own last whole row", () => {
    const store = new SessionStore({ sessionId: SESSION_ID, projectors: runPerRow() });
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt([1, 2, 4, 5, 6]));
    store.repair(readAfterRow(2), afterRow(2));
    // The replay folds the window's hole, then opens one of its own.
    store.applyBatch(eventsAt([3, 5]));
    expect(store.repairResumeRowCursor).toBe(cursorAt(3));

    expect(store.repair(readAfterRow(3), afterRow(3))).toBe(true);
    store.applyBatch(eventsAt([4, 5, 6]));

    expect(store.snapshot()).toMatchObject({ degradedCause: undefined, isReplaying: false });
    expect(sequencesOf(store.snapshot())).toStrictEqual([1, 2, 3, 4, 5, 6]);
    expect(runSequencesOf(store.snapshot())).toStrictEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("what a window keeps across its repair", () => {
  const WINDOW_HEAD = cursorAt(10);

  it.each([
    { repair: "from the row before the hole", reopening: afterRow(12), sentAgain: [13, 14, 15] },
    { repair: "from the window's head", reopening: AT_HEAD, sentAgain: [11, 12, 13, 14, 15] },
  ])("keeps the rows backward pages loaded, before and during a repair $repair", (scenario) => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({
      entities: [],
      streamAfterCursor: WINDOW_HEAD,
      transcriptHead: { cursor: WINDOW_HEAD, hasMore: true },
    });
    store.applyBatch(eventsAt([11, 12, 14]));
    store.prependEarlierEvents(eventsAt([8, 9]), { cursor: cursorAt(7), hasMore: true });

    store.repair(REPAIR_READ, scenario.reopening);
    expect(store.snapshot().isReplaying).toBe(true);
    store.prependEarlierEvents(eventsAt([6, 7]), { cursor: cursorAt(5), hasMore: true });
    store.applyBatch(eventsAt(scenario.sentAgain));

    expect(store.snapshot()).toMatchObject({
      degradedCause: undefined,
      isReplaying: false,
      transcriptHead: { cursor: cursorAt(5), hasMore: true },
    });
    expect(sequencesOf(store.snapshot())).toStrictEqual([6, 7, 8, 9, 11, 12, 13, 14, 15]);
  });

  it("folds a replay past a detached tail into the entities and holds none of its rows", () => {
    const store = new SessionStore({ sessionId: SESSION_ID, projectors: runPerRow() });
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt([1, 2, 3, 4, 6]));
    store.releaseOutside(cursorAt(1), cursorAt(3));
    const held = store.snapshot();
    expect(held.transcriptTail).toStrictEqual({
      cursor: cursorAt(3),
      hasMore: true,
      following: "detached",
    });

    store.repair(readAfterRow(4), afterRow(4));
    store.applyBatch(eventsAt([5, 6, 7]));

    const swapped = store.snapshot();
    expect(swapped).toMatchObject({ degradedCause: undefined, isReplaying: false, cursor: 7 });
    expect(sequencesOf(swapped)).toStrictEqual([1, 2, 3]);
    expect(swapped.transcript[0]).toBe(held.transcript[0]);
    expect(swapped.transcriptTail).toBe(held.transcriptTail);
    expect(runSequencesOf(swapped)).toStrictEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("detaches a tail a forward page made live while the replay ran, short of the stream", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt([1, 2, 3, 4, 6]));
    store.releaseOutside(cursorAt(1), cursorAt(2));
    store.repair(readAfterRow(4), afterRow(4));

    // The page reaches the newest row the stream had sent, so the window's tail goes live.
    store.appendLaterEvents(eventsAt([3, 4, 5, 6]), { cursor: cursorAt(6), hasMore: false });
    expect(store.snapshot().transcriptTail.following).toBe("live");
    // The replay passes row 6 and folds row 7, which neither the page nor the replay holds.
    store.applyBatch(eventsAt([5, 6, 7]));

    expect(sequencesOf(store.snapshot())).toStrictEqual([1, 2, 3, 4, 5, 6]);
    expect(store.snapshot().transcriptTail).toStrictEqual({
      cursor: cursorAt(6),
      hasMore: true,
      following: "detached",
    });
  });
});

describe("the counts a failure is said again by", () => {
  it("keeps a read that failed while the replay ran counted past the swap", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt([1, 3]));
    store.repair(readAfterRow(1), afterRow(1));

    store.markReadFailed();
    store.applyBatch(eventsAt([2, 3]));

    expect(store.snapshot()).toMatchObject({
      degradedCause: undefined,
      lastReadFailed: false,
      readFailureCount: 1,
    });
  });

  it("counts a cause a replay raises again each time it comes to stand, at a swap too", () => {
    const store = new SessionStore({ sessionId: SESSION_ID, projectors: runPerRow(3) });
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt([1, 2, 3, 4]));
    expect(store.snapshot().raisedAgainCauseCount).toBe(1);
    // A cause already standing is not raised again.
    store.markDegraded("projection-failed");
    store.applyBatch(eventsAt([5]));
    expect(store.snapshot().raisedAgainCauseCount).toBe(1);

    // The replay fails on the same row: the repair ended where it began, a new failure.
    store.repair(readAfterRow(2), afterRow(2));
    store.applyBatch(eventsAt([3, 4, 5]));

    expect(store.snapshot()).toMatchObject({
      degradedCause: "projection-failed",
      isReplaying: false,
      raisedAgainCauseCount: 2,
    });
  });
});
