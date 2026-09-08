// The harness the deck-persistence suites drive the real hook through.
//
// Two suites now: `layout-persistence.restore-order.test.tsx` holds what the restore
// and the save do to each other in TIME, and `layout-persistence.read-failure.test.tsx`
// holds what they do when the read never landed at all. Both mount the same hook over
// the same real `DeckLayout` and a real store, so the mount, the drain and the two
// readings live here rather than being written twice and drifting apart.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { expect } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../../core/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { type UiStateStore } from "../../persistence/index.js";
import { DeckLayout } from "../deck/deck-layout.js";
import { DECK_LAYOUT_RECORD_KEY, useDeckPersistence } from "./layout-persistence.js";

/** The one session every case here arranges, saves, and restores. */
export const RESTORE_SESSION = "session-restore";

export function deckLayout(): DeckLayout {
  return new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
}

/** A saved arrangement, written through the grammar that reads it back. */
export async function saveDeck(
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
export function mountPersistence(
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
export async function drain(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

export function paneKinds(layout: DeckLayout): readonly string[] {
  return layout.snapshot().panes.map((pane) => pane.kind);
}

/** How many panes the saved record holds. Its one non-pane key is `$deck`. */
export async function savedPaneCount(store: UiStateStore): Promise<number> {
  const record = await store.read(RESTORE_SESSION, DECK_LAYOUT_RECORD_KEY);
  if (record === undefined) {
    return 0;
  }
  return Object.keys(record.value as Record<string, unknown>).length - 1;
}
