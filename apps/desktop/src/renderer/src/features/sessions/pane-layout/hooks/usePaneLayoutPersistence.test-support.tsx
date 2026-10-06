// The harness the pane layout persistence suites drive the real hook through. Three suites
// share it: `usePaneLayoutPersistence.restore-order.test.ts` (what the restore and the save do
// to each other in time), `.read-failure.test.ts` (a read that never landed) and
// `.store-swap.test.ts` (a replaced store and the writer). All mount the same hook over a real
// `PaneLayoutStore` and a real store, so the mount, the drain and the readings live here.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { expect } from "vitest";

import { PANE_LAYOUT_RESTORED_PANE_CAP } from "../store.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { type UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { PaneLayoutStore } from "../store.js";
import { PANE_LAYOUT_RECORD_KEY } from "../persistence.js";
import { usePaneLayoutPersistence } from "./usePaneLayoutPersistence.js";

/** The one session every case here arranges, saves, and restores. */
export const RESTORE_SESSION_ID = "session-restore";

/** An empty layout store with the production restored-pane cap. */
export function createPaneLayoutStore(): PaneLayoutStore {
  return new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
}

/** A saved arrangement, written through the grammar that reads it back. */
export async function savePaneLayout(
  store: UiStateStore,
  kinds: readonly ("transcript" | "terminal" | "agents")[],
): Promise<void> {
  const layout = createPaneLayoutStore();
  for (const kind of kinds) {
    layout.open({ kind });
  }
  const result = await store.write(
    RESTORE_SESSION_ID,
    PANE_LAYOUT_RECORD_KEY,
    "layout",
    layout.toSnapshot(),
  );
  expect(result.outcome).toBe("written");
}

/**
 * Mount the hook against one layout and one store. The read the effect starts is already in
 * flight when `render` returns, so an act on the layout before the first `await` happens
 * during the read, with no gate to install and no timer to advance.
 */
export function mountPersistence(
  layout: PaneLayoutStore,
  store: UiStateStore,
  options: { readonly underStrictMode?: boolean } = {},
): void {
  function Harness(): React.JSX.Element {
    usePaneLayoutPersistence({
      layout,
      uiStateStore: store,
      sessionId: RESTORE_SESSION_ID,
      onSaveRefused: () => undefined,
      onRestoreRefused: () => undefined,
    });
    return <div />;
  }
  render(
    options.underStrictMode === true ? (
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

/** The pane kinds the layout currently holds, in order. */
export function paneKinds(layout: PaneLayoutStore): readonly string[] {
  return layout.snapshot().panes.map((pane) => pane.kind);
}

/** How many panes the saved record holds. Its one non-pane key is `$paneLayout`. */
export async function savedPaneCount(store: UiStateStore): Promise<number> {
  const record = await store.read(RESTORE_SESSION_ID, PANE_LAYOUT_RECORD_KEY);
  if (record === undefined) {
    return 0;
  }
  return Object.keys(record.value as Record<string, unknown>).length - 1;
}
