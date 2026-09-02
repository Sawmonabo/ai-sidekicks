// Where a pin lives, and what happens when it cannot be written.
//
// Driven against the real `UiStateStore` over the memory adapter rather than a
// stand-in, because the property under test is that a pin survives the value-class
// chokepoint — a fake store would prove only that this module can call a method.

import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import { PERSISTENCE_GLOBAL_PARTITION, UiStateStore } from "../persistence/index.js";
import { SESSION_PIN_TIERS_KEY, SessionPinStore, narrowSessionPinMap } from "./session-pins.js";

function openStore(options: { readonly capacityBytes?: number } = {}): UiStateStore {
  return new UiStateStore({
    adapter: new MemoryPersistenceAdapter(
      options.capacityBytes === undefined ? {} : { capacityBytes: options.capacityBytes },
    ),
  });
}

describe("pins in the durable store", () => {
  it("writes a front pin through the chokepoint, under the global partition", async () => {
    const store = openStore();
    const pins = new SessionPinStore(store);
    await pins.setTier("session-a", "front");

    expect(pins.tiers).toStrictEqual({ "session-a": "front" });
    const record = await store.read(PERSISTENCE_GLOBAL_PARTITION, SESSION_PIN_TIERS_KEY);
    expect(record?.valueClass).toBe("pin");
    expect(record?.value).toStrictEqual({ "session-a": "front" });
  });

  it("records only the exceptions: moving to the back tier removes the entry", async () => {
    const store = openStore();
    const pins = new SessionPinStore(store);
    await pins.setTier("session-a", "front");
    await pins.setTier("session-a", "back");

    expect(pins.tiers).toStrictEqual({});
    const record = await store.read(PERSISTENCE_GLOBAL_PARTITION, SESSION_PIN_TIERS_KEY);
    expect(record?.value).toStrictEqual({});
  });

  it("reads its own writes back on a second store over the same adapter", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const first = new SessionPinStore(new UiStateStore({ adapter }));
    await first.setTier("session-a", "front");

    const second = new SessionPinStore(new UiStateStore({ adapter }));
    expect(second.tiers).toStrictEqual({});
    await second.hydrate();
    expect(second.tiers).toStrictEqual({ "session-a": "front" });
  });

  it("hydrates once, so a remount cannot overwrite a change made since", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const pins = new SessionPinStore(new UiStateStore({ adapter }));
    await pins.hydrate();
    await pins.setTier("session-a", "front");
    await pins.hydrate();
    expect(pins.tiers).toStrictEqual({ "session-a": "front" });
  });

  it("notifies a subscriber when the map changes", async () => {
    const pins = new SessionPinStore(openStore());
    let notifications = 0;
    const unsubscribe = pins.subscribe(() => {
      notifications += 1;
    });
    await pins.setTier("session-a", "front");
    unsubscribe();
    await pins.setTier("session-b", "front");
    expect(notifications).toBe(1);
  });
});

describe("a write the store will not take", () => {
  it("records the refusal rather than reporting a pin that did not land", async () => {
    // A one-byte ceiling on the ADAPTER, so the refusal is the full-disk arm
    // (`quota-exceeded`) rather than the caller-fault arm — a pin is a legitimate
    // value, and the failure being exercised is the store's, not the caller's.
    const pins = new SessionPinStore(openStore({ capacityBytes: 1 }));
    await pins.setTier("session-a", "front");
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
  it("keeps the entries it recognises and drops the ones it does not", () => {
    expect(narrowSessionPinMap({ "session-a": "front", "session-b": "middle" })).toStrictEqual({
      "session-a": "front",
    });
  });

  it("refuses a record that is not a map at all", () => {
    expect(narrowSessionPinMap(["session-a"])).toBeUndefined();
    expect(narrowSessionPinMap("front")).toBeUndefined();
  });
});
