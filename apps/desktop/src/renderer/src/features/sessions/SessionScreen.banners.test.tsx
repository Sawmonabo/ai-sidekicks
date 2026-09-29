// The banners the session screen raises, when the same thing goes wrong twice.
//
// Every case drives the real screen rather than the fold: what a person sees is a
// column of banners, and the defects this file exists for are things that column did —
// it grew a duplicate row for every repeat of one refusal, dismissing one row
// renumbered the keys of every row below it so React remounted banners nobody had
// touched, and a refusal raised in one session went on standing over the next.
//
// A banner is raised by a refused save, so each case commits an arrangement — cycling
// pane layout focus commits one without opening or closing a pane — against a store whose
// writes have been made to fail.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { PersistenceAdapterError } from "@renderer/store/persistence/persistence-adapter.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { MemoryPersistenceAdapter } from "@renderer/store/persistence/memory-persistence-adapter.js";
import { refusePersistence } from "@renderer/store/persistence/persistence-refusals.js";
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
 * How the store answers a write.
 *
 * `reject` is a write that fails outright, which the session screen words itself; `refuse`
 * is one the store turns into its own refusal, whose words are the store's. Two modes
 * because a column of two different banners needs two different sentences.
 */
type WriteMode = "accept" | "reject" | "refuse";

class ScriptedWriteAdapter extends MemoryPersistenceAdapter {
  public mode: WriteMode = "accept";

  public override async write(record: Parameters<MemoryPersistenceAdapter["write"]>[0]) {
    if (this.mode === "reject") {
      throw new Error("the store is closed");
    }
    if (this.mode === "refuse") {
      throw new PersistenceAdapterError(
        refusePersistence("adapter-unavailable", "The store went away."),
      );
    }
    await super.write(record);
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
 *
 * UNKEYED, which is the whole shape the second describe is about: the session screen stays
 * mounted across a navigation between two open sessions, so a value held for the life
 * of the MOUNT survives the route. ONE bridge across both renders, because the fixture
 * mints a new one per call and a replaced transport is a second reason to drop what this
 * column holds — a case that let both move could not say which one did the clearing.
 */
function renderRoutableSession(store: UiStateStore): {
  readonly container: HTMLElement;
  readonly routeTo: (session: SessionWithStore) => void;
} {
  const fixture = createFixtureBridge({ scenario: SCENARIO });
  const first: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };
  const { container, rerender } = render(workspaceFor(first, store, false, fixture));
  return {
    container,
    routeTo: (session) => {
      rerender(workspaceFor(session, store, false, fixture));
    },
  };
}

function bannerRows(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".meridian-session-screen__banner")];
}

function rowCarrying(container: HTMLElement, text: string): HTMLElement {
  const row = bannerRows(container).find((candidate) => candidate.textContent?.includes(text));
  if (row === undefined) {
    throw new Error(`no banner carrying ${text}`);
  }
  return row;
}

async function dismiss(row: HTMLElement): Promise<void> {
  const control = row.querySelector<HTMLButtonElement>('[aria-label="Dismiss this notice"]');
  expect(control).not.toBeNull();
  control?.click();
  await crossMacrotaskBoundary();
}

describe("SessionScreen — the banner column", () => {
  it("counts a refusal raised three times rather than stacking three of it", async () => {
    // Every commit refuses with the same three fields, so three rows would say one
    // thing three times — three chances to dismiss the wrong one and no more
    // information than the first.
    const { store, adapter } = await storeWithSavedLayouts();
    const { container } = render(
      workspaceFor({ sessionId: SESSION_ID, store: sessionStore() }, store, false),
    );
    await awaitRestoredPaneLayout(container);
    adapter.mode = "reject";

    await commitArrangement(container);
    await commitArrangement(container);
    await commitArrangement(container);

    expect(bannerRows(container)).toHaveLength(1);
    expect(rowCarrying(container, "layout-save-failed").textContent).toContain("×3");
  });

  it("negative control: one raise carries no count at all", async () => {
    // Without this, the case above would pass over a row that rendered a count on
    // every banner, and "×1" would be noise on the common case.
    const { store, adapter } = await storeWithSavedLayouts();
    const { container } = render(
      workspaceFor({ sessionId: SESSION_ID, store: sessionStore() }, store, false),
    );
    await awaitRestoredPaneLayout(container);
    adapter.mode = "reject";

    await commitArrangement(container);

    expect(bannerRows(container)).toHaveLength(1);
    expect(rowCarrying(container, "layout-save-failed").textContent).not.toContain("×");
  });

  it("keeps a surviving banner's own node when another is dismissed", async () => {
    // Keyed by array position, dismissing the first banner renumbered the rest: React
    // unmounted and remounted rows nobody had touched, which loses focus from the
    // dismiss control a person is tabbing through and re-announces the row.
    const { store, adapter } = await storeWithSavedLayouts();
    const { container } = render(
      workspaceFor({ sessionId: SESSION_ID, store: sessionStore() }, store, false),
    );
    await awaitRestoredPaneLayout(container);
    adapter.mode = "reject";
    await commitArrangement(container);
    adapter.mode = "refuse";
    await commitArrangement(container);
    expect(bannerRows(container)).toHaveLength(2);

    const survivor = rowCarrying(container, "adapter-unavailable");
    await dismiss(rowCarrying(container, "layout-save-failed"));

    expect(bannerRows(container)).toHaveLength(1);
    // The same element, not one carrying the same words: a remount is what the old
    // position key caused, and it is invisible in the markup.
    expect(rowCarrying(container, "adapter-unavailable")).toBe(survivor);
  });
});

describe("SessionScreen — the banner column belongs to the session that raised it", () => {
  it("stops showing one session's banners once the session screen routes to another", async () => {
    // The defect: a mount-lifetime list. The session screen is not remounted between two
    // open sessions, so a refusal raised while the first was on screen went on standing
    // over the second's pane layout — a sentence about an act nobody performed in the session
    // they are looking at, with nothing on screen tying it to the one they left.
    const { store, adapter } = await storeWithSavedLayouts();
    const { container, routeTo } = renderRoutableSession(store);
    await awaitRestoredPaneLayout(container);
    adapter.mode = "reject";
    await commitArrangement(container);
    expect(bannerRows(container)).toHaveLength(1);

    routeTo(otherSession());

    expect(bannerRows(container)).toHaveLength(0);
  });

  it("negative control: the session arrived at raises banners of its own", async () => {
    // Two ways the case above could pass over a broken column, and this closes both: a
    // column that had stopped raising banners at all, and one that folded the arriving
    // session's refusal into the row the previous session left standing — which is the
    // same triple, so the coalescing rule would count it rather than draw it.
    const { store, adapter } = await storeWithSavedLayouts();
    const { container, routeTo } = renderRoutableSession(store);
    await awaitRestoredPaneLayout(container);
    adapter.mode = "reject";
    await commitArrangement(container);

    routeTo(otherSession());
    await awaitRestoredPaneLayout(container);
    await commitArrangement(container);

    expect(bannerRows(container)).toHaveLength(1);
    expect(rowCarrying(container, "layout-save-failed").textContent).not.toContain("×");
  });
});
