// One open session's three parts, driven directly.
//
// Almost everything an entry does is reached through `SessionStoreRegistry` and is
// asserted there, against the real registry — the repair loop the drain closes
// included. What is asserted HERE is the one claim the registry test structurally
// cannot make: that `dispose()` is terminal on BOTH children. `registry.close()`
// disposes an entry and then forgets it, so there is no handle left to ask whether
// a later delivery or a later refresh request re-arms a timer behind the pane that
// went away — and "a timer that outlives its pane" is the failure this binding
// exists to make unrepresentable.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";
import { OpenSessionEntry } from "./open-session-entry.js";

function eventAt(sequence: number): ConsoleSessionEvent {
  return {
    sessionId: "session-1",
    sequence,
    kind: "run.starting",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
  };
}

/** A reader that establishes nothing, so no read can clear what a test set up. */
const readsNothing = (): Promise<undefined> => Promise.resolve(undefined);

describe("OpenSessionEntry — dispose is terminal on both children", () => {
  it("arms nothing for a delivery or a refresh asked for after dispose", () => {
    const clock = new ManualClock(0);
    const entry = new OpenSessionEntry("session-1", {
      read: readsNothing,
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });

    entry.dispose();
    entry.applyQueue.enqueueAll([eventAt(1), eventAt(2)]);
    entry.refreshScheduler.request("window-focus");

    // Neither child re-arms, and the dropped delivery is counted rather than
    // silently ignored: a subscription still feeding a closed session is a leak
    // one layer up, and the count is how it becomes visible.
    expect(clock.pendingCount).toBe(0);
    expect(entry.applyQueue.droppedAfterDisposeCount).toBe(2);
    expect(entry.refreshScheduler.isArmed).toBe(false);
    expect(entry.refreshScheduler.pendingReasons).toStrictEqual([]);
  });

  it("negative control: the same two calls before dispose DO arm both children", () => {
    // Without this, an entry whose queue and scheduler had stopped arming at all
    // would pass the case above by doing nothing in either state.
    const clock = new ManualClock(0);
    const entry = new OpenSessionEntry("session-1", {
      read: readsNothing,
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });

    entry.applyQueue.enqueueAll([eventAt(1), eventAt(2)]);
    entry.refreshScheduler.request("window-focus");

    // One frame for the queue, one timeout for the scheduler.
    expect(clock.pendingFrameCount).toBe(1);
    expect(clock.pendingCount).toBe(2);
    expect(entry.applyQueue.droppedAfterDisposeCount).toBe(0);
    expect(entry.refreshScheduler.isArmed).toBe(true);

    entry.dispose();
    expect(clock.pendingCount).toBe(0);
  });
});
