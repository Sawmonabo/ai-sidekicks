// What the pane layout's restore does when the read never landed at all. The quietest failure
// the pane layout has: `UiStateStore.read` resolves `undefined` both for a record never
// written and for a read the adapter could not perform, so a transient failure read as a first
// run would file an empty block over the pane layout the adapter still held. The adapter is the
// real memory one with one operation misbehaving, and the misbehavior is lifted before every
// read-back, since an assertion taken while reads still fail would pass over a store that wrote
// anything at all.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { ReadFailurePersistenceAdapter } from "#test/helpers/read-failure-persistence-adapter.js";
import { PaneLayoutStore } from "../store.js";
import {
  drain,
  mountPersistence,
  paneKinds,
  savePaneLayout,
  savedPaneCount,
} from "./usePaneLayoutPersistence.test-support.js";

describe("usePaneLayoutPersistence — a read the adapter could not perform", () => {
  it("keeps the saved arrangement instead of filing an empty block over it", async () => {
    const adapter = new ReadFailurePersistenceAdapter();
    const store = new UiStateStore({ adapter });
    await savePaneLayout(store, ["browser", "agents", "terminal"]);
    const layout = new PaneLayoutStore();

    mountPersistence(layout, store);
    await drain();

    // Nothing came back to draw, and nothing is filed: the three-pane record is untouched.
    expect(paneKinds(layout)).toStrictEqual([]);
    adapter.stopFailingReads();
    expect(await savedPaneCount(store)).toBe(3);
  });

  it("negative control: saving is not disabled, so the next deliberate change lands", async () => {
    // Without this the fix could be "never settle the restore", leaving the person rearranging
    // all session with nothing kept and no refusal raised.
    const adapter = new ReadFailurePersistenceAdapter();
    const store = new UiStateStore({ adapter });
    await savePaneLayout(store, ["browser", "agents", "terminal"]);
    const layout = new PaneLayoutStore();

    mountPersistence(layout, store);
    await drain();
    act(() => {
      layout.open({ kind: "terminal" });
    });
    await drain();

    // One, not three: the layout the person now sees replaced the record, which is what saving
    // is.
    adapter.stopFailingReads();
    expect(paneKinds(layout)).toStrictEqual(["terminal"]);
    expect(await savedPaneCount(store)).toBe(1);
  });
});
