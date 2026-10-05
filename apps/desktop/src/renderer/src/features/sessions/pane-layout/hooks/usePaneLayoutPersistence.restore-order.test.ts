// The restore and the save are one story, and the story is about order. The store lives
// behind a process boundary, so its read takes real time while the pane layout is live. Both
// directions fail quietly and look like success: a write during the read replaces the record
// being read, and a restore landing after the person arranged the layout takes the
// arrangement away with no error. Every case drives the real hook against a real
// `PaneLayoutStore` and store, because the failure is in how the two effects interleave.
// `coalescing-layout-writer.test.ts` holds the writer's claims and
// `usePaneLayoutPersistence.read-failure.test.ts` the read that never landed; all mount
// through `usePaneLayoutPersistence.test-support.tsx`.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { memoryStore } from "../../SessionScreen.test-support.js";
import { type PaneLayoutStore } from "../pane-layout-store.js";
import { PANE_LAYOUT_RECORD_KEY } from "../layout-persistence.js";
import {
  RESTORE_SESSION_ID,
  createPaneLayoutStore,
  drain,
  mountPersistence,
  paneKinds,
  savePaneLayout,
  savedPaneCount,
} from "./usePaneLayoutPersistence.test-support.js";

/** The widths on screen, in the order the panes sit in. */
function paneWidths(layout: PaneLayoutStore): readonly number[] {
  return layout.snapshot().panes.map((pane) => pane.sizePermille);
}

/** A width floor loose enough that nothing in these fixtures is clamped by it. */
const UNCLAMPED_WIDTH_FLOOR_PERMILLE = 100;

describe("usePaneLayoutPersistence — an arrangement made while the record was being read", () => {
  it("writes nothing while the read is still in flight", async () => {
    const store = memoryStore();
    await savePaneLayout(store, ["transcript", "terminal"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "terminal" });
    });

    // The one-pane layout on screen has reached the store through no path, so the two-pane
    // record the read is resolving is as it was.
    expect(await savedPaneCount(store)).toBe(2);
    await drain();
  });

  it("keeps both the saved arrangement and the pane opened during the read", async () => {
    const store = memoryStore();
    await savePaneLayout(store, ["transcript"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "terminal" });
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["transcript", "terminal"]);
  });

  it("writes the reconciled arrangement once, after the restore settles", async () => {
    const store = memoryStore();
    await savePaneLayout(store, ["transcript"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "terminal" });
    });
    await drain();

    expect(await savedPaneCount(store)).toBe(2);
  });

  it("does not duplicate a pane the record already held", async () => {
    const store = memoryStore();
    await savePaneLayout(store, ["transcript", "terminal"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "terminal" });
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["transcript", "terminal"]);
  });

  it("leaves a pane the person closed during the read closed", async () => {
    // A close made during the read leaves no trace in the snapshot, so a reconciliation that
    // diffs the layout cannot see it and the record would put the pane straight back.
    const store = memoryStore();
    await savePaneLayout(store, ["transcript", "terminal"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      const paneId = layout.open({ kind: "terminal" });
      layout.close(paneId);
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["transcript"]);
    expect(await savedPaneCount(store)).toBe(1);
  });

  it("keeps the widths the person set during the read while the record adds a pane", async () => {
    // The record names an address that is not on screen, so the merge actually runs; a record
    // whose addresses are all open adopts nothing and cannot constrain the commit. A merge
    // that equalized every live pane would undo the drag the person had just finished. The
    // arriving pane takes the equal share of three, and the two live panes keep their
    // seventy-thirty ratio across the rest (467 to 200, from 700 and 300 rescaled into 667).
    const store = memoryStore();
    await savePaneLayout(store, ["agents"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      const transcriptPaneId = layout.open({ kind: "transcript" });
      const terminalPaneId = layout.open({ kind: "terminal" });
      layout.applyLayout(
        { [transcriptPaneId]: 70, [terminalPaneId]: 30 },
        UNCLAMPED_WIDTH_FLOOR_PERMILLE,
      );
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["agents", "transcript", "terminal"]);
    expect(paneWidths(layout)).toStrictEqual([333, 467, 200]);
  });

  it("focuses an adopted pane when the person left the pane layout focusing nothing", async () => {
    // `close` clears the focus when its pane goes, so an open-then-close during the read
    // reaches the merge focusing nothing; the composer then had nowhere to send until a click.
    const store = memoryStore();
    await savePaneLayout(store, ["agents"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      const terminalPaneId = layout.open({ kind: "terminal" });
      layout.close(terminalPaneId);
    });
    await drain();

    const focused = layout
      .snapshot()
      .panes.find((pane) => pane.paneId === layout.snapshot().focusedPaneId);
    expect(focused?.kind).toBe("agents");
  });

  it("negative control: a live focus is not moved onto the adopted pane", async () => {
    // Without this the case above would pass over a merge that focused the record's panes
    // unconditionally, undoing the person's work one axis over.
    const store = memoryStore();
    await savePaneLayout(store, ["agents"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "terminal" });
    });
    await drain();

    const focused = layout
      .snapshot()
      .panes.find((pane) => pane.paneId === layout.snapshot().focusedPaneId);
    expect(focused?.kind).toBe("terminal");
  });

  it("keeps the order the person set during the read", async () => {
    // The same two panes in opposite orders in the record and the layout. A wholesale restore
    // takes the record's and undoes the reorder the person just made.
    const store = memoryStore();
    await savePaneLayout(store, ["transcript", "terminal"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "transcript" });
      const terminalPaneId = layout.open({ kind: "terminal" });
      layout.movePane(terminalPaneId, -1);
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["terminal", "transcript"]);
  });

  it("negative control: an untouched read restores the record, writing nothing back", async () => {
    // Without this, a hook that wrote on every settle would pass while spending a durable
    // write on every session opened.
    const store = memoryStore();
    await savePaneLayout(store, ["transcript", "terminal"]);
    const before = await store.read(RESTORE_SESSION_ID, PANE_LAYOUT_RECORD_KEY);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["transcript", "terminal"]);
    const after = await store.read(RESTORE_SESSION_ID, PANE_LAYOUT_RECORD_KEY);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it("negative control: nothing saved opens the fallback transcript and writes it", async () => {
    // The gate must not swallow the first run's own record.
    const store = memoryStore();
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["transcript"]);
    expect(await savedPaneCount(store)).toBe(1);
  });

  it("negative control: a change made after the restore settled is written", async () => {
    // The gate opens and does not stay shut; without this every case above would pass over a
    // hook that had stopped writing.
    const store = memoryStore();
    await savePaneLayout(store, ["transcript"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store);
    await drain();
    act(() => {
      layout.open({ kind: "terminal" });
    });
    await drain();

    expect(await savedPaneCount(store)).toBe(2);
  });
});

describe("usePaneLayoutPersistence — the writer across a double-mount", () => {
  it("keeps saving after the mount that closed its writer re-committed it", async () => {
    // `flushAndClose` is one-way and `request` then drops every arrangement silently, so a
    // holder that re-committed the retired writer left the person rearranging with nothing
    // kept. React's double-mount is the trigger.
    const store = memoryStore();
    await savePaneLayout(store, ["transcript"]);
    const layout = createPaneLayoutStore();

    mountPersistence(layout, store, { underStrictMode: true });
    await drain();
    act(() => {
      layout.open({ kind: "terminal" });
    });
    await drain();

    expect(await savedPaneCount(store)).toBe(2);
  });
});
