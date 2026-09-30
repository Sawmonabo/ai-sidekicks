// The store an arrangement is written through, when that store is replaced under a live pane
// layout. The composition root re-mints the `UiStateStore` on a reconnect and the session
// screen subtree does not remount, so a writer minted in a `useState` initializer keeps
// writing into the retired store, where nothing reads it again. The assertion is about which
// store was asked: two adapters, one per store, and a ledger on each.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { PANE_LAYOUT_RECORD_KEY } from "../layout-persistence.js";
import { CoalescingLayoutWriter, type PersistedLayoutRecord } from "../coalescing-layout-writer.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import {
  GatedPersistenceAdapter,
  SESSION_ID,
  saveLayout,
  sessionStore,
  workspaceFor,
  type SessionWithStore,
} from "../../SessionScreen.test-support.js";

/** One arrangement the probe below files, in the shape the `layout` class admits. */
const PROBE_RECORD: PersistedLayoutRecord = { $probe: { version: 1 } };

/** Cycle pane layout focus, which commits an arrangement without opening or closing a pane. */
function cyclePaneFocus(container: HTMLElement): void {
  const paneLayoutElement = container.querySelector(".meridian-pane-layout");
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
    await saveLayout(retiredStore, SESSION_ID, ["transcript", "terminal"]);
    const session: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };

    // Unkeyed, the shape the defect lives in: a replaced store re-renders this subtree.
    const { container, rerender } = render(workspaceFor(session, retiredStore, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
    });

    rerender(workspaceFor(session, storeOver(liveAdapter), false));
    const askedOfRetiredStore = retiredAdapter.asked.length;
    cyclePaneFocus(container);
    await crossMacrotaskBoundary();

    await waitFor(() => {
      expect(liveAdapter.asked.length).toBeGreaterThan(0);
    });
    expect(retiredAdapter.asked.length).toBe(askedOfRetiredStore);
    expect(liveAdapter.asked.map((write) => write.partition)).toContain(SESSION_ID);
  });

  it("negative control: a writer held in `useState` files into the retired store", async () => {
    // A writer held in `useState`, driven over the same swap. Without this the case above
    // would pass over a layout that wrote nowhere, and the ledgers would agree by accident.
    const retiredAdapter = new GatedPersistenceAdapter();
    const liveAdapter = new GatedPersistenceAdapter();

    function ProbeHoldingOneWriter(props: { readonly store: UiStateStore }): React.JSX.Element {
      const [writer] = useState(
        () =>
          new CoalescingLayoutWriter<PersistedLayoutRecord>({
            write: async (partition, snapshot) => {
              await props.store.write(partition, PANE_LAYOUT_RECORD_KEY, "layout", snapshot);
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

describe("SessionScreen — the restore runs once for the session on screen", () => {
  it("does not read the record again when the store is replaced under it", async () => {
    // `PaneLayoutStore.restore` replaces wholesale, which is wrong against a layout somebody
    // has been arranging. The two records disagree so a second restore shows as a lost pane.
    const firstStore = storeOver(new GatedPersistenceAdapter());
    await saveLayout(firstStore, SESSION_ID, ["transcript", "terminal"]);
    const secondStore = storeOver(new GatedPersistenceAdapter());
    await saveLayout(secondStore, SESSION_ID, ["transcript"]);
    const session: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };

    const { container, rerender } = render(workspaceFor(session, firstStore, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
    });

    rerender(workspaceFor(session, secondStore, false));
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();

    expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
  });

  it("negative control: the second store's record really is a pane layout of one pane", async () => {
    // Without this, the case above would pass over two records that said the same thing.
    const secondStore = storeOver(new GatedPersistenceAdapter());
    await saveLayout(secondStore, SESSION_ID, ["transcript"]);
    const session: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };

    const { container } = render(workspaceFor(session, secondStore, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(1);
    });
  });
});
