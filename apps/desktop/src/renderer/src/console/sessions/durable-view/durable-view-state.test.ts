// The one ordering this state has to get right: a durable read that settles after a
// person has already acted.
//
// Both surfaces built on it hydrate from an effect and mutate from a click, and the
// two are not ordered by anything — a person can pin a session or set an invitation
// aside while the first read is still in flight. Installing the record that then
// arrives puts their change back the way it was, with nothing on screen to say why,
// and it stays that way until the next remount.
//
// Driven against the real `UiStateStore` over the memory adapter, and with the read
// genuinely in flight rather than stubbed: the commit lands between `hydrate`'s call
// and its settlement because that is when the defect happens, not because a fake
// was told to wait.
//
// The write cases below need the same window on the OTHER side of the seam — a
// second act while the first write is still at the store — and the memory adapter
// answers in the turn it is asked, which closes that window before a case can act in
// it. So they drive a store that holds each write at the door until the case lets it
// through, and the store is the REAL one with its write path subclassed rather than
// a stand-in: what is under test is how this state orders its writes, and a fake
// store would be asserting the fake.

import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "../../persistence/memory-adapter.js";
import { UiStateStore } from "../../persistence/index.js";
import { openStore } from "../sessions.test-support.js";
import { DurableViewState } from "./durable-view-state.js";

/** The record these cases read and write. Any global key would do; this one is theirs. */
const VIEW_STATE_KEY = "durable-view-state-test";

/** What was stored before the window opened. */
const STORED_IDS: readonly string[] = ["stored-alpha", "stored-beta"];

/** What the person does while the read is in flight. */
const COMMITTED_IDS: readonly string[] = ["committed-only"];

/**
 * Narrow a stored record back into the value.
 *
 * The caller's own, as the option is: what a record narrows to is the surface's
 * decision and not this state's, so a case that borrowed one surface's narrower
 * would be asserting that surface's rule here.
 */
function narrowIdList(raw: unknown): readonly string[] | undefined {
  return Array.isArray(raw)
    ? raw.filter((member): member is string => typeof member === "string")
    : undefined;
}

/**
 * A ceiling that admits a short list and refuses a long one.
 *
 * The recovery cases below need ONE store that refuses and then accepts, which a
 * fixed-capacity adapter gives only if the values differ in size. The adapter's
 * estimate is `partition + key + valueClass + JSON.stringify(value)`, so the base
 * cost here is 38 bytes: `[]` costs 40, `COMMITTED_IDS` costs 56, and `STORED_IDS`
 * costs 68. The number is asserted rather than trusted — a change to the estimate
 * that silently made every write fit would make every recovery case vacuous.
 */
const CEILING_ADMITTING_A_SHORT_LIST = 60;

function stateOver(store: UiStateStore): DurableViewState<readonly string[]> {
  return new DurableViewState<readonly string[]>({
    store,
    key: VIEW_STATE_KEY,
    valueClass: "expansion",
    initial: [],
    narrow: narrowIdList,
  });
}

/** A store already holding a record, the way a second window would find it. */
async function storeHoldingRecord(): Promise<UiStateStore> {
  const store = openStore();
  const written = await store.writeGlobal(VIEW_STATE_KEY, "expansion", [...STORED_IDS]);
  expect(written.outcome).toBe("written");
  return store;
}

describe("hydrating a durable view state", () => {
  it("installs the stored record when nothing was committed meanwhile", async () => {
    // The arm that makes the next case mean something: with no local act, the
    // record IS the answer and hydration must install it.
    const state = stateOver(await storeHoldingRecord());
    await state.hydrate();
    expect(state.value).toStrictEqual(STORED_IDS);
  });

  it("keeps a value committed while the read was still in flight", async () => {
    // The defect: `commit` installs and persists at once, and the older record then
    // arrives and overwrites it. On the unguarded class this ends as `STORED_IDS`.
    const state = stateOver(await storeHoldingRecord());
    const hydration = state.hydrate();
    await state.commit([...COMMITTED_IDS]);
    await hydration;
    expect(state.value).toStrictEqual(COMMITTED_IDS);
  });

  it("never signals a change back to the older record", async () => {
    // The whole sequence a subscribed row would have rendered, not just where it
    // ended: the unguarded class emits the committed value and then emits the stored
    // one, so a person watches their own act undo itself. Counting emissions after
    // the commit would not catch it — the read can settle before the commit's write
    // does — so the values are recorded from the first subscription onward.
    const state = stateOver(await storeHoldingRecord());
    const observedValues: (readonly string[])[] = [];
    state.subscribe(() => {
      observedValues.push(state.value);
    });
    const hydration = state.hydrate();
    await state.commit([...COMMITTED_IDS]);
    await hydration;
    expect(observedValues).toStrictEqual([COMMITTED_IDS]);
  });

  it("still counts as hydrated, so a remount does not re-read over the newer value", async () => {
    // Discarding the value is not the same as never having asked. The read settled,
    // and a second `hydrate` — which every remount performs — must not go back for
    // the record that was just refused.
    const state = stateOver(await storeHoldingRecord());
    const hydration = state.hydrate();
    await state.commit([...COMMITTED_IDS]);
    await hydration;
    expect(state.isHydrated).toBe(true);
    await state.hydrate();
    expect(state.value).toStrictEqual(COMMITTED_IDS);
  });

  it("negative control: a commit AFTER the read settles is not treated as a race", async () => {
    // Without this, the guard could pass by discarding every hydration. The
    // generation is only ahead when an act happened DURING the read.
    const state = stateOver(await storeHoldingRecord());
    await state.hydrate();
    expect(state.value).toStrictEqual(STORED_IDS);
    await state.commit([...COMMITTED_IDS]);
    expect(state.value).toStrictEqual(COMMITTED_IDS);
  });
});

describe("a durable view state whose store was replaced", () => {
  it("drops its subscribers, so a late write notifies nobody", async () => {
    const state = stateOver(openStore());
    let notifications = 0;
    state.subscribe(() => {
      notifications += 1;
    });
    state.dispose();
    await state.commit([...COMMITTED_IDS]);
    expect(state.isDisposed).toBe(true);
    expect(notifications).toBe(0);
  });

  it("discards a hydration that was already in flight", async () => {
    // The record comes back from a store the window has closed, and installing it
    // would put the previous scenario's value on screen under the new one.
    const state = stateOver(await storeHoldingRecord());
    const hydration = state.hydrate();
    state.dispose();
    await hydration;
    expect(state.value).toStrictEqual([]);
  });

  it("negative control: the same hydration installs when nothing disposed it", async () => {
    // Without this, the case above would pass over a state that discarded every
    // record, which would make the stored value unreachable rather than superseded.
    const state = stateOver(await storeHoldingRecord());
    await state.hydrate();
    expect(state.value).toStrictEqual(STORED_IDS);
    expect(state.isDisposed).toBe(false);
  });
});

describe("a refusal this state has recovered from", () => {
  /** Every value `lastRefusal` held at a moment a subscriber was told to look. */
  function recordRefusalsSeenBy(state: DurableViewState<readonly string[]>): {
    readonly seen: readonly (string | undefined)[];
  } {
    const seen: (string | undefined)[] = [];
    state.subscribe(() => {
      seen.push(state.lastRefusal?.code);
    });
    return { seen };
  }

  it("proves the ceiling separates the two writes, so the cases below are not vacuous", async () => {
    const state = stateOver(openStore({ capacityBytes: CEILING_ADMITTING_A_SHORT_LIST }));
    const refused = await state.commit([...STORED_IDS]);
    expect(refused.outcome).toBe("refused");
    const written = await state.commit([...COMMITTED_IDS]);
    expect(written.outcome).toBe("written");
  });

  it("tells its subscribers the failure has cleared", async () => {
    // The defect: the recovery cleared `lastRefusal` and emitted nothing, so the
    // pin list and the invitation shelf kept rendering a failure a person had
    // already fixed — until something unrelated re-rendered the surface.
    const state = stateOver(openStore({ capacityBytes: CEILING_ADMITTING_A_SHORT_LIST }));
    await state.commit([...STORED_IDS]);
    const observed = recordRefusalsSeenBy(state);
    await state.commit([...COMMITTED_IDS]);

    expect(state.lastRefusal).toBeUndefined();
    // The LAST thing a subscriber was told to look at is the cleared value. Under
    // the unguarded class the only emission is the pre-write one, taken while the
    // stale refusal was still in place.
    expect(observed.seen.at(-1)).toBeUndefined();
  });

  it("negative control: a refusal is still published when the write fails", async () => {
    // Without this, the case above would pass over a class that had stopped
    // emitting on settlement altogether — which would hide the failure instead of
    // hiding the recovery.
    const state = stateOver(openStore({ capacityBytes: CEILING_ADMITTING_A_SHORT_LIST }));
    const observed = recordRefusalsSeenBy(state);
    await state.commit([...STORED_IDS]);

    expect(state.lastRefusal?.code).toBe("quota-exceeded");
    expect(observed.seen.at(-1)).toBe("quota-exceeded");
  });

  it("does not publish twice for a settlement that changed nothing", async () => {
    // Two successful writes in a row leave the refusal `undefined` throughout, and
    // a second emission for that would re-render every memoised row for a fact that
    // did not move.
    const state = stateOver(openStore());
    await state.commit([...COMMITTED_IDS]);
    const observed = recordRefusalsSeenBy(state);
    await state.commit([...STORED_IDS]);

    expect(observed.seen).toStrictEqual([undefined]);
  });
});

/** What one write to the chokepoint answers. Derived off the chokepoint, as the state derives it. */
type StoreWriteOutcome = Awaited<ReturnType<UiStateStore["writeGlobal"]>>;

/**
 * The real store, with every global write stopped at the door until a case admits it.
 *
 * `writeGlobal` is overridden rather than the adapter's `write`, because the door has
 * to be exactly the seam `DurableViewState` calls: holding the adapter would let the
 * chokepoint's own validation and trim run before the case had a chance to act, and
 * the ordering under test is the ordering of calls INTO the chokepoint.
 */
class HeldWriteStore extends UiStateStore {
  /** Every value handed to `writeGlobal`, in call order. The ordering assertion. */
  public readonly valuesWritten: unknown[] = [];
  readonly #writesAtDoor: (() => void)[] = [];
  readonly #arrivalWatchers: (() => void)[] = [];

  public override async writeGlobal(
    key: string,
    valueClass: Parameters<UiStateStore["writeGlobal"]>[1],
    value: Parameters<UiStateStore["writeGlobal"]>[2],
  ): Promise<StoreWriteOutcome> {
    this.valuesWritten.push(value);
    const admitted = new Promise<void>((admit) => {
      this.#writesAtDoor.push(admit);
    });
    for (const watcher of this.#arrivalWatchers.splice(0)) {
      watcher();
    }
    await admitted;
    return await super.writeGlobal(key, valueClass, value);
  }

  /** Let the write at the door through, waiting for one to arrive if none has yet. */
  public async admitOneWrite(): Promise<void> {
    if (this.#writesAtDoor.length === 0) {
      await new Promise<void>((announce) => {
        this.#arrivalWatchers.push(announce);
      });
    }
    const admit = this.#writesAtDoor.shift();
    if (admit === undefined) {
      throw new Error("no write is at the door");
    }
    admit();
  }
}

function heldWriteStore(options: { readonly capacityBytes?: number } = {}): HeldWriteStore {
  return new HeldWriteStore({
    adapter: new MemoryPersistenceAdapter(
      options.capacityBytes === undefined ? {} : { capacityBytes: options.capacityBytes },
    ),
  });
}

describe("a durable view state whose writes overlap", () => {
  it("writes one snapshot per issued commit, in order, and leaves the newest durable", async () => {
    // The defect: both writes go to the store at once, each carrying a COMPLETE
    // record, and whichever the adapter finishes last is what stays durable. On the
    // unserialised class the second value reaches the store before the first has
    // settled, so the first assertion below already fails.
    const store = heldWriteStore();
    const state = stateOver(store);

    const pinnedFirst = state.commit([...STORED_IDS]);
    const pinnedSecond = state.commit([...COMMITTED_IDS]);
    expect(store.valuesWritten).toStrictEqual([STORED_IDS]);

    await store.admitOneWrite();
    await pinnedFirst;

    await store.admitOneWrite();
    await pinnedSecond;
    expect(store.valuesWritten).toStrictEqual([STORED_IDS, COMMITTED_IDS]);
    expect((await store.readGlobal(VIEW_STATE_KEY))?.value).toStrictEqual(COMMITTED_IDS);
  });

  it("spends no write on a snapshot a later act replaced before it was sent", async () => {
    // Three acts, two writes: the middle snapshot was never at the store, so writing
    // it would spend a write on a state no surface shows any more.
    const store = heldWriteStore();
    const state = stateOver(store);

    const pinnedFirst = state.commit([...STORED_IDS]);
    const pinnedSecond = state.commit([]);
    const pinnedThird = state.commit([...COMMITTED_IDS]);

    await store.admitOneWrite();
    await pinnedFirst;
    await store.admitOneWrite();
    const [replaced, replacing] = await Promise.all([pinnedSecond, pinnedThird]);

    expect(store.valuesWritten).toStrictEqual([STORED_IDS, COMMITTED_IDS]);
    expect(state.value).toStrictEqual(COMMITTED_IDS);
    // Both callers settle on the one write that carried the newest state, which is
    // the only answer the coalescing leaves true for either of them.
    expect(replaced).toStrictEqual(replacing);
  });

  it("negative control: two commits that do not overlap are two writes", async () => {
    // Without this, the cases above would pass over a class that coalesced every
    // commit into one write and simply dropped the rest.
    const store = heldWriteStore();
    const state = stateOver(store);

    const pinnedFirst = state.commit([...STORED_IDS]);
    await store.admitOneWrite();
    await pinnedFirst;

    const pinnedSecond = state.commit([...COMMITTED_IDS]);
    await store.admitOneWrite();
    await pinnedSecond;

    expect(store.valuesWritten).toStrictEqual([STORED_IDS, COMMITTED_IDS]);
  });

  it("publishes no refusal from a settlement a later act superseded", async () => {
    // The long list does not fit and the short one does, so the write a person's
    // CURRENT state rides succeeds — and the obsolete refusal must not be left
    // standing beside a control whose value is durable. The unserialised class
    // records it, so a pin list shows a failure for a state it is not showing.
    const store = heldWriteStore({ capacityBytes: CEILING_ADMITTING_A_SHORT_LIST });
    const state = stateOver(store);

    const refusedByCeiling = state.commit([...STORED_IDS]);
    const admittedByCeiling = state.commit([...COMMITTED_IDS]);

    await store.admitOneWrite();
    expect((await refusedByCeiling).outcome).toBe("refused");
    expect(state.lastRefusal).toBeUndefined();

    await store.admitOneWrite();
    expect((await admittedByCeiling).outcome).toBe("written");
    expect(state.lastRefusal).toBeUndefined();
    expect((await store.readGlobal(VIEW_STATE_KEY))?.value).toStrictEqual(COMMITTED_IDS);
  });

  it("negative control: a settlement nothing superseded is still published", async () => {
    // Without this, the case above would pass over a class that had stopped
    // recording refusals altogether — which hides the failure instead of hiding the
    // one that is obsolete.
    const store = heldWriteStore({ capacityBytes: CEILING_ADMITTING_A_SHORT_LIST });
    const state = stateOver(store);

    const refusedByCeiling = state.commit([...STORED_IDS]);
    await store.admitOneWrite();
    await refusedByCeiling;

    expect(state.lastRefusal?.code).toBe("quota-exceeded");
  });
});
