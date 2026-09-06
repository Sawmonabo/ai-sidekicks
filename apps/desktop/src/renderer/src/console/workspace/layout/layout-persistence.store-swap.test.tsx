// The store an arrangement is written THROUGH, when that store is replaced under a
// live surface.
//
// The failure this file exists for is silent in both directions and looks like
// nothing at all: the composition root re-mints the `UiStateStore` on a reconnect and
// hands the new one down, the workspace subtree is keyed on the session and does not
// remount, and a writer minted in a `useState` initializer goes on writing into the
// store that was retired. Every later arrangement is filed where nothing will read it
// again, and the deck on screen is the only place it still exists.
//
// So the assertion is about WHICH store was asked, not about whether a write
// happened: two adapters, one per store, and a ledger on each.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { UiStateStore } from "../../persistence/index.js";
import { DECK_LAYOUT_RECORD_KEY } from "./layout-persistence.js";
import { CoalescingLayoutWriter, type PersistedLayoutRecord } from "./layout-writer.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import {
  GatedPersistenceAdapter,
  SESSION_ID,
  saveLayout,
  sessionStore,
  workspaceFor,
  type WorkspaceSession,
} from "../Workspace.test-support.js";

/** One arrangement the probe below files, in the shape the `layout` class admits. */
const PROBE_RECORD: PersistedLayoutRecord = { $probe: { version: 1 } };

/** Cycle deck focus, which commits an arrangement without opening or closing a pane. */
function cycleDeckFocus(container: HTMLElement): void {
  const deck = container.querySelector(".meridian-deck");
  expect(deck).not.toBeNull();
  if (deck !== null) {
    fireEvent.keyDown(deck, { key: "ArrowRight", altKey: true });
  }
}

function storeOver(adapter: GatedPersistenceAdapter): UiStateStore {
  return new UiStateStore({ adapter });
}

describe("Workspace — the arrangement follows the store on screen", () => {
  it("asks the store it was handed last, and never the one it was handed first", async () => {
    const retiredAdapter = new GatedPersistenceAdapter();
    const liveAdapter = new GatedPersistenceAdapter();
    const retiredStore = storeOver(retiredAdapter);
    await saveLayout(retiredStore, SESSION_ID, ["timeline", "runs"]);
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };

    // Unkeyed, because that is the shape the defect lives in: the same session with a
    // replaced store re-renders this subtree rather than remounting it.
    const { container, rerender } = render(workspaceFor(session, retiredStore, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(2);
    });

    rerender(workspaceFor(session, storeOver(liveAdapter), false));
    const askedOfRetiredStore = retiredAdapter.asked.length;
    cycleDeckFocus(container);
    await crossMacrotaskBoundary();

    await waitFor(() => {
      expect(liveAdapter.asked.length).toBeGreaterThan(0);
    });
    expect(retiredAdapter.asked.length).toBe(askedOfRetiredStore);
    expect(liveAdapter.asked.map((write) => write.partition)).toContain(SESSION_ID);
  });

  it("negative control: a writer held in `useState` files into the retired store", async () => {
    // The shape the fix replaced, driven over the same swap. Without this the case
    // above would pass over a surface that stopped writing anywhere at all, and the
    // two ledgers would agree for the wrong reason.
    const retiredAdapter = new GatedPersistenceAdapter();
    const liveAdapter = new GatedPersistenceAdapter();

    function ProbeHoldingOneWriter(props: { readonly store: UiStateStore }): React.JSX.Element {
      const [writer] = useState(
        () =>
          new CoalescingLayoutWriter<PersistedLayoutRecord>({
            write: async (partition, snapshot) => {
              await props.store.write(partition, DECK_LAYOUT_RECORD_KEY, "layout", snapshot);
            },
            onFailed: () => undefined,
          }),
      );
      return (
        <button
          type="button"
          onClick={() => {
            writer.request(SESSION_ID, PROBE_RECORD);
          }}
        >
          Save
        </button>
      );
    }

    const { getByRole, rerender } = render(
      <ProbeHoldingOneWriter store={storeOver(retiredAdapter)} />,
    );
    rerender(<ProbeHoldingOneWriter store={storeOver(liveAdapter)} />);
    fireEvent.click(getByRole("button", { name: "Save" }));
    await crossMacrotaskBoundary();

    expect(retiredAdapter.asked.length).toBe(1);
    expect(liveAdapter.asked).toHaveLength(0);
  });
});

describe("Workspace — the restore runs once for the session on screen", () => {
  it("does not read the record again when the store is replaced under it", async () => {
    // `DeckLayout.restore` replaces wholesale, which is right at a mount against an
    // empty deck and wrong against one somebody has been arranging: the two records
    // below deliberately disagree, so a second restore is visible as the deck losing a
    // pane rather than as nothing at all.
    const firstStore = storeOver(new GatedPersistenceAdapter());
    await saveLayout(firstStore, SESSION_ID, ["timeline", "runs"]);
    const secondStore = storeOver(new GatedPersistenceAdapter());
    await saveLayout(secondStore, SESSION_ID, ["timeline"]);
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };

    const { container, rerender } = render(workspaceFor(session, firstStore, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(2);
    });

    rerender(workspaceFor(session, secondStore, false));
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();

    expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(2);
  });

  it("negative control: the second store's record really is a one-pane deck", async () => {
    // Without this, the case above would pass over two records that said the same
    // thing, and the assertion would be about nothing.
    const secondStore = storeOver(new GatedPersistenceAdapter());
    await saveLayout(secondStore, SESSION_ID, ["timeline"]);
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };

    const { container } = render(workspaceFor(session, secondStore, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });
  });
});
