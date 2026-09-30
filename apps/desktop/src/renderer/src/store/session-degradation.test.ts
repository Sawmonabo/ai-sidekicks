// The degradation ladder, and every writer of `degradedCause` obeying it: the worst standing
// cause survives. The rule has two writers, the apply chokepoint (causes observed in a batch)
// and `markDegraded` (a cause the wire reported), and an assignment by the second would report
// a repair that never happened. Expectations derive from `SESSION_DEGRADED_CAUSES`, so
// reordering that tuple moves the test with the rule.

import { describe, expect, it } from "vitest";

import { MAX_REPAIRABLE_SEQUENCE_GAP } from "./session/session-store-caps.js";
import {
  SESSION_DEGRADED_CAUSES,
  worstDegradedCause,
  type SessionDegradedCause,
} from "./session-degradation.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { SessionStore } from "./session/session-store.js";

/** An initialized store with nothing wrong with it. */
function healthyStore(): SessionStore {
  const store = new SessionStore({ sessionId: "session-1" });
  store.initialize({ cursor: 0, entities: [] });
  return store;
}

/** A store that could not follow the stream at all: the worst cause there is. */
function divergedStore(): SessionStore {
  const store = healthyStore();
  store.applyBatch([eventOfKind("session-1", "run.starting", MAX_REPAIRABLE_SEQUENCE_GAP + 2)]);
  return store;
}

/** A store missing one named row: a real cause, milder than divergence. */
function gappedStore(): SessionStore {
  const store = healthyStore();
  store.apply(eventOfKind("session-1", "run.starting", 2));
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
    // A store that could not follow the stream at all, whose repair read then fails. Assigning
    // `read-failed` would replace the worst standing fact with a milder one, and only a
    // completed re-pull clears the flag, so nothing would put `stream-diverged` back.
    const store = divergedStore();
    expect(store.snapshot().degradedCause).toBe("stream-diverged");

    store.markReadFailed();

    expect(store.snapshot().degradedCause).toBe("stream-diverged");
  });

  it("does not overwrite a sequence gap with a later subscription closure", () => {
    // The rows named in `gaps` are still missing after the subscription closes, and a
    // `subscription-closed` banner says the wire stopped, which is not the worse fact.
    const store = gappedStore();
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 1, toSequence: 1 }]);

    store.markDegraded("subscription-closed");

    expect(store.snapshot().degradedCause).toBe("sequence-gap");
  });

  it("commits no transition when the merge changes nothing", () => {
    // The same state object, not merely the same value: re-committing the standing cause would
    // notify every subscriber for a fact that did not change.
    const store = gappedStore();
    const before = store.snapshot();

    store.markDegraded("subscription-closed");
    store.markDegraded("sequence-gap");

    expect(store.snapshot()).toBe(before);
    expect(store.snapshot().revision).toBe(before.revision);
  });

  it("negative control: an actually-worse cause still replaces a milder one", () => {
    // Guards against a `markDegraded` that stopped writing once a cause was set.
    const store = healthyStore();
    store.markReadFailed();
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
    // The merge must not make the flag unclearable: a re-pull clears whatever survived the
    // ladder, not only the last writer's cause.
    const store = gappedStore();
    store.markDegraded("subscription-closed");

    store.initialize({
      cursor: 2,
      entities: [],
      timeline: [
        eventOfKind("session-1", "run.starting", 1),
        eventOfKind("session-1", "run.starting", 2),
      ],
    });

    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(store.snapshot().gaps).toStrictEqual([]);
  });
});
