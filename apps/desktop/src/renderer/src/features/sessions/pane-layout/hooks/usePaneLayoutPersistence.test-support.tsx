// The harness the pane layout persistence suites drive the real hook through. Four suites
// share it: `usePaneLayoutPersistence.restore-order.test.ts` (what the restore and the save do
// to each other in time), `.read-failure.test.ts` (a read that never landed),
// `.store-swap.test.tsx` (a replaced store and the writer) and `.session-scope.test.ts` (a
// route from one session to another). All mount the same hook over a real `PaneLayoutStore`
// and a real store, so the mount, the drain and the readings live here.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { expect } from "vitest";

import { PANE_LAYOUT_RESTORED_PANE_CAP } from "../pane-layout-store.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { type UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { PaneLayoutStore } from "../pane-layout-store.js";
import {
  PANE_LAYOUT_SNAPSHOT_VERSION,
  PANE_LAYOUT_SNAPSHOT_HEADER_KEY,
} from "../pane-layout-snapshot.js";
import { PANE_LAYOUT_RECORD_KEY } from "../layout-persistence.js";
import { usePaneLayoutPersistence } from "./usePaneLayoutPersistence.js";

/** The one session every case here arranges, saves, and restores. */
export const RESTORE_SESSION_ID = "session-restore";

/** What a mounted screen offers a case that routes it, and what it reads back. */
export interface MountedPaneLayoutPersistence {
  /**
   * Route the mounted screen to another session, as the session screen does. A re-render and
   * not a remount, since the screen stays mounted across a navigation between open sessions
   * and anything the hook holds per mount survives the route.
   */
  readonly routeTo: (sessionId: string | undefined) => void;
  /** The refusal codes the hook returned on the last render, in order. */
  readonly restoreRefusalCodes: () => readonly string[];
}

/** An empty layout store with the production restored-pane cap. */
export function createPaneLayoutStore(): PaneLayoutStore {
  return new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
}

/** A saved arrangement, written through the grammar that reads it back. */
export async function savePaneLayout(
  store: UiStateStore,
  kinds: readonly ("transcript" | "terminal" | "agents")[],
  sessionId: string = RESTORE_SESSION_ID,
): Promise<void> {
  const layout = createPaneLayoutStore();
  for (const kind of kinds) {
    layout.open({ kind });
  }
  const result = await store.write(
    sessionId,
    PANE_LAYOUT_RECORD_KEY,
    "layout",
    layout.toSnapshot(),
  );
  expect(result.outcome).toBe("written");
}

/**
 * A saved arrangement in a grammar this build does not know, which restores as a refusal.
 * Written through the store rather than by stubbing the decode, which would be a second
 * implementation of the reader the hook calls.
 */
export async function savePaneLayoutInUnknownVersion(
  store: UiStateStore,
  sessionId: string,
): Promise<void> {
  const result = await store.write(sessionId, PANE_LAYOUT_RECORD_KEY, "layout", {
    [PANE_LAYOUT_SNAPSHOT_HEADER_KEY]: { version: PANE_LAYOUT_SNAPSHOT_VERSION + 1 },
  });
  expect(result.outcome).toBe("written");
}

/**
 * Mount the hook against one layout and one store. The read the effect starts is already in
 * flight when `render` returns, so an act on the layout before the first `await` happens
 * during the read, with no gate to install and no timer to advance. The refusals are rendered
 * rather than captured into a variable, since a render body that assigns has a side effect
 * and a discarded pass would leave a reading no commit made.
 */
export function mountPersistence(
  layout: PaneLayoutStore,
  store: UiStateStore,
  options: { readonly underStrictMode?: boolean; readonly sessionId?: string } = {},
): MountedPaneLayoutPersistence {
  const { underStrictMode = false, sessionId = RESTORE_SESSION_ID } = options;
  function Harness(props: { readonly sessionId: string | undefined }): React.JSX.Element {
    const restoreRefusals = usePaneLayoutPersistence({
      layout,
      uiStateStore: store,
      sessionId: props.sessionId,
      onSaveRefused: () => undefined,
    });
    return <div>{restoreRefusals.map((refusal) => refusal.code).join(" ")}</div>;
  }
  const treeFor = (routedSessionId: string | undefined): React.JSX.Element =>
    underStrictMode ? (
      <StrictMode>
        <Harness sessionId={routedSessionId} />
      </StrictMode>
    ) : (
      <Harness sessionId={routedSessionId} />
    );
  const { container, rerender } = render(treeFor(sessionId));
  return {
    routeTo: (routedSessionId) => {
      rerender(treeFor(routedSessionId));
    },
    restoreRefusalCodes: () =>
      (container.textContent ?? "").split(" ").filter((code) => code.length > 0),
  };
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
