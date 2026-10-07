// When a read moves the stream: a read the store takes names the position the stream opens after,
// a read a whole live window gets moves nothing, and a window that lost its stream stays degraded
// until the one repair read it asks for resets it. What the replaced stream left queued never
// reaches the reset store.

import { encodeEventCursor } from "@ai-sidekicks/contracts/session/id";
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
  it("re-reads a lost stream once, and stays degraded until that read resets the store", async () => {
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
    // A row the old stream still hands over proves nothing about the rows that never arrived.
    entry.store.applyBatch([eventAt(8)]);
    await settle();
    // The repair read is in flight: the window keeps its rows and still says it is behind.
    expect(entry.refreshScheduler.performCount).toBe(3);
    expect(sequences()).toStrictEqual([6, 7, 8]);
    expect(entry.store.snapshot().degradedCause).toBe("stream-diverged");

    // The read resets the store, and the stream opened after its position sends the rows again.
    landRepair(baseStateAt(2));
    await settle();
    expect(entry.store.snapshot().degradedCause).toBeUndefined();
    expect(sequences()).toStrictEqual([]);
    entry.store.applyBatch([3, 4, 5, 6, 7, 8, 9, 10].map(eventAt));
    expect(sequences()).toStrictEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(entry.store.snapshot().gaps).toStrictEqual([]);
    expect(entry.store.snapshot().degradedCause).toBeUndefined();

    // One read for the whole burst, and the reset asks for no further one.
    await settle();
    expect(entry.refreshScheduler.performCount).toBe(3);
    expect(openings).toStrictEqual([
      { refusedCursor: undefined },
      { refusedCursor: undefined },
      { refusedCursor: undefined },
    ]);
    expect(positions).toStrictEqual([
      { afterCursor: encodeEventCursor(5), afterSequence: undefined },
      { afterCursor: encodeEventCursor(2), afterSequence: undefined },
    ]);

    entry.dispose();
  });

  it("drops what the replaced stream left queued, so the rows sent again are all admitted", async () => {
    const coalesceMs = 50;
    const { entry, clock, settle } = scriptedEntry([baseStateAt(5), baseStateAt(2)], coalesceMs);
    entry.refreshScheduler.request("subscribe");
    await settle();
    entry.store.applyBatch([eventAt(6), eventAt(8)]);
    expect(entry.store.snapshot().degradedCause).toBe("sequence-gap");

    // The old stream's row is still queued when the repair read lands.
    entry.applyQueue.enqueue(eventAt(50));
    entry.refreshScheduler.request("gap-repull");
    await settle();
    clock.advance(coalesceMs);
    // The stream opened after the repair's position sends the rows again.
    entry.applyQueue.enqueueAll([eventAt(3), eventAt(4)]);
    entry.applyQueue.flush();

    // A stale row drained first would place the run at 50 and refuse these as duplicates.
    expect(entry.store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([3, 4]);
    expect(entry.store.snapshot().gaps).toStrictEqual([]);
    expect(entry.store.snapshot().degradedCause).toBeUndefined();

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
