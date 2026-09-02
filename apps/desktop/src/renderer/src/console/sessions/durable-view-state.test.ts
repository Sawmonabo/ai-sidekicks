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

import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import { UiStateStore } from "../persistence/index.js";
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

function openStore(): UiStateStore {
  return new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
}

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
