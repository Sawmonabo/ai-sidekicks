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
import { describe, expect, it } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "./workspace-bounds.js";
import { UiStateStore } from "../persistence/index.js";
import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import { DeckLayout } from "./deck/deck-layout.js";
import { DECK_LAYOUT_RECORD_KEY, useDeckPersistence } from "./layout-persistence.js";

const RESTORE_SESSION = "session-restore";

function deckLayout(): DeckLayout {
  return new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
}

function uiStateStore(): UiStateStore {
  return new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
}

/** A saved arrangement, written through the grammar that reads it back. */
async function saveDeck(
  store: UiStateStore,
  kinds: readonly ("timeline" | "runs")[],
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
function mountPersistence(layout: DeckLayout, store: UiStateStore): void {
  function Harness(): React.JSX.Element {
    useDeckPersistence({
      layout,
      uiStateStore: store,
      sessionId: RESTORE_SESSION,
      onSaveRefused: () => undefined,
    });
    return <div />;
  }
  render(<Harness />);
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
    const store = uiStateStore();
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
    const store = uiStateStore();
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
    const store = uiStateStore();
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
    const store = uiStateStore();
    await saveDeck(store, ["timeline", "runs"]);
    const layout = deckLayout();

    mountPersistence(layout, store);
    act(() => {
      layout.open({ kind: "runs", entity: undefined });
    });
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["timeline", "runs"]);
  });

  it("negative control: an untouched read restores the record and writes nothing back", async () => {
    // Without this, a hook that wrote on every settle would pass the cases above while
    // spending a durable write on every session a person opens.
    const store = uiStateStore();
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
    const store = uiStateStore();
    const layout = deckLayout();

    mountPersistence(layout, store);
    await drain();

    expect(paneKinds(layout)).toStrictEqual(["timeline"]);
    expect(await savedPaneCount(store)).toBe(1);
  });

  it("negative control: a change made after the restore settled is written", async () => {
    // The gate opens; it does not stay shut. Without this every case above would pass
    // over a hook that had simply stopped writing.
    const store = uiStateStore();
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
