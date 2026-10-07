// When a read moves the stream: a read the store takes names the position the stream opens after,
// a read a whole live window gets moves nothing, and a repair names the last row the window holds
// whole. A window that lost only its stream is taken up after its newest row with nothing
// replayed; one with a hole replays from the row before it, and what the replaced stream left
// queued never reaches the replay. A replay that loses its stream goes on after the newest row it
// folded.

import { encodeEventCursor, type EventCursor } from "@ai-sidekicks/contracts/session/id";
import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { eventOfKind } from "#test/helpers/session/events.js";
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
  it("re-reads a lost stream once and takes the window up after its newest row", async () => {
    let landRepair: (baseState: SessionBaseState) => void = () => undefined;
    const repair = new Promise<SessionBaseState>((resolve) => {
      landRepair = resolve;
    });
    const { entry, openings, positions, settle } = scriptedEntry(
      [baseStateAt(5), baseStateAt(5), repair],
      0,
    );
    const sequences = (): number[] =>
      entry.store.snapshot().transcript.map((event) => event.sequence);

    entry.refreshScheduler.request("subscribe");
    await settle();
    // The first event after the read's position places the run, opening no gap.
    entry.store.applyBatch([eventAt(6), eventAt(7)]);
    // A whole live window keeps its stream.
    entry.refreshScheduler.request("window-focus");
    await settle();
    expect(sequences()).toStrictEqual([6, 7]);

    // A burst of holes too wide to fill, with no focus and no press.
    entry.loseStream();
    entry.loseStream();
    entry.loseStream();
    // A row the old stream still hands over joins the window, which still holds every row whole.
    entry.store.applyBatch([eventAt(8)]);
    await settle();
    // The repair read is in flight: the window keeps its rows and still says it is behind.
    expect(entry.refreshScheduler.performCount).toBe(3);
    expect(entry.store.snapshot().degradedCause).toBe("stream-diverged");
    const held = entry.store.snapshot().transcript;

    // The read answers after the row the repair named, so nothing is replayed.
    landRepair({ entities: [], streamAfterCursor: "cursor-at-8" as EventCursor });
    await settle();
    expect(entry.store.snapshot()).toMatchObject({ degradedCause: undefined, isReplaying: false });
    expect(entry.store.snapshot().transcript).toBe(held);
    // The stream after it sends what follows; a row it sends again is refused as a duplicate.
    entry.store.applyBatch([8, 9].map(eventAt));
    expect(sequences()).toStrictEqual([6, 7, 8, 9]);

    // One read for the whole burst, and the repair asks for no further one.
    await settle();
    expect(entry.refreshScheduler.performCount).toBe(3);
    expect(openings).toStrictEqual([
      { opensAt: "resume", refusedCursor: undefined },
      {
        opensAt: "repair",
        resumeAfterRowCursor: "cursor-at-7",
        headCursor: undefined,
        refusedCursor: undefined,
      },
      {
        opensAt: "repair",
        resumeAfterRowCursor: "cursor-at-8",
        headCursor: undefined,
        refusedCursor: undefined,
      },
    ]);
    expect(positions).toStrictEqual([
      { afterCursor: encodeEventCursor(5), afterSequence: undefined },
      { afterCursor: "cursor-at-8", afterSequence: undefined },
    ]);

    entry.dispose();
  });

  it("repairs a hole from the row before it, dropping what the replaced stream left queued", async () => {
    const coalesceMs = 50;
    const afterRowSix: SessionBaseState = {
      entities: [],
      streamAfterCursor: "cursor-at-6" as EventCursor,
    };
    const { entry, clock, openings, settle } = scriptedEntry(
      [baseStateAt(5), afterRowSix],
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
    expect(openings[1]).toMatchObject({ opensAt: "repair", resumeAfterRowCursor: "cursor-at-6" });
    expect(entry.store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([
      6, 7, 8,
    ]);
    expect(entry.store.snapshot().gaps).toStrictEqual([]);
    expect(entry.store.snapshot().degradedCause).toBeUndefined();

    entry.dispose();
  });

  it("takes a replay that lost its stream up after the newest row it folded", async () => {
    const afterRow = (sequence: number): SessionBaseState => ({
      entities: [],
      streamAfterCursor: eventAt(sequence).cursor as EventCursor,
    });
    const { entry, openings, positions, settle } = scriptedEntry(
      [baseStateAt(5), afterRow(6), afterRow(8)],
      0,
    );
    entry.refreshScheduler.request("subscribe");
    await settle();
    entry.store.applyBatch([6, 8, 9, 10].map(eventAt));
    entry.refreshScheduler.request("gap-repull");
    await settle();
    // The replay folds the hole and a row past it, then its stream drops a hole too wide to fill.
    entry.store.applyBatch([7, 8].map(eventAt));
    entry.loseStream();
    await settle();
    expect(entry.store.snapshot().isReplaying).toBe(true);

    // The stream after row 8 sends only what the replay still lacks.
    entry.store.applyBatch([9, 10].map(eventAt));

    expect(openings.slice(1)).toMatchObject([
      { opensAt: "repair", resumeAfterRowCursor: "cursor-at-6" },
      { opensAt: "repair", resumeAfterRowCursor: "cursor-at-8" },
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

  it("asks for no repair read for a row that fails again on every replay", async () => {
    const clock = new ManualClock(0);
    const entry = new OpenSessionEntry("session-1", {
      read: () => Promise.resolve(baseStateAt(5)),
      clock,
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

    // A reset would replay row 7 and fail on it again, so no read is asked for.
    expect(entry.store.snapshot().degradedCause).toBe("projection-failed");
    expect(entry.refreshScheduler.performCount).toBe(1);

    entry.dispose();
  });
});
