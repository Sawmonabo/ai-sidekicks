// Where a pin lives, and what happens when it cannot be written. It runs against the real
// `UiStateStore` over the memory adapter, since a fake would not prove a pin survives the
// value-class chokepoint.

import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "#renderer/store/persistence/memory-adapter.js";
import { PERSISTENCE_GLOBAL_PARTITION } from "#renderer/store/persistence/adapter.js";
import {
  openStore,
  openStoreOver,
} from "#renderer/store/persistence/ui-state-store.test-support.js";
import { PINNED_SESSIONS_KEY, SessionPinStore, narrowSessionPins } from "./pins.js";

describe("pins in the durable store", () => {
  it("writes a pin through the chokepoint, under the global partition", async () => {
    const store = openStore();
    const pins = new SessionPinStore(store);
    await pins.setPinned("session-a", true);

    expect(pins.pinned).toStrictEqual({ "session-a": "pinned" });
    const record = await store.read(PERSISTENCE_GLOBAL_PARTITION, PINNED_SESSIONS_KEY);
    expect(record?.valueClass).toBe("pin");
    expect(record?.value).toStrictEqual({ "session-a": "pinned" });
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
    expect(second.pinned).toStrictEqual({ "session-a": "pinned" });
  });
});

describe("a write the store will not take", () => {
  it("records the refusal rather than reporting a pin that did not land", async () => {
    // A one-byte adapter ceiling gives the full-disk refusal (`quota-exceeded`), not a caller
    // fault: a pin is a legitimate value.
    const pins = new SessionPinStore(openStore({ capacityBytes: 1 }));
    await pins.setPinned("session-a", true);
    expect(pins.lastRefusal?.code).toBe("quota-exceeded");
    expect(pins.lastRefusal?.origin).toBe("persistence");
  });
});

describe("reading a record this build did not write", () => {
  it("keeps the entries it recognizes, and refuses a record that is not a map at all", () => {
    expect(narrowSessionPins({ "session-a": "pinned", "session-b": "middle" })).toStrictEqual({
      "session-a": "pinned",
    });
    expect(narrowSessionPins(["session-a"])).toBeUndefined();
    expect(narrowSessionPins("pinned")).toBeUndefined();
  });
});
