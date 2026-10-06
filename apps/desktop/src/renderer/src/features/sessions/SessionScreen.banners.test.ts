// The banner the session screen raises when a save of the pane layout fails. Every case
// drives the real screen: one banner under the header in plain words however many saves fail,
// each failure's code going to the diagnostic capture, and a banner raised in one session not
// standing over the next. Each case commits an arrangement (cycling focus commits one without
// opening or closing a pane) against a store whose writes fail.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { PersistenceAdapterError } from "#renderer/store/persistence/adapter.js";
import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { MemoryPersistenceAdapter } from "#renderer/store/persistence/memory-adapter.js";
import { refusePersistence } from "#renderer/store/persistence/refusals.js";
import {
  SCENARIO,
  SESSION_B_ID,
  SESSION_ID,
  otherSession,
  saveLayout,
  sessionStore,
  workspaceFor,
  type SessionWithStore,
} from "./SessionScreen.test-support.js";

/**
 * How the store's database answers a write: `throw` fails with an error of no kind the store
 * knows, `full` refuses for want of room, `gone` refuses as a database that went away. Each is a
 * failed save and says so in the same words.
 */
type WriteMode = "accept" | "throw" | "full" | "gone";

class ScriptedWriteAdapter extends MemoryPersistenceAdapter {
  public mode: WriteMode = "accept";

  public override async write(record: Parameters<MemoryPersistenceAdapter["write"]>[0]) {
    switch (this.mode) {
      case "throw":
        throw new Error("the store is closed");
      case "full":
        throw new PersistenceAdapterError(
          refusePersistence("quota-exceeded", "The store has no room left."),
        );
      case "gone":
        throw new PersistenceAdapterError(
          refusePersistence("adapter-unavailable", "The store went away."),
        );
      case "accept":
        await super.write(record);
    }
  }
}

/** A store holding a two-pane arrangement for each session, with writes then switched on. */
async function storeWithSavedLayouts(): Promise<{
  readonly store: UiStateStore;
  readonly adapter: ScriptedWriteAdapter;
}> {
  const adapter = new ScriptedWriteAdapter();
  const store = new UiStateStore({ adapter });
  await saveLayout(store, SESSION_ID, ["transcript", "terminal"]);
  await saveLayout(store, SESSION_B_ID, ["transcript", "terminal"]);
  return { store, adapter };
}

async function awaitRestoredPaneLayout(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
  });
}

/** Commit one arrangement, and let the write it queues settle. */
async function commitArrangement(container: HTMLElement): Promise<void> {
  const paneLayoutElement = container.querySelector(".meridian-pane-layout");
  expect(paneLayoutElement).not.toBeNull();
  if (paneLayoutElement !== null) {
    fireEvent.keyDown(paneLayoutElement, { key: "ArrowRight", altKey: true });
  }
  await crossMacrotaskBoundary();
  await crossMacrotaskBoundary();
}

/**
 * One session screen and one store, with the route between two sessions inside that mount.
 * Unkeyed, because the screen stays mounted across a navigation between open sessions. One
 * bridge across both renders, since a replaced transport is a second reason to drop what the
 * column holds and a case letting both move could not say which did the clearing.
 */
function renderRoutableSession(store: UiStateStore): {
  readonly container: HTMLElement;
  readonly routeTo: (session: SessionWithStore) => void;
} {
  const fixture = createFixtureBridge({ scenario: SCENARIO });
  const first: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };
  const { container, rerender } = render(workspaceFor(first, store, fixture));
  return {
    container,
    routeTo: (session) => {
      rerender(workspaceFor(session, store, fixture));
    },
  };
}

const BANNER_TEXT = "Pane layout not saved·it will save again on your next change";

let detachForwarder: (() => void) | undefined;

afterEach(() => {
  detachForwarder?.();
  detachForwarder = undefined;
});

/** The details of the capture's records about pane layout saves, from here on. */
function captureSaveFailures(): () => readonly string[] {
  windowDiagnosticCapture.flush();
  const batches: string[] = [];
  detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
    batches.push(jsonLines);
  });
  batches.length = 0;
  return () => {
    windowDiagnosticCapture.flush();
    return batches
      .flatMap((batch) => batch.split("\n"))
      .map((line) => JSON.parse(line) as { kind: string; detail: string })
      .filter((record) => record.kind === "pane-layout-not-saved")
      .map((record) => record.detail);
  };
}

function bannerRows(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".meridian-session-screen__banner")];
}

describe("SessionScreen — the pane layout's save failure", () => {
  it("draws one plain banner under the header and sends each failure code to capture", async () => {
    const { store, adapter } = await storeWithSavedLayouts();
    const { container } = render(
      workspaceFor({ sessionId: SESSION_ID, store: sessionStore() }, store),
    );
    await awaitRestoredPaneLayout(container);
    const readSaveFailures = captureSaveFailures();

    adapter.mode = "throw";
    await commitArrangement(container);
    adapter.mode = "full";
    await commitArrangement(container);
    adapter.mode = "gone";
    await commitArrangement(container);

    const rows = bannerRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe(BANNER_TEXT);
    expect(rows[0]?.previousElementSibling?.className).toContain("meridian-session-header");
    // Each failure's own code, and an error of no kind the store knows as the store's refusal
    // for a database it cannot use, not a rejection the screen never hears.
    expect(readSaveFailures()).toStrictEqual([
      `session ${SESSION_ID}: adapter-unavailable`,
      `session ${SESSION_ID}: quota-exceeded`,
      `session ${SESSION_ID}: adapter-unavailable`,
    ]);

    rows[0]?.querySelector<HTMLButtonElement>('[aria-label="Dismiss this notice"]')?.click();
    await crossMacrotaskBoundary();
    expect(bannerRows(container)).toHaveLength(0);
  });
});

describe("SessionScreen — the banner column belongs to the session that raised it", () => {
  it("stops showing one session's banners once the session screen routes to another", async () => {
    // The screen is not remounted between two open sessions, so a banner held for the mount's
    // lifetime would stand over the second's pane layout, about an act nobody performed there.
    const { store, adapter } = await storeWithSavedLayouts();
    const { container, routeTo } = renderRoutableSession(store);
    await awaitRestoredPaneLayout(container);
    adapter.mode = "throw";
    await commitArrangement(container);
    expect(bannerRows(container)).toHaveLength(1);

    routeTo(otherSession());

    expect(bannerRows(container)).toHaveLength(0);
  });

  it("negative control: the session arrived at raises a banner of its own", async () => {
    // Without this, the case above would pass over a column that stopped raising banners.
    const { store, adapter } = await storeWithSavedLayouts();
    const { container, routeTo } = renderRoutableSession(store);
    await awaitRestoredPaneLayout(container);
    adapter.mode = "throw";
    await commitArrangement(container);

    routeTo(otherSession());
    await awaitRestoredPaneLayout(container);
    await commitArrangement(container);

    expect(bannerRows(container)).toHaveLength(1);
  });
});
