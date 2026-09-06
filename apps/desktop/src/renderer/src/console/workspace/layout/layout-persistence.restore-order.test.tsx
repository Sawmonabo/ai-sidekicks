// The restore and the save are one story, and the story is about ORDER.
//
// The store lives behind a process boundary, so its read takes real time, and the deck
// is live for every millisecond of it. Both directions fail quietly and both look like
// success: a write during the read replaces the record being read, so the person finds
// a first-run window where their arrangement was, and a restore landing after they have
// arranged the deck takes the arrangement away with no error anywhere.
//
// Every case drives the real hook against a real `DeckLayout` and a real store, because
// the failure is in how the two effects interleave and neither half shows it alone.
// `layout-writer.test.ts` holds the writer's own claims; this file holds the pair's.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../workspace-bounds.js";
import { type UiStateStore } from "../../persistence/index.js";
import { memoryStore } from "../Workspace.test-support.js";
import { DeckLayout } from "../deck/deck-layout.js";
import { DECK_LAYOUT_RECORD_KEY, useDeckPersistence } from "./layout-persistence.js";

const RESTORE_SESSION = "session-restore";

function deckLayout(): DeckLayout {
  return new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
}

/** A saved arrangement, written through the grammar that reads it back. */
async function saveDeck(
  store: UiStateStore,
  kinds: readonly ("timeline" | "runs" | "approvals")[],
): Promise<void> {
  const layout = deckLayout();
  for (const kind of kinds) {
    layout.open({ kind, entity: undefined });
  }
  const result = await store.write(
    RESTORE_SESSION,
    DECK_LAYOUT_RECORD_KEY,
    "layout",
    layout.toSnapshot(),
  );
  expect(result.outcome).toBe("written");
}

/**
 * Mount the hook against one layout and one store.
 *
 * The read the effect starts is already in flight when `render` returns, so an act
 * performed on the layout before the first `await` is an act performed DURING the read
 * — no gate to install, no timer to advance, and nothing for a later reader to
 * disbelieve about what the fixture was doing.
 */
function mountPersistence(
  layout: DeckLayout,
  store: UiStateStore,
  options: { readonly underStrictMode: boolean } = { underStrictMode: false },
): void {
  function Harness(): React.JSX.Element {
    useDeckPersistence({
      layout,
      uiStateStore: store,
      sessionId: RESTORE_SESSION,
      onSaveRefused: () => undefined,
    });
    return <div />;
  }
  render(
    options.underStrictMode ? (
      <StrictMode>
        <Harness />
      </StrictMode>
    ) : (
      <Harness />
    ),
  );
}

/** Let the read, the restore, and the write pump settle, without advancing a timer. */
async function drain(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 12; turn += 1) {
      await Promise.resolve();
    }
  });
}

function paneKinds(layout: DeckLayout): readonly string[] {
  return layout.snapshot().panes.map((pane) => pane.kind);
}

/** The widths on screen, in the order the panes sit in. */
function paneWidths(layout: DeckLayout): readonly number[] {
  return layout.snapshot().panes.map((pane) => pane.sizePermille);
}

/** A width floor loose enough that nothing in these fixtures is clamped by it. */
const UNCLAMPED_WIDTH_FLOOR_PERMILLE = 100;

/** How many panes the saved record holds. Its one non-pane key is `$deck`. */
async function savedPaneCount(store: UiStateStore): Promise<number> {
  const record = await store.read(RESTORE_SESSION, DECK_LAYOUT_RECORD_KEY);
  if (record === undefined) {
    return 0;
  }
  return Object.keys(record.value as Record<string, unknown>).length - 1;
}

describe("useDeckPersistence — an arrangement made while the record was being read", () => {
  it("writes nothing while the read is still in flight", async () => {
    const store = memoryStore();
    await saveDeck(store, ["timeline", "runs"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "runs", entity: undefined });
    });

    // The one-pane deck the person is looking at has reached the store through no path,
    // so the two-pane record the read is still resolving is exactly as it was.
    expect(await savedPaneCount(store)).toBe(2);
    await drain();
  });

  it("keeps both the saved arrangement and the pane opened during the read", async () => {
    const store = memoryStore();
    await saveDeck(store, ["timeline"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "runs", entity: undefined });
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["timeline", "runs"]);
  });

  it("writes the reconciled arrangement once, after the restore settles", async () => {
    const store = memoryStore();
    await saveDeck(store, ["timeline"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "runs", entity: undefined });
    });
    await drain();

    expect(await savedPaneCount(store)).toBe(2);
  });

  it("does not duplicate a pane the record already held", async () => {
    const store = memoryStore();
    await saveDeck(store, ["timeline", "runs"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "runs", entity: undefined });
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["timeline", "runs"]);
  });

  it("leaves a pane the person closed during the read closed", async () => {
    // A close made while the record is in flight leaves no trace in the deck's
    // snapshot — the pane is simply gone — so a reconciliation that diffs the deck
    // cannot see it, and the record puts the pane straight back. The person watches a
    // pane they just closed return, and the write that follows files it as theirs.
    const store = memoryStore();
    await saveDeck(store, ["timeline", "runs"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    act(() => {
      const paneId = layout.open({ kind: "runs", entity: undefined });
      layout.close(paneId);
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["timeline"]);
    expect(await savedPaneCount(store)).toBe(1);
  });

  it("keeps the widths the person set during the read while the record adds a pane", async () => {
    // THE RECORD NAMES AN ADDRESS THAT IS NOT ON SCREEN, so the merge actually runs.
    // A record every one of whose addresses is already open adopts nothing and leaves
    // the deck untouched by construction, which is why the earlier shape of this case
    // never reached the commit it was written to constrain: the merge equalised every
    // live pane, so the drag the person had just finished was gone.
    //
    // The arriving pane takes the equal share a three-pane deck gives it and the two
    // live panes keep their seventy-thirty ratio across what is left — 467 to 200,
    // which is 700 and 300 rescaled into the 667 the deck still holds.
    const store = memoryStore();
    await saveDeck(store, ["approvals"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    act(() => {
      const timelinePaneId = layout.open({ kind: "timeline", entity: undefined });
      const runsPaneId = layout.open({ kind: "runs", entity: undefined });
      layout.applyLayout(
        { [timelinePaneId]: 70, [runsPaneId]: 30 },
        UNCLAMPED_WIDTH_FLOOR_PERMILLE,
      );
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["approvals", "timeline", "runs"]);
    expect(paneWidths(layout)).toStrictEqual([333, 467, 200]);
  });

  it("focuses an adopted pane when the person left the deck focusing nothing", async () => {
    // `close` clears the focus when the pane holding it goes, so an open-then-close
    // during the read reaches the merge with the deck focusing nothing. Panes then
    // arrived from the record with no focus among them, and the composer read that as
    // having nowhere to send — recoverable only by a click or an arrow key.
    const store = memoryStore();
    await saveDeck(store, ["approvals"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    act(() => {
      const runsPaneId = layout.open({ kind: "runs", entity: undefined });
      layout.close(runsPaneId);
    });
    await drain();

    const focused = layout
      .snapshot()
      .panes.find((pane) => pane.paneId === layout.snapshot().focusedPaneId);
    expect(focused?.kind).toBe("approvals");
  });

  it("negative control: a live focus is not moved onto the adopted pane", async () => {
    // Without this the case above would pass over a merge that focused the record's
    // panes unconditionally, which is the same window-undoing-work-under-their-hands
    // defect the width rule exists for, one axis over.
    const store = memoryStore();
    await saveDeck(store, ["approvals"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "runs", entity: undefined });
    });
    await drain();

    const focused = layout
      .snapshot()
      .panes.find((pane) => pane.paneId === layout.snapshot().focusedPaneId);
    expect(focused?.kind).toBe("runs");
  });

  it("keeps the order the person set during the read", async () => {
    // Same two panes in both the record and the deck, in opposite orders. A wholesale
    // restore has no way to prefer one, so it takes the record's and the reorder the
    // person just performed is undone under their hands.
    const store = memoryStore();
    await saveDeck(store, ["timeline", "runs"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "timeline", entity: undefined });
      const runsPaneId = layout.open({ kind: "runs", entity: undefined });
      layout.movePane(runsPaneId, -1);
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["runs", "timeline"]);
  });

  it("negative control: an untouched read restores the record and writes nothing back", async () => {
    // Without this, a hook that wrote on every settle would pass the cases above while
    // spending a durable write on every session a person opens.
    const store = memoryStore();
    await saveDeck(store, ["timeline", "runs"]);
    const before = await store.read(RESTORE_SESSION, DECK_LAYOUT_RECORD_KEY);
    const layout = deckLayout();

    mountPersistence(layout, store);
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["timeline", "runs"]);
    const after = await store.read(RESTORE_SESSION, DECK_LAYOUT_RECORD_KEY);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it("negative control: with nothing saved the fallback ledger is opened and written", async () => {
    // The gate must not swallow the first run's own record, which is the arrangement
    // the person finds the next time they open the session.
    const store = memoryStore();
    const layout = deckLayout();

    mountPersistence(layout, store);
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["timeline"]);
    expect(await savedPaneCount(store)).toBe(1);
  });

  it("negative control: a change made after the restore settled is written", async () => {
    // The gate opens; it does not stay shut. Without this every case above would pass
    // over a hook that had simply stopped writing.
    const store = memoryStore();
    await saveDeck(store, ["timeline"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    await drain();
    act(() => {
      layout.open({ kind: "runs", entity: undefined });
    });
    await drain();

    expect(await savedPaneCount(store)).toBe(2);
  });
});

describe("useDeckPersistence — the writer across a double-mount", () => {
  it("keeps saving after the mount that closed its writer re-committed it", async () => {
    // `flushAndClose` is one-way and `request` then drops every arrangement in
    // silence, so a holder that re-committed the retired writer left the person
    // rearranging their deck all session with nothing kept and no refusal raised.
    // React's own double-mount is the trigger, and it arrives with a wrapper nobody
    // re-audits this call site for.
    const store = memoryStore();
    await saveDeck(store, ["timeline"]);
    const layout = deckLayout();

    mountPersistence(layout, store, { underStrictMode: true });
    await drain();
    act(() => {
      layout.open({ kind: "runs", entity: undefined });
    });
    await drain();

    expect(await savedPaneCount(store)).toBe(2);
  });

  it("negative control: the same arrangement lands under an ordinary single mount", async () => {
    // Without this the case above would pass over a fixture whose deck reached the
    // store on some path other than the writer being tested.
    const store = memoryStore();
    await saveDeck(store, ["timeline"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    await drain();
    act(() => {
      layout.open({ kind: "runs", entity: undefined });
    });
    await drain();

    expect(await savedPaneCount(store)).toBe(2);
  });
});
