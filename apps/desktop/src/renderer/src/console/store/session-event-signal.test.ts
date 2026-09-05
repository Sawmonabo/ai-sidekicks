// The signal fires on what it watches, once, and on nothing else.
//
// Both callers of this filter used to own a copy of it, and both tested it only
// through a read they had already bound to a bridge and a scheduler — so the
// property under test was two layers away from the code that decides it, and the
// two copies were free to disagree about the cursor bookkeeping that is the whole
// difference between "once" and "on every transition".
//
// These cases drive the filter directly. The scheduler is not involved, so a
// re-signal that a coalescing window would have hidden is visible here as a second
// count.

import { describe, expect, it } from "vitest";

import { SessionStore, type ConsoleSessionEvent } from "./index.js";
import { subscribeToSessionEventKinds } from "./session-event-signal.js";
import { initialisedStore } from "./session-store-registry.test-support.js";

/** One admitted event of the given kind, numbered so the cursor moves. */
function eventOfKind(
  sessionStore: SessionStore,
  kind: ConsoleSessionEvent["kind"],
  sequence: number,
): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: sessionStore.sessionId,
    sequence,
    kind,
    occurredAt: "2026-01-01T10:06:00.000Z",
    payload: {},
  };
}

/** A subscribed counter over one watched set, plus the store it watches. */
function watchedSignalCount(sessionId: string): {
  readonly sessionStore: SessionStore;
  readonly signalCount: () => number;
  readonly unsubscribe: () => void;
} {
  const sessionStore = initialisedStore(sessionId);
  let signals = 0;
  const unsubscribe = subscribeToSessionEventKinds(sessionStore, ["run.queued"], () => {
    signals += 1;
  });
  return { sessionStore, signalCount: () => signals, unsubscribe };
}

describe("the session-event signal", () => {
  it("signals once for a transition that admitted a watched kind", () => {
    const { sessionStore, signalCount, unsubscribe } = watchedSignalCount("signal-watched");

    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));

    expect(signalCount()).toBe(1);
    unsubscribe();
  });

  it("signals nothing for a kind it does not watch", () => {
    const { sessionStore, signalCount, unsubscribe } = watchedSignalCount("signal-unwatched");

    sessionStore.apply(eventOfKind(sessionStore, "assistant.message", 1));

    expect(signalCount()).toBe(0);
    unsubscribe();
  });

  it("counts what a transition newly admitted, never the timeline behind it", () => {
    // The cursor bookkeeping, which is the half a coalescing scheduler would hide.
    // A filter that scanned the whole timeline rather than the slice this
    // transition admitted would signal on the run already sitting in it, on a
    // transition that carried nothing the caller watches.
    const sessionStore = initialisedStore("signal-newly-admitted");
    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));
    let signals = 0;
    const unsubscribe = subscribeToSessionEventKinds(sessionStore, ["run.queued"], () => {
      signals += 1;
    });

    sessionStore.apply(eventOfKind(sessionStore, "assistant.message", 2));
    expect(signals).toBe(0);

    // And the next watched one still signals, so the zero above is the filter
    // being right rather than a subscription that never fires.
    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 3));
    expect(signals).toBe(1);

    unsubscribe();
  });

  it("signals nothing once unsubscribed", () => {
    const { sessionStore, signalCount, unsubscribe } = watchedSignalCount("signal-released");
    unsubscribe();

    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));

    expect(signalCount()).toBe(0);
  });

  it("negative control: the store does deliver the transitions these cases count over", () => {
    // Without this, every clean result above would also hold for a store that
    // notified nobody — which is the one way this whole file could be vacuous.
    const sessionStore = initialisedStore("signal-instrument");
    let transitions = 0;
    const unsubscribe = sessionStore.readable.subscribe(() => {
      transitions += 1;
    });

    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));
    sessionStore.apply(eventOfKind(sessionStore, "assistant.message", 2));

    expect(transitions).toBeGreaterThanOrEqual(2);
    unsubscribe();
  });
});
