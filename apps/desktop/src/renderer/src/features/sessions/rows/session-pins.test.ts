// Where a pin lives, and what happens when it cannot be written.
//
// Driven against the real `UiStateStore` over the memory adapter rather than a
// stand-in, because the property under test is that a pin survives the value-class
// chokepoint — a fake store would prove only that this module can call a method.

import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "@renderer/store/persistence/memory-persistence-adapter.js";
import { PERSISTENCE_GLOBAL_PARTITION } from "@renderer/store/persistence/persistence-adapter.js";
import { openStore, openStoreOver } from "../sessions.test-support.js";
import { PINNED_SESSIONS_KEY, SessionPinStore, narrowSessionPins } from "./session-pins.js";

describe("pins in the durable store", () => {
  it("writes a pin through the chokepoint, under the global partition", async () => {
    const store = openStore();
    const pins = new SessionPinStore(store);
    await pins.setPinned("session-a", true);

    expect(pins.pinned).toStrictEqual({ "session-a": "front" });
    const record = await store.read(PERSISTENCE_GLOBAL_PARTITION, PINNED_SESSIONS_KEY);
    expect(record?.valueClass).toBe("pin");
    expect(record?.value).toStrictEqual({ "session-a": "front" });
  });

  it("records only pinned sessions: unpinning removes the entry", async () => {
    const store = openStore();
    const pins = new SessionPinStore(store);
    await pins.setPinned("session-a", true);
    await pins.setPinned("session-a", false);

    expect(pins.pinned).toStrictEqual({});
    const record = await store.read(PERSISTENCE_GLOBAL_PARTITION, PINNED_SESSIONS_KEY);
    expect(record?.value).toStrictEqual({});
  });

  it("reads its own writes back on a second store over the same adapter", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const first = new SessionPinStore(openStoreOver(adapter));
    await first.setPinned("session-a", true);

    const second = new SessionPinStore(openStoreOver(adapter));
    expect(second.pinned).toStrictEqual({});
    await second.hydrate();
    expect(second.pinned).toStrictEqual({ "session-a": "front" });
  });

  it("hydrates once, so a remount cannot overwrite a change made since", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const pins = new SessionPinStore(openStoreOver(adapter));
    await pins.hydrate();
    await pins.setPinned("session-a", true);
    await pins.hydrate();
    expect(pins.pinned).toStrictEqual({ "session-a": "front" });
  });

  it("notifies a subscriber when the map changes", async () => {
    const pins = new SessionPinStore(openStore());
    let notifications = 0;
    const unsubscribe = pins.subscribe(() => {
      notifications += 1;
    });
    await pins.setPinned("session-a", true);
    unsubscribe();
    await pins.setPinned("session-b", true);
    expect(notifications).toBe(1);
  });
});

describe("a write the store will not take", () => {
  it("records the refusal rather than reporting a pin that did not land", async () => {
    // A one-byte ceiling on the ADAPTER, so the refusal is the full-disk arm
    // (`quota-exceeded`) rather than the caller-fault arm — a pin is a legitimate
    // value, and the failure being exercised is the store's, not the caller's.
    const pins = new SessionPinStore(openStore({ capacityBytes: 1 }));
    await pins.setPinned("session-a", true);
    expect(pins.lastRefusal?.code).toBe("quota-exceeded");
    expect(pins.lastRefusal?.origin).toBe("persistence");
  });

  it("negative control: a write that lands records no refusal", () => {
    // Without this, the case above would pass over a store that reported a
    // refusal for every write.
    const pins = new SessionPinStore(openStore());
    expect(pins.lastRefusal).toBeUndefined();
  });
});

describe("reading a record this build did not write", () => {
  it("keeps the entries it recognizes and drops the ones it does not", () => {
    expect(narrowSessionPins({ "session-a": "front", "session-b": "middle" })).toStrictEqual({
      "session-a": "front",
    });
  });

  it("refuses a record that is not a map at all", () => {
    expect(narrowSessionPins(["session-a"])).toBeUndefined();
    expect(narrowSessionPins("front")).toBeUndefined();
  });
});
