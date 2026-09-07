// The signal every open session shares, and the fold the frame takes over it.
//
// Two properties, and the rebinding one is why this is a class rather than a closure:
// a session opened after the signal started has to be bound, or the window goes quiet
// for exactly the sessions a person just opened.

import { describe, expect, it } from "vitest";

import { SessionStoreRegistry } from "./session-store-registry.js";
import { subscribeToOpenSessions, worstOpenSessionRecovery } from "./open-session-signal.js";

function emptyRegistry(): SessionStoreRegistry {
  return new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
}

describe("subscribeToOpenSessions", () => {
  it("fires when a session opens", () => {
    const registry = emptyRegistry();
    let changes = 0;
    const release = subscribeToOpenSessions(registry, () => {
      changes += 1;
    });
    registry.open("session-a");
    expect(changes).toBeGreaterThan(0);
    release();
  });

  it("binds a session opened AFTER it started", () => {
    // The rebinding rule. A signal that bound once would answer the registry's own
    // open event and then go silent for that session's projection forever.
    const registry = emptyRegistry();
    const store = registry.open("session-a");
    let changes = 0;
    const release = subscribeToOpenSessions(registry, () => {
      changes += 1;
    });
    const laterStore = registry.open("session-b");
    const afterOpen = changes;
    laterStore.readable.subscribe(() => undefined);
    store.markDegraded("sequence-gap");
    laterStore.markDegraded("sequence-gap");
    expect(changes).toBeGreaterThan(afterOpen);
    release();
  });

  it("stops firing once released — the control", () => {
    const registry = emptyRegistry();
    const release = subscribeToOpenSessions(registry, () => {
      throw new Error("a released signal fired");
    });
    release();
    const store = registry.open("session-a");
    store.markDegraded("sequence-gap");
  });
});

describe("worstOpenSessionRecovery", () => {
  it("answers undefined for a window holding nothing", () => {
    // Not "nothing was checked": the stores this reads are the ones the window holds,
    // so an empty window has a real answer and it is "nothing is recovering".
    expect(worstOpenSessionRecovery(emptyRegistry())).toBeUndefined();
  });

  it("answers undefined while every open store is whole — the control", () => {
    const registry = emptyRegistry();
    registry.open("session-a");
    registry.open("session-b");
    expect(worstOpenSessionRecovery(registry)).toBeUndefined();
  });

  it("answers the cause a store is carrying", () => {
    const registry = emptyRegistry();
    registry.open("session-a");
    registry.open("session-b").markDegraded("sequence-gap");
    expect(worstOpenSessionRecovery(registry)).toBe("sequence-gap");
  });
});
