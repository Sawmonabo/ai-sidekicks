// The restore and the save are one story, and the story is about order. The store lives
// behind a process boundary, so its read takes real time while the pane layout is live. Both
// directions fail quietly and look like success: a write during the read replaces the record
// being read, and a restore landing after the person arranged the layout takes the
// arrangement away with no error. Every case drives the real hook against a real
// `PaneLayoutStore` and store, because the failure is in how the two effects interleave.
// `features/sessions/pane-layout/coalescing-writer.test.ts` holds the writer's claims and
// `usePaneLayoutPersistence.read-failure.test.ts` the read that never landed; all mount
// through `usePaneLayoutPersistence.test-support.tsx`.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { memoryStore } from "../../SessionScreen.test-support.js";
import { PaneLayoutStore } from "../store.js";
import { PANE_LAYOUT_RECORD_KEY } from "../persistence.js";
import {
  RESTORE_SESSION_ID,
  drain,
  mountPersistence,
  paneKinds,
  savePaneLayout,
  savedPaneCount,
} from "./usePaneLayoutPersistence.test-support.js";

/** Moves the block left of the conversation and the terminal above the row. */
function blockLeftTerminalAbove(layout: PaneLayoutStore): void {
  const first = layout.snapshot().panes[0];
  layout.movePane(first?.paneId ?? "", -1);
  layout.placeTerminal("above");
}

function focusedKind(layout: PaneLayoutStore): string | undefined {
  const { panes, focusedPaneId } = layout.snapshot();
  return panes.find((pane) => pane.paneId === focusedPaneId)?.kind;
}

describe("usePaneLayoutPersistence — an arrangement made while the record was being read", () => {
  it("writes nothing while the read is still in flight", async () => {
    const store = memoryStore();
    await savePaneLayout(store, ["browser", "terminal"]);
    const layout = new PaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "agents" });
    });

    // The one-pane layout on screen has reached the store through no path, so the two-pane
    // record the read is resolving is as it was.
    expect(await savedPaneCount(store)).toBe(2);
    await drain();
  });

  it("keeps the saved panes and the one opened during the read, and files the merge", async () => {
    const store = memoryStore();
    await savePaneLayout(store, ["browser", "terminal"]);
    const layout = new PaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "agents" });
      // Already in the record: kept once, under the live pane's id.
      layout.open({ kind: "terminal" });
    });
    await drain();

    // The record's panes were open first, so they stand in front; the terminal stays last.
    expect(paneKinds(layout)).toStrictEqual(["browser", "agents", "terminal"]);
    expect(await savedPaneCount(store)).toBe(3);
  });

  it("leaves a pane the person closed during the read closed", async () => {
    // A close made during the read leaves no trace in the snapshot, so a reconciliation that
    // diffs the layout cannot see it and the record would put the pane straight back.
    const store = memoryStore();
    await savePaneLayout(store, ["browser", "terminal"]);
    const layout = new PaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      const paneId = layout.open({ kind: "terminal" });
      layout.close(paneId);
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["browser"]);
    expect(await savedPaneCount(store)).toBe(1);
  });

  it("keeps the person's order from during the read, and the record's side and place", async () => {
    // The record holds the same panes in the other order; a wholesale restore would undo the
    // order the person just set, and a merge that ignored the record would lose its side and
    // terminal place.
    const store = memoryStore();
    await savePaneLayout(store, ["agents", "browser", "terminal"], blockLeftTerminalAbove);
    const layout = new PaneLayoutStore();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "browser" });
      layout.open({ kind: "agents" });
      layout.open({ kind: "terminal" });
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["browser", "agents", "terminal"]);
    // The person moved neither, so the record's side and place are taken.
    expect(layout.snapshot().side).toBe("left");
    expect(layout.snapshot().terminalPlace).toBe("above");
  });

  it("focuses an adopted pane only when the person left the layout focusing nothing", async () => {
    // An open-then-close during the read reaches the merge focusing nothing; the composer then
    // had nowhere to send until a click. A live focus stays where the person put it.
    const store = memoryStore();
    await savePaneLayout(store, ["agents"]);
    const emptied = new PaneLayoutStore();
    const focused = new PaneLayoutStore();

    mountPersistence(emptied, store);
    act(() => {
      emptied.close(emptied.open({ kind: "terminal" }));
    });
    await drain();
    mountPersistence(focused, store);
    act(() => {
      focused.open({ kind: "terminal" });
    });
    await drain();

    expect(focusedKind(emptied)).toBe("agents");
    expect(focusedKind(focused)).toBe("terminal");
  });
});

describe("usePaneLayoutPersistence — a read nobody acted during", () => {
  it("restores order, side and terminal place, writing nothing back", async () => {
    // Without the write check, a hook that wrote on every settle would pass while spending a
    // durable write on every session opened.
    const store = memoryStore();
    await savePaneLayout(store, ["agents", "browser", "terminal"], blockLeftTerminalAbove);
    const before = await store.read(RESTORE_SESSION_ID, PANE_LAYOUT_RECORD_KEY);
    const layout = new PaneLayoutStore();

    mountPersistence(layout, store);
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["agents", "browser", "terminal"]);
    expect(layout.snapshot().side).toBe("left");
    expect(layout.snapshot().terminalPlace).toBe("above");
    const after = await store.read(RESTORE_SESSION_ID, PANE_LAYOUT_RECORD_KEY);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it("negative control: nothing saved files the empty block as the first record", async () => {
    // The gate must not swallow the first run's own record.
    const store = memoryStore();
    const layout = new PaneLayoutStore();

    mountPersistence(layout, store);
    await drain();

    expect(paneKinds(layout)).toStrictEqual([]);
    expect(await store.read(RESTORE_SESSION_ID, PANE_LAYOUT_RECORD_KEY)).toBeDefined();
  });

  it("negative control: a change made after the restore settled is written", async () => {
    // The gate opens and does not stay shut; without this every case above would pass over a
    // hook that had stopped writing.
    const store = memoryStore();
    await savePaneLayout(store, ["browser"]);
    const layout = new PaneLayoutStore();

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
    await savePaneLayout(store, ["browser"]);
    const layout = new PaneLayoutStore();

    mountPersistence(layout, store, { underStrictMode: true });
    await drain();
    act(() => {
      layout.open({ kind: "terminal" });
    });
    await drain();

    expect(await savedPaneCount(store)).toBe(2);
  });
});
