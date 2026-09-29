// What the deck's restore does when the read never landed at all.
//
// A separate story from `layout-persistence.restore-order.test.tsx`, which is about
// the ORDER the restore and the save happen in — both of which assume the read
// answered. Here it does not, and the failure is the quietest one this surface has:
// `UiStateStore.read` resolved `undefined` for a record that was never written AND for
// a read the adapter could not perform, so a transient failure read as a first run.
// The hook opened its fallback ledger pane, counted zero restored panes, and filed
// that one pane over the deck the adapter was still holding — and still perfectly
// willing to accept a write for.
//
// The adapter is the real memory one with exactly one operation misbehaving, and the
// misbehavior is lifted before every read-back: an assertion taken while reads still
// fail asserts the failure a second time and would pass over a store that had written
// anything at all.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { ReadFailurePersistenceAdapter } from "@test/helpers/read-failure-persistence-adapter.js";
import {
  deckLayout,
  drain,
  mountPersistence,
  paneKinds,
  savePaneLayout,
  savedPaneCount,
} from "./usePaneLayoutPersistence.test-support.js";

describe("usePaneLayoutPersistence — a read the adapter could not perform", () => {
  it("keeps the saved arrangement instead of filing the fallback over it", async () => {
    const adapter = new ReadFailurePersistenceAdapter();
    const store = new UiStateStore({ adapter });
    await savePaneLayout(store, ["transcript", "runs", "approvals"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    await drain();

    // The fallback is still OPENED — a window with no panes is not a state this
    // surface has — and simply not saved: the three-pane record is untouched, where
    // the one-pane fallback would have replaced it.
    expect(paneKinds(layout)).toStrictEqual(["transcript"]);
    adapter.stopFailingReads();
    expect(await savedPaneCount(store)).toBe(3);
  });

  it("negative control: saving is not disabled, so the next deliberate change lands", async () => {
    // Without this the fix could be "never settle the restore", which would leave the
    // person rearranging their deck all session with nothing kept and no refusal
    // raised — a worse failure than the one being fixed, and invisible in the case
    // above.
    const adapter = new ReadFailurePersistenceAdapter();
    const store = new UiStateStore({ adapter });
    await savePaneLayout(store, ["transcript", "runs", "approvals"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    await drain();
    act(() => {
      layout.open({ kind: "runs" });
    });
    await drain();

    // Two, not three: the deck the person is now looking at replaced the record, which
    // is what saving IS. The restore settles on a failed read for exactly this reason.
    adapter.stopFailingReads();
    expect(paneKinds(layout)).toStrictEqual(["transcript", "runs"]);
    expect(await savedPaneCount(store)).toBe(2);
  });
});
