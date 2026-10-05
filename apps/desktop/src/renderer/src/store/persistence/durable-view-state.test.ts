// A durable read that settles after a person has already acted must not overwrite the act.
// Driven against the real `UiStateStore` over the memory adapter with the read genuinely in
// flight. The write cases need a second act while the first write is still at the store, so
// they use the real store with its write path subclassed to hold each write.

import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "@renderer/store/persistence/memory-persistence-adapter.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { DurableViewState, type PersistenceWriteOutcome } from "./durable-view-state.js";
import { openStore } from "./ui-state-store.test-support.js";

/** The record these cases read and write. Any global key would do; this one is theirs. */
const VIEW_STATE_KEY = "durable-view-state-test";

/** What was stored before the window opened. */
const STORED_IDS: readonly string[] = ["stored-alpha", "stored-beta"];

/** What the person does while the read is in flight. */
const COMMITTED_IDS: readonly string[] = ["committed-only"];

/**
 * Narrow a stored record back into the value. The narrowing is the view's decision, so a
 * borrowed narrower would assert that view's rule here.
 */
function narrowIdList(raw: unknown): readonly string[] | undefined {
  return Array.isArray(raw)
    ? raw.filter((member): member is string => typeof member === "string")
    : undefined;
}

/**
 * A ceiling that admits a short list and refuses a long one, so one store refuses and then
 * accepts. The adapter's size estimate is `partition + key + valueClass +
 * JSON.stringify(value)`.
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
  it("keeps a value committed while the read was still in flight", async () => {
    // `commit` installs and persists at once; the older record arriving after it must not
    // overwrite it.
    const state = stateOver(await storeHoldingRecord());
    const hydration = state.hydrate();
    await state.commit([...COMMITTED_IDS]);
    await hydration;
    expect(state.value).toStrictEqual(COMMITTED_IDS);
  });

  it("never signals a change back to the older record", async () => {
    // Records every value a subscribed row would have rendered, from the first subscription
    // onward. Counting emissions after the commit would miss it: the read can settle before
    // the commit's write does.
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
    // The commit's write is still held at the store, which still answers the older record, so
    // a remount's second `hydrate` that read again would put that record back.
    const store = heldWriteStore();
    const seeded = store.writeGlobal(VIEW_STATE_KEY, "expansion", [...STORED_IDS]);
    await store.admitOneWrite();
    await seeded;
    const state = stateOver(store);
    const hydration = state.hydrate();
    const committing = state.commit([...COMMITTED_IDS]);
    await hydration;

    await state.hydrate();

    expect(state.value).toStrictEqual(COMMITTED_IDS);
    await store.admitOneWrite();
    await committing;
  });

  it("negative control: a commit AFTER the read settles is not treated as a race", async () => {
    // Without this, the guard could pass by discarding every hydration.
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
    expect(notifications).toBe(0);
  });

  it("discards a hydration that was already in flight", async () => {
    // Installing a record from the closed store would show the previous scenario's value.
    const state = stateOver(await storeHoldingRecord());
    const hydration = state.hydrate();
    state.dispose();
    await hydration;
    expect(state.value).toStrictEqual([]);
  });

  it("negative control: the same hydration installs when nothing disposed it", async () => {
    // Without this, the case above could pass over a state that discarded every record.
    const state = stateOver(await storeHoldingRecord());
    await state.hydrate();
    expect(state.value).toStrictEqual(STORED_IDS);
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

  it("tells its subscribers the failure has cleared", async () => {
    // A recovery that cleared `lastRefusal` without emitting would leave a fixed failure on
    // screen until an unrelated re-render.
    const state = stateOver(openStore({ capacityBytes: CEILING_ADMITTING_A_SHORT_LIST }));
    await state.commit([...STORED_IDS]);
    const observed = recordRefusalsSeenBy(state);
    await state.commit([...COMMITTED_IDS]);

    expect(state.lastRefusal).toBeUndefined();
    // The last emission must be the cleared value; the unguarded class only emits before the
    // write, while the stale refusal stands.
    expect(observed.seen.at(-1)).toBeUndefined();
  });

  it("negative control: a refusal is still published when the write fails", async () => {
    // Without this, the case above could pass over a class that stopped emitting on settlement.
    const state = stateOver(openStore({ capacityBytes: CEILING_ADMITTING_A_SHORT_LIST }));
    const observed = recordRefusalsSeenBy(state);
    await state.commit([...STORED_IDS]);

    expect(state.lastRefusal?.code).toBe("quota-exceeded");
    expect(observed.seen.at(-1)).toBe("quota-exceeded");
  });
});

/**
 * The real store with every global write held until a case admits it. `writeGlobal` is
 * overridden rather than the adapter, because the ordering under test is that of calls into
 * the chokepoint, before its validation and trim run.
 */
class HeldWriteStore extends UiStateStore {
  /** Every value handed to `writeGlobal`, in call order. The ordering assertion. */
  public readonly valuesWritten: unknown[] = [];
  readonly #heldWrites: (() => void)[] = [];
  readonly #arrivalWatchers: (() => void)[] = [];

  public override async writeGlobal(
    key: string,
    valueClass: Parameters<UiStateStore["writeGlobal"]>[1],
    value: Parameters<UiStateStore["writeGlobal"]>[2],
  ): Promise<PersistenceWriteOutcome> {
    this.valuesWritten.push(value);
    const admitted = new Promise<void>((admit) => {
      this.#heldWrites.push(admit);
    });
    for (const watcher of this.#arrivalWatchers.splice(0)) {
      watcher();
    }
    await admitted;
    return await super.writeGlobal(key, valueClass, value);
  }

  /** Let the held write through, waiting for one to arrive if none has yet. */
  public async admitOneWrite(): Promise<void> {
    if (this.#heldWrites.length === 0) {
      await new Promise<void>((announce) => {
        this.#arrivalWatchers.push(announce);
      });
    }
    const admit = this.#heldWrites.shift();
    if (admit === undefined) {
      throw new Error("no write is held");
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
    // Both writes reaching the store at once would each carry a complete record, and the last
    // to finish would win; the first assertion fails on an unserialized class.
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
    // Three acts, two writes: the middle snapshot never reached the store.
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
    // Both callers settle on the one write that carried the newest state.
    expect(replaced).toStrictEqual(replacing);
  });

  it("negative control: two commits that do not overlap are two writes", async () => {
    // Without this, the cases above could pass over a class that dropped every later commit.
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
    // The long list does not fit and the short one does, so the obsolete refusal must not
    // stand beside a control whose value is durable.
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
    // Without this, the case above could pass over a class that stopped recording refusals.
    const store = heldWriteStore({ capacityBytes: CEILING_ADMITTING_A_SHORT_LIST });
    const state = stateOver(store);

    const refusedByCeiling = state.commit([...STORED_IDS]);
    await store.admitOneWrite();
    await refusedByCeiling;

    expect(state.lastRefusal?.code).toBe("quota-exceeded");
  });
});
