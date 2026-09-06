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
import { eventOfKind } from "./session-event.test-support.js";
import { OpenSessionEntry } from "./open-session-entry.js";
import type { SessionSnapshot } from "./session-store.js";

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
    entry.applyQueue.enqueueAll([
      eventOfKind("session-1", "run.starting", 1),
      eventOfKind("session-1", "run.starting", 2),
    ]);
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

    entry.applyQueue.enqueueAll([
      eventOfKind("session-1", "run.starting", 1),
      eventOfKind("session-1", "run.starting", 2),
    ]);
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

describe("OpenSessionEntry — the resume rule runs on every completed read", () => {
  /**
   * One entry whose successive reads answer with the snapshots supplied, in order.
   *
   * A queue rather than one snapshot, because every case here is about the SECOND
   * read: the rule only has something to decide once a projection exists for it to
   * keep or throw away, so each case establishes one and then reconnects.
   */
  function entryReadingInTurn(
    clock: ManualClock,
    snapshots: readonly SessionSnapshot[],
  ): OpenSessionEntry {
    let readIndex = 0;
    return new OpenSessionEntry("session-1", {
      read: () => {
        const snapshot = snapshots[Math.min(readIndex, snapshots.length - 1)];
        readIndex += 1;
        return Promise.resolve(snapshot);
      },
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });
  }

  /** Ask for a refresh and let the scheduler's deadline and its promise settle. */
  async function refresh(clock: ManualClock, entry: OpenSessionEntry): Promise<void> {
    entry.refreshScheduler.request("window-focus");
    clock.advance(21);
    await Promise.resolve();
    await Promise.resolve();
  }

  /** A projection seven rows deep, whose cursors are in order. */
  const ESTABLISHED: SessionSnapshot = {
    cursor: 7,
    entities: [],
    participantJoinLog: [],
    timelineCursors: {
      earliest: "0_1723291400000000000",
      latest: "7_1723291480000000000",
      acknowledged: "7_1723291480000000000",
    },
  };

  it("leaves the established projection standing when a reconnect reads a lower cursor", async () => {
    // The retired lost-event arm, end to end. The reconnecting read is positioned at
    // the floor and carries an acknowledged cursor a leading-integer scan would have
    // ranked below it — so the entry used to throw a live projection away here. It
    // no longer does: no ordering over an opaque cursor is published, and
    // `admitsSnapshotAt` correctly refuses the floor snapshot for arriving behind the
    // cursor the store already holds.
    const clock = new ManualClock(0);
    const entry = entryReadingInTurn(clock, [
      ESTABLISHED,
      {
        cursor: 0,
        entities: [],
        participantJoinLog: [],
        timelineCursors: {
          earliest: "0_1723291400000000000",
          latest: "9_1723291500000000000",
          acknowledged: "-4_1723200000000000000",
        },
      },
    ]);

    await refresh(clock, entry);
    expect(entry.store.snapshot().cursor).toBe(7);
    await refresh(clock, entry);

    expect(entry.timelineResume?.outcome).toBe("resume");
    expect(entry.store.snapshot().cursor).toBe(7);
  });

  it("negative control: an ordered pair leaves the established projection standing", async () => {
    // Without this the case above would pass over an entry that recorded nothing at
    // all, since "no reset happened" is satisfied by an entry that never decides.
    const clock = new ManualClock(0);
    const entry = entryReadingInTurn(clock, [
      ESTABLISHED,
      {
        cursor: 0,
        entities: [],
        participantJoinLog: [],
        timelineCursors: {
          earliest: "0_1723291400000000000",
          latest: "9_1723291500000000000",
          acknowledged: "7_1723291480000000000",
        },
      },
    ]);

    await refresh(clock, entry);
    await refresh(clock, entry);

    expect(entry.timelineResume?.outcome).toBe("resume");
    expect(entry.store.snapshot().cursor).toBe(7);
  });

  it("refuses the cycle without resetting anything when the read carries no floor", async () => {
    // The version-skew arm. The refusal is recorded and the projection is untouched:
    // an older responder is a standing state, not an incident, and a console that
    // reset on it would rebuild the same projection on every read forever.
    const clock = new ManualClock(0);
    const entry = entryReadingInTurn(clock, [
      ESTABLISHED,
      {
        cursor: 0,
        entities: [],
        participantJoinLog: [],
        timelineCursors: { latest: "9_1723291500000000000" },
      },
    ]);

    await refresh(clock, entry);
    await refresh(clock, entry);

    expect(entry.timelineResume?.outcome).toBe("refused");
    expect(entry.store.snapshot().cursor).toBe(7);
  });
});
