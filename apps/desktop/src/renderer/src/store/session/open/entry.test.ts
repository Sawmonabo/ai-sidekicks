// Where a read opens the window, and when that moves the stream: a read the store takes names the
// position the stream opens after, a read a live window is already past moves nothing, and a
// window that could not follow the stream is read at the newest position instead.

import { encodeEventCursor } from "@ai-sidekicks/contracts/session/id";
import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import type { SessionBaseState } from "../state.js";
import {
  OpenSessionEntry,
  type SessionStreamPosition,
  type SessionWindowOpening,
} from "./entry.js";

/** An empty base state at one position, the stream opening after it. */
function baseStateAt(position: number): SessionBaseState {
  return { cursor: position, entities: [], streamAfterCursor: encodeEventCursor(position) };
}

describe("OpenSessionEntry — the read places the window and the stream follows it", () => {
  it("moves the stream only on a read the store takes, and snapshots once it cannot follow", async () => {
    const clock = new ManualClock(0);
    const script = [baseStateAt(5), baseStateAt(3), baseStateAt(9)];
    const openings: SessionWindowOpening[] = [];
    const entry = new OpenSessionEntry("session-1", {
      read: (_sessionId, _reasons, opening) => {
        openings.push(opening);
        return Promise.resolve(script[openings.length - 1]);
      },
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });
    const positions: SessionStreamPosition[] = [];
    entry.subscribeToStreamPosition((position) => positions.push(position));
    async function refresh(): Promise<void> {
      entry.refreshScheduler.request("window-focus");
      clock.advance(21);
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
    }

    await refresh();
    // A live window already past this read's position keeps its stream.
    await refresh();
    // The stream dropped a hole too wide to fill.
    entry.skipPastStream();
    await refresh();

    expect(openings).toStrictEqual([
      { opensAt: "resume", refusedCursor: undefined },
      { opensAt: "resume", refusedCursor: undefined },
      { opensAt: "latest" },
    ]);
    expect(positions).toStrictEqual([
      { afterCursor: encodeEventCursor(5), afterSequence: 5 },
      { afterCursor: encodeEventCursor(9), afterSequence: 9 },
    ]);
    expect(entry.streamPosition).toStrictEqual(positions[1]);
    // The snapshot kept the window's place and the stretch it skipped as a gap.
    expect(entry.store.snapshot().gaps).toStrictEqual([{ fromSequence: 6, toSequence: 9 }]);
    expect(entry.store.snapshot().degradedCause).toBeUndefined();

    entry.dispose();
  });
});
