// The signal fires on what it watches, once, and on nothing else. These cases drive the filter
// directly, with no scheduler, so a re-signal a coalescing window would hide shows as a second
// count.

import { describe, expect, it } from "vitest";

import type { SessionStore } from "./session-store.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { subscribeToSessionEventKinds } from "./session-event-signal.js";
import { initializedStore } from "@test/helpers/session-store-fixtures.js";

/** A subscribed counter over one watched set, plus the store it watches. */
function watchedSignalCount(sessionId: string): {
  readonly sessionStore: SessionStore;
  readonly signalCount: () => number;
  readonly unsubscribe: () => void;
} {
  const sessionStore = initializedStore(sessionId);
  let signals = 0;
  const unsubscribe = subscribeToSessionEventKinds(sessionStore, ["run.queued"], () => {
    signals += 1;
  });
  return { sessionStore, signalCount: () => signals, unsubscribe };
}

describe("the session-event signal", () => {
  it("signals once for a transition that admitted a watched kind", () => {
    const { sessionStore, signalCount, unsubscribe } = watchedSignalCount("signal-watched");

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.queued", 1));

    expect(signalCount()).toBe(1);
    unsubscribe();
  });

  it("signals nothing for a kind it does not watch", () => {
    const { sessionStore, signalCount, unsubscribe } = watchedSignalCount("signal-unwatched");

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "assistant.message", 1));

    expect(signalCount()).toBe(0);
    unsubscribe();
  });

  it("counts what a transition newly admitted, never the timeline behind it", () => {
    // Cursor bookkeeping, which a coalescing scheduler would hide: scanning the whole timeline
    // would signal on the run already in it.
    const sessionStore = initializedStore("signal-newly-admitted");
    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.queued", 1));
    let signals = 0;
    const unsubscribe = subscribeToSessionEventKinds(sessionStore, ["run.queued"], () => {
      signals += 1;
    });

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "assistant.message", 2));
    expect(signals).toBe(0);

    // The next watched kind still signals, so the zero above is not a dead subscription.
    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.queued", 3));
    expect(signals).toBe(1);

    unsubscribe();
  });

  it("signals nothing once unsubscribed", () => {
    const { sessionStore, signalCount, unsubscribe } = watchedSignalCount("signal-released");
    unsubscribe();

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.queued", 1));

    expect(signalCount()).toBe(0);
  });

  it("negative control: the store does deliver the transitions these cases count over", () => {
    // Guards against a store that notified nobody, which would make every case above vacuous.
    const sessionStore = initializedStore("signal-instrument");
    let transitions = 0;
    const unsubscribe = sessionStore.readable.subscribe(() => {
      transitions += 1;
    });

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.queued", 1));
    sessionStore.apply(eventOfKind(sessionStore.sessionId, "assistant.message", 2));

    expect(transitions).toBeGreaterThanOrEqual(2);
    unsubscribe();
  });
});
