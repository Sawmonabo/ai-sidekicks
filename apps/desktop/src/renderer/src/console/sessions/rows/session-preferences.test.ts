// Where the destination's switches live, and what the record does NOT hold.
//
// Driven against the real `UiStateStore` over the memory adapter, for the pin store's
// own reason next door: the property under test is that a switch survives the closed
// value-class chokepoint, and a stand-in store would prove only that this module can
// call a method.
//
// The three claims here are the ones the switch's own component cannot make. It reads
// a binding, so it cannot see which value class the byte landed under, that the
// default writes NOTHING, or what a record written by a build that knew a second
// switch does to this one.

import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "../../persistence/memory-adapter.js";
import { PERSISTENCE_GLOBAL_PARTITION } from "../../persistence/index.js";
import { openStore, openStoreOver } from "../sessions.test-support.js";
import {
  AUTO_PIN_ON_FIRST_SEND,
  AUTO_PIN_ON_FIRST_SEND_DEFAULT,
  SESSION_PREFERENCES_KEY,
  SessionPreferenceStore,
  narrowSessionPreferenceMap,
} from "./session-preferences.js";

describe("the switch in the durable store", () => {
  it("is on for somebody who has never touched it, with no record written", async () => {
    const store = openStore();
    const preferences = new SessionPreferenceStore(store);

    expect(preferences.isAutoPinOnFirstSendEnabled).toBe(AUTO_PIN_ON_FIRST_SEND_DEFAULT);
    expect(await store.read(PERSISTENCE_GLOBAL_PARTITION, SESSION_PREFERENCES_KEY)).toBeUndefined();
  });

  it("writes the off state through the chokepoint, under the preference class", async () => {
    const store = openStore();
    const preferences = new SessionPreferenceStore(store);
    await preferences.setEnabled(AUTO_PIN_ON_FIRST_SEND, false);

    expect(preferences.isAutoPinOnFirstSendEnabled).toBe(false);
    const record = await store.read(PERSISTENCE_GLOBAL_PARTITION, SESSION_PREFERENCES_KEY);
    // The class is the claim: the pin map next door is `pin`, and a switch riding that
    // class would be a second kind of thing inside one record's closed vocabulary.
    expect(record?.valueClass).toBe("preference");
    expect(record?.value).toStrictEqual({ [AUTO_PIN_ON_FIRST_SEND]: false });
  });

  it("records only the exceptions: turning it back on removes the entry", async () => {
    const store = openStore();
    const preferences = new SessionPreferenceStore(store);
    await preferences.setEnabled(AUTO_PIN_ON_FIRST_SEND, false);
    await preferences.setEnabled(AUTO_PIN_ON_FIRST_SEND, true);

    expect(preferences.isAutoPinOnFirstSendEnabled).toBe(true);
    const record = await store.read(PERSISTENCE_GLOBAL_PARTITION, SESSION_PREFERENCES_KEY);
    expect(record?.value).toStrictEqual({});
  });

  it("reads its own write back on a second store over the same adapter", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const first = new SessionPreferenceStore(openStoreOver(adapter));
    await first.setEnabled(AUTO_PIN_ON_FIRST_SEND, false);

    const second = new SessionPreferenceStore(openStoreOver(adapter));
    expect(second.isAutoPinOnFirstSendEnabled).toBe(AUTO_PIN_ON_FIRST_SEND_DEFAULT);
    await second.hydrate();
    expect(second.isAutoPinOnFirstSendEnabled).toBe(false);
  });

  it("notifies a subscriber when the switch changes", async () => {
    const preferences = new SessionPreferenceStore(openStore());
    let notifications = 0;
    const unsubscribe = preferences.subscribe(() => {
      notifications += 1;
    });
    await preferences.setEnabled(AUTO_PIN_ON_FIRST_SEND, false);
    unsubscribe();
    await preferences.setEnabled(AUTO_PIN_ON_FIRST_SEND, true);

    expect(notifications).toBe(1);
  });
});

describe("a switch the store will not take", () => {
  it("records the refusal rather than reporting a decision that did not land", async () => {
    // A one-byte ceiling on the ADAPTER, so this is the full-disk arm and not the
    // caller-fault one: `false` is a legitimate value for this switch.
    const preferences = new SessionPreferenceStore(openStore({ capacityBytes: 1 }));
    await preferences.setEnabled(AUTO_PIN_ON_FIRST_SEND, false);

    expect(preferences.lastRefusal?.code).toBe("quota-exceeded");
    expect(preferences.lastRefusal?.origin).toBe("persistence");
  });

  it("negative control: a write that lands records no refusal", () => {
    // Without this the case above would pass over a store that refused every write.
    expect(new SessionPreferenceStore(openStore()).lastRefusal).toBeUndefined();
  });

  it("re-identifies the snapshot for the refusal, and holds it for everything else", async () => {
    // The half a subscribed surface compares. The switch does not move on a refusal —
    // the state records rather than rolls back — so the refusal is the only thing that
    // makes this snapshot a different object, and it has to.
    const preferences = new SessionPreferenceStore(openStore({ capacityBytes: 1 }));
    const beforeTheWrite = preferences.snapshot;
    expect(preferences.snapshot).toBe(beforeTheWrite);

    await preferences.setEnabled(AUTO_PIN_ON_FIRST_SEND, false);
    const afterTheRefusal = preferences.snapshot;

    expect(afterTheRefusal).not.toBe(beforeTheWrite);
    expect(afterTheRefusal.lastRefusal?.code).toBe("quota-exceeded");
    // Held rather than rebuilt per read: `useSyncExternalStore` calls this getter on
    // every render and compares with `Object.is`, so a record composed afresh each
    // call is a store that reports a change on every render.
    expect(preferences.snapshot).toBe(afterTheRefusal);
  });
});

describe("reading a record this build did not write", () => {
  it("keeps the switches it recognises and drops the ones it does not", () => {
    // Per ENTRY, which is the whole reason the narrowing is not a schema parse: a
    // later build's switch stored as a string must not cost a person the one switch
    // this build has.
    expect(
      narrowSessionPreferenceMap({ [AUTO_PIN_ON_FIRST_SEND]: false, "some-later-switch": "on" }),
    ).toStrictEqual({ [AUTO_PIN_ON_FIRST_SEND]: false });
  });

  it("refuses a record that is not a map at all", () => {
    expect(narrowSessionPreferenceMap([AUTO_PIN_ON_FIRST_SEND])).toBeUndefined();
    expect(narrowSessionPreferenceMap("on")).toBeUndefined();
    expect(narrowSessionPreferenceMap(null)).toBeUndefined();
  });
});
