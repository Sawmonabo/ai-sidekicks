// The harness the deck-persistence suites drive the real hook through.
//
// Three suites now: `layout-persistence.restore-order.test.tsx` holds what the restore
// and the save do to each other in TIME, `layout-persistence.read-failure.test.tsx`
// holds what they do when the read never landed at all, and
// `layout-persistence.store-swap.test.tsx` holds what a replaced store does to the
// writer — with `layout-persistence.session-scope.test.tsx` beside them for what a
// route from one session to another leaves on screen. All mount the same hook over the
// same real `DeckLayout` and a real store, so the mount, the drain and the readings
// live here rather than being written four times and drifting apart.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { expect } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../../core/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { type UiStateStore } from "../../persistence/index.js";
import { DeckLayout } from "../deck/deck-layout.js";
import { DECK_LAYOUT_SNAPSHOT_VERSION, DECK_SNAPSHOT_HEADER_KEY } from "../deck/deck-snapshot.js";
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
  sessionId: string = RESTORE_SESSION,
): Promise<void> {
  const layout = deckLayout();
  for (const kind of kinds) {
    layout.open({ kind, entity: undefined });
  }
  const result = await store.write(
    sessionId,
    DECK_LAYOUT_RECORD_KEY,
    "layout",
    layout.toSnapshot(),
  );
  expect(result.outcome).toBe("written");
}

/**
 * A saved arrangement in a grammar this build does not know, which restores as a refusal.
 *
 * Written through the store rather than by stubbing the decode, because what the
 * session-scope suite is about is the REFUSAL a real restore reports — and a decode
 * driven by hand would be a second implementation of the reader the hook calls.
 */
export async function saveDeckInAnUnknownGrammar(
  store: UiStateStore,
  sessionId: string,
): Promise<void> {
  const result = await store.write(sessionId, DECK_LAYOUT_RECORD_KEY, "layout", {
    [DECK_SNAPSHOT_HEADER_KEY]: { version: DECK_LAYOUT_SNAPSHOT_VERSION + 1 },
  });
  expect(result.outcome).toBe("written");
}

/** What a mounted surface offers a case that routes it, and what it reads back. */
export interface MountedDeckPersistence {
  /**
   * Route the mounted surface to another session, as the workspace does.
   *
   * A re-render and not a remount, which is the whole shape the session-scope suite is
   * about: the workspace stays mounted across a navigation between two open sessions,
   * so anything the hook holds per MOUNT survives the route.
   */
  readonly routeTo: (sessionId: string | undefined) => void;
  /** The refusal codes the hook returned on the last render, in order. */
  readonly restoreRefusalCodes: () => readonly string[];
}

/**
 * Mount the hook against one layout and one store.
 *
 * The read the effect starts is already in flight when `render` returns, so an act
 * performed on the layout before the first `await` is an act performed DURING the read
 * — no gate to install, no timer to advance, and nothing for a later reader to
 * disbelieve about what the fixture was doing.
 *
 * The refusals are RENDERED rather than captured into a variable the harness writes to
 * during a pass: a render body that assigns is a render body with a side effect, and a
 * pass React discards would leave a reading no commit ever made.
 */
export function mountPersistence(
  layout: DeckLayout,
  store: UiStateStore,
  options: { readonly underStrictMode?: boolean; readonly sessionId?: string } = {},
): MountedDeckPersistence {
  const { underStrictMode = false, sessionId = RESTORE_SESSION } = options;
  function Harness(props: { readonly sessionId: string | undefined }): React.JSX.Element {
    const restoreRefusals = useDeckPersistence({
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
