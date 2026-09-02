// The degradation ladder, and every writer of `degradedCause` obeying it.
//
// The subject is one rule — the worst standing cause survives — and the reason it
// gets its own file is that the rule has TWO writers. The apply chokepoint raises
// causes it observed in a batch; `markDegraded` raises one the wire reported. A
// test that only drove the first would leave the second free to assign, and an
// assignment on a flag only a re-pull clears reports a repair that never happened.
//
// The ladder cases below derive their expectations from `SESSION_DEGRADED_CAUSES`
// rather than restating the order, so a reordering of that tuple moves the test
// with the rule instead of leaving a green suite behind a changed contract.

import { describe, expect, it } from "vitest";

import { MAX_REPAIRABLE_SEQUENCE_GAP } from "../core/index.js";
import {
  SESSION_DEGRADED_CAUSES,
  worstDegradedCause,
  type SessionDegradedCause,
} from "./degradation.js";
import type { ConsoleSessionEvent } from "./entities.js";
import { SessionStore } from "./session-store.js";

function eventAt(sequence: number): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: "session-1",
    sequence,
    kind: "run.starting",
    occurredAt: "2026-01-01T00:00:00.000Z",
  };
}

/** An initialised store with nothing wrong with it. */
function healthyStore(): SessionStore {
  const store = new SessionStore({ sessionId: "session-1" });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return store;
}

/** A store that could not follow the stream at all: the worst cause there is. */
function divergedStore(): SessionStore {
  const store = healthyStore();
  store.applyBatch([eventAt(MAX_REPAIRABLE_SEQUENCE_GAP + 2)]);
  return store;
}

/** A store missing one named row: a real cause, milder than divergence. */
function gappedStore(): SessionStore {
  const store = healthyStore();
  store.apply(eventAt(2));
  return store;
}

describe("the degradation ladder", () => {
  it("answers nothing when nothing is standing", () => {
    expect(worstDegradedCause()).toBeUndefined();
    expect(worstDegradedCause(undefined, undefined)).toBeUndefined();
  });

  it("keeps the worse of any two causes, whichever order they arrive in", () => {
    for (let worse = 0; worse < SESSION_DEGRADED_CAUSES.length; worse += 1) {
      for (let milder = worse + 1; milder < SESSION_DEGRADED_CAUSES.length; milder += 1) {
        const worseCause: SessionDegradedCause = SESSION_DEGRADED_CAUSES[worse]!;
        const milderCause: SessionDegradedCause = SESSION_DEGRADED_CAUSES[milder]!;
        expect(worstDegradedCause(worseCause, milderCause)).toBe(worseCause);
        expect(worstDegradedCause(milderCause, worseCause)).toBe(worseCause);
      }
    }
  });

  it("ignores absent candidates rather than treating them as a cause", () => {
    expect(worstDegradedCause(undefined, "read-failed", undefined)).toBe("read-failed");
  });
});

describe("an external degradation reaching an already-degraded store", () => {
  it("does not downgrade a diverged store when its repair read rejects", () => {
    // The named downgrade: a store that could not follow the stream at all, whose
    // repair read then fails. Assigning `read-failed` here would replace the worst
    // standing fact with a milder one — on a flag only a COMPLETED re-pull clears,
    // so nothing later would ever put `stream-diverged` back.
    const store = divergedStore();
    expect(store.snapshot().degradedCause).toBe("stream-diverged");

    store.markDegraded("read-failed");

    expect(store.snapshot().degradedCause).toBe("stream-diverged");
  });

  it("does not overwrite a sequence gap with a later subscription closure", () => {
    // The second named downgrade. The rows named in `gaps` are still missing after
    // the subscription closes, and a banner reading `subscription-closed` says the
    // wire stopped — which is true and is not the worse of the two facts.
    const store = gappedStore();
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 1, toSequence: 1 }]);

    store.markDegraded("subscription-closed");

    expect(store.snapshot().degradedCause).toBe("sequence-gap");
  });

  it("commits no transition when the merge changes nothing", () => {
    // Not merely the same value: the same state object. A store that re-committed
    // the cause it already carried would notify every subscriber of a session-wide
    // re-render for a fact that did not change.
    const store = gappedStore();
    const before = store.snapshot();

    store.markDegraded("read-failed");
    store.markDegraded("sequence-gap");

    expect(store.snapshot()).toBe(before);
    expect(store.snapshot().revision).toBe(before.revision);
  });

  it("negative control: an actually-worse cause still replaces a milder one", () => {
    // Without this the cases above would pass over a `markDegraded` that had simply
    // stopped writing anything once a cause was set.
    const store = healthyStore();
    store.markDegraded("read-failed");
    const afterFirst = store.snapshot();
    expect(afterFirst.degradedCause).toBe("read-failed");

    store.markDegraded("stream-diverged");

    expect(store.snapshot().degradedCause).toBe("stream-diverged");
    expect(store.snapshot().revision).toBe(afterFirst.revision + 1);
  });

  it("negative control: a healthy store takes the cause it is handed", () => {
    const store = healthyStore();

    store.markDegraded("subscription-closed");

    expect(store.snapshot().degradedCause).toBe("subscription-closed");
  });

  it("negative control: a completed re-pull still clears the surviving cause", () => {
    // The merge must not make the flag unclearable. A re-pull is the one thing that
    // clears it, and it clears whatever survived the ladder rather than only the
    // cause the last writer supplied.
    const store = gappedStore();
    store.markDegraded("subscription-closed");

    store.initialise({
      cursor: 2,
      entities: [],
      participantJoinLog: [],
      timeline: [eventAt(1), eventAt(2)],
    });

    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(store.snapshot().gaps).toStrictEqual([]);
  });
});
