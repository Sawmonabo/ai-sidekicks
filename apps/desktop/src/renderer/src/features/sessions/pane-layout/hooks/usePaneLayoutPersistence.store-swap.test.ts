// The store an arrangement is written through, when that store is replaced under a live pane
// layout. The composition root re-mints the `UiStateStore` on a reconnect and the session
// screen subtree does not remount, so a writer minted in a `useState` initializer keeps
// writing into the retired store, where nothing reads it again. The assertion is about which
// store was asked: two adapters, one per store, and a ledger on each.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import {
  GatedPersistenceAdapter,
  SESSION_ID,
  saveLayout,
  sessionStore,
  workspaceFor,
  type SessionWithStore,
} from "../../SessionScreen.test-support.js";

/** Cycle pane layout focus, which commits an arrangement without opening or closing a pane. */
function cyclePaneFocus(container: HTMLElement): void {
  const paneLayoutElement = container.querySelector(".meridian-pane-layout__block");
  expect(paneLayoutElement).not.toBeNull();
  if (paneLayoutElement !== null) {
    fireEvent.keyDown(paneLayoutElement, { key: "ArrowRight", altKey: true });
  }
}

function storeOver(adapter: GatedPersistenceAdapter): UiStateStore {
  return new UiStateStore({ adapter });
}

describe("SessionScreen — the arrangement follows the store on screen", () => {
  it("asks the store it was handed last, and never the one it was handed first", async () => {
    const retiredAdapter = new GatedPersistenceAdapter();
    const liveAdapter = new GatedPersistenceAdapter();
    const retiredStore = storeOver(retiredAdapter);
    await saveLayout(retiredStore, SESSION_ID, ["browser", "terminal"]);
    const session: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };

    // Unkeyed, the shape the defect lives in: a replaced store re-renders this subtree.
    const { container, rerender } = render(workspaceFor(session, retiredStore));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
    });

    rerender(workspaceFor(session, storeOver(liveAdapter)));
    const askedOfRetiredStore = retiredAdapter.asked.length;
    cyclePaneFocus(container);
    await crossMacrotaskBoundary();

    await waitFor(() => {
      expect(liveAdapter.asked.length).toBeGreaterThan(0);
    });
    expect(retiredAdapter.asked.length).toBe(askedOfRetiredStore);
    expect(liveAdapter.asked.map((write) => write.partition)).toContain(SESSION_ID);
  });
});

describe("SessionScreen — the restore runs once for the session on screen", () => {
  it("does not read the record again when the store is replaced under it", async () => {
    // `PaneLayoutStore.restore` replaces wholesale, which is wrong against a layout somebody
    // has been arranging. The two records disagree so a second restore shows as a lost pane.
    const firstStore = storeOver(new GatedPersistenceAdapter());
    await saveLayout(firstStore, SESSION_ID, ["browser", "terminal"]);
    const secondStore = storeOver(new GatedPersistenceAdapter());
    await saveLayout(secondStore, SESSION_ID, ["browser"]);
    const session: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };

    const { container, rerender } = render(workspaceFor(session, firstStore));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
    });

    rerender(workspaceFor(session, secondStore));
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();

    expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
  });
});
