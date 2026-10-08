// When a read moves the stream: a read the store takes names the position the stream opens after,
// and a whole live window makes no read. A stream lost past a hole too wide to fill takes a
// snapshot that replaces the window with the log's newest rows; a hole the store saw replays from
// the row before it, and what the replaced stream left queued never reaches the replay. A replay
// whose stream is refused goes on after the newest row it folded.

import { encodeEventCursor, type EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import {
  OPENING_PAGE_LIMIT,
  openingPageLimit,
  offScreenRowLimit,
} from "#test/helpers/session/store/fixtures.js";
import type { ProjectedSessionEvent } from "../entities/vocabulary.js";
import type { SessionBaseState } from "../state.js";
import {
  OpenSessionEntry,
  type SessionStreamPosition,
  type SessionWindowOpening,
} from "./entry.js";

/** A daemon read's base state: no sequence and no rows, the stream opening after `position`. */
function baseStateAt(position: number): SessionBaseState {
  return { entities: [], streamAfterCursor: encodeEventCursor(position) };
}

/** One event of the entry's session at `sequence`. */
function eventAt(sequence: number): ProjectedSessionEvent {
  return eventOfKind("session-1", "run.starting", sequence);
}

/** A repair read's base state: the stream reopened after the row at `sequence`. */
function afterRow(sequence: number): SessionBaseState {
  return { entities: [], streamAfterCursor: eventAt(sequence).cursor as EventCursor };
}

/** A snapshot's base state: the window `sequences` at the log's newest rows, more before it. */
function windowOf(sequences: readonly number[]): SessionBaseState {
  const transcript = sequences.map(eventAt);
  const newest = transcript.at(-1)!;
  return {
    cursor: newest.sequence,
    entities: [],
    transcript,
    streamAfterCursor: newest.cursor as EventCursor,
    transcriptHead: { cursor: encodeEventCursor(sequences[0]! - 1), hasMore: true },
  };
}

/** An entry whose reads answer `script` in turn, and the openings and positions it named. */
function scriptedEntry(
  script: readonly (SessionBaseState | Promise<SessionBaseState>)[],
  applyCoalesceMs: number,
): {
  readonly entry: OpenSessionEntry;
  readonly clock: ManualClock;
  readonly openings: SessionWindowOpening[];
  readonly positions: SessionStreamPosition[];
  readonly settle: () => Promise<void>;
} {
  const clock = new ManualClock(0);
  const openings: SessionWindowOpening[] = [];
  const entry = new OpenSessionEntry("session-1", {
    read: (_sessionId, _reasons, opening) => {
      openings.push(opening);
      return Promise.resolve(script[openings.length - 1]);
    },
    clock,
    openingPageLimit,
    offScreenRowLimit,
    applyCoalesceMs,
    refreshDebounceMs: 20,
  });
  const positions: SessionStreamPosition[] = [];
  entry.subscribeToStreamPosition((position) => positions.push(position));
  // Past the debounce, then the read's promise turns.
  async function settle(): Promise<void> {
    clock.advance(21);
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve();
    }
  }
  return { entry, clock, openings, positions, settle };
}

describe("OpenSessionEntry — the read places the window and the stream follows it", () => {
  it("re-reads a lost stream once and replaces the window with the log's newest rows", async () => {
    let landRepair: (baseState: SessionBaseState) => void = () => undefined;
    const repair = new Promise<SessionBaseState>((resolve) => {
      landRepair = resolve;
    });
    const { entry, openings, positions, settle } = scriptedEntry([baseStateAt(5), repair], 0);
    const sequences = (): number[] =>
      entry.store.snapshot().transcript.map((event) => event.sequence);

    entry.refreshScheduler.request("subscribe");
    await settle();
    // The first event after the read's position places the run, opening no gap.
    entry.store.applyBatch([eventAt(6), eventAt(7)]);
    // A whole live window keeps its stream and makes no read.
    entry.refreshScheduler.request("window-focus");
    await settle();
    expect(sequences()).toStrictEqual([6, 7]);
    expect(openings).toHaveLength(1);

    // A burst of holes too wide to fill, with no focus and no press.
    entry.loseStream();
    entry.loseStream();
    entry.loseStream();
    await settle();
    // The repair read is in flight: the window keeps its rows and still says it is behind.
    expect(entry.refreshScheduler.performCount).toBe(3);
    expect(entry.store.snapshot().degradedCause).toBe("stream-diverged");
    expect(sequences()).toStrictEqual([6, 7]);

    // The read answers with the log's newest rows, which replace the window whole.
    landRepair(windowOf([40, 41, 42]));
    await settle();
    expect(entry.store.snapshot().degradedCause).toBeUndefined();
    expect(sequences()).toStrictEqual([40, 41, 42]);
    // The stream after the window's newest row sends what follows; a row sent again is refused.
    entry.store.applyBatch([42, 43].map(eventAt));
    expect(sequences()).toStrictEqual([40, 41, 42, 43]);

    // One read for the whole burst, and the repair asks for no further one.
    await settle();
    expect(entry.refreshScheduler.performCount).toBe(3);
    expect(openings).toStrictEqual([
      { opensAt: "resume", refusedCursor: undefined, pageLimit: OPENING_PAGE_LIMIT },
      { opensAt: "latest", refusedCursor: undefined, pageLimit: OPENING_PAGE_LIMIT },
    ]);
    expect(positions).toStrictEqual([
      { afterCursor: encodeEventCursor(5), afterSequence: undefined },
      { afterCursor: "cursor-at-42", afterSequence: 42 },
    ]);

    entry.dispose();
  });

  it("repairs a hole from the row before it, dropping what the old stream queued", async () => {
    const coalesceMs = 50;
    const { entry, clock, openings, settle } = scriptedEntry(
      [baseStateAt(5), afterRow(6)],
      coalesceMs,
    );
    entry.refreshScheduler.request("subscribe");
    await settle();
    entry.store.applyBatch([eventAt(6), eventAt(8)]);
    expect(entry.store.snapshot().degradedCause).toBe("sequence-gap");

    // The old stream's row is still queued when the repair read lands.
    entry.applyQueue.enqueue(eventAt(50));
    entry.refreshScheduler.request("gap-repull");
    await settle();
    clock.advance(coalesceMs);
    // The stream opened after the row before the hole sends the hole and what followed it.
    entry.applyQueue.enqueueAll([7, 8].map(eventAt));
    entry.applyQueue.flush();

    // A stale row drained first would open a hole up to 50 and refuse these as duplicates.
    expect(openings[1]).toMatchObject({
      opensAt: "repair",
      reopening: { from: "row", rowCursor: "cursor-at-6" },
    });
    expect(entry.store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([
      6, 7, 8,
    ]);
    expect(entry.store.snapshot().gaps).toStrictEqual([]);
    expect(entry.store.snapshot().degradedCause).toBeUndefined();

    entry.dispose();
  });

  it("takes a replay whose stream was refused up after the newest row it folded", async () => {
    const { entry, openings, positions, settle } = scriptedEntry(
      [baseStateAt(5), afterRow(6), afterRow(8)],
      0,
    );
    entry.refreshScheduler.request("subscribe");
    await settle();
    entry.store.applyBatch([6, 8, 9, 10].map(eventAt));
    entry.refreshScheduler.request("gap-repull");
    await settle();
    // The replay folds the hole and a row past it, then the stream refuses where it opened.
    entry.store.applyBatch([7, 8].map(eventAt));
    entry.refuseStreamCursor(eventAt(6).cursor as EventCursor);
    await settle();
    expect(entry.store.snapshot().isReplaying).toBe(true);

    // The stream after row 8 sends only what the replay still lacks.
    entry.store.applyBatch([9, 10].map(eventAt));

    expect(openings.slice(1)).toMatchObject([
      { opensAt: "repair", reopening: { from: "row", rowCursor: "cursor-at-6" } },
      { opensAt: "repair", reopening: { from: "row", rowCursor: "cursor-at-8" } },
    ]);
    expect(positions.at(-1)).toStrictEqual({
      afterCursor: "cursor-at-8",
      afterSequence: undefined,
    });
    expect(entry.store.snapshot()).toMatchObject({ degradedCause: undefined, isReplaying: false });
    expect(entry.store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([
      6, 7, 8, 9, 10,
    ]);

    entry.dispose();
  });

  it("asks for no repair read for a row that fails again each time it is sent", async () => {
    const clock = new ManualClock(0);
    const entry = new OpenSessionEntry("session-1", {
      read: () => Promise.resolve(baseStateAt(5)),
      clock,
      openingPageLimit,
      offScreenRowLimit,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
      projectors: {
        "run.starting": (event) => {
          if (event.sequence === 7) {
            throw new TypeError("the payload was not the shape this projector claims");
          }
          return [];
        },
      },
    });
    async function settle(): Promise<void> {
      clock.advance(21);
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
    }
    entry.refreshScheduler.request("subscribe");
    await settle();

    // Through the drain, which is where a batch's outcome asks for a repair.
    entry.applyQueue.enqueueAll([eventAt(6), eventAt(7)]);
    entry.applyQueue.flush();
    await settle();

    // The reopened stream would send row 7 again and fail on it again, so no read is asked for.
    expect(entry.store.snapshot().degradedCause).toBe("projection-failed");
    expect(entry.refreshScheduler.performCount).toBe(1);

    entry.dispose();
  });
});
