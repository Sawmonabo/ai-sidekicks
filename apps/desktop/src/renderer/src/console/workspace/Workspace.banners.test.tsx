// The banners the workspace raises, when the same thing goes wrong twice.
//
// Both cases drive the real surface rather than the fold: what a person sees is a
// column of banners, and the two defects this file exists for are things that column
// did — it grew a duplicate row for every repeat of one refusal, and dismissing one
// row renumbered the keys of every row below it, so React remounted banners nobody
// had touched and took focus off the control somebody was tabbing through.

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { UiStateStore } from "../persistence/index.js";
import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import {
  SCENARIO,
  SESSION_ID,
  memoryStore,
  otherSession,
  sessionStore,
  workspaceFor,
  type WorkspaceSession,
} from "./Workspace.test-support.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { refusingPlane } from "./auxiliary/aux-handoff.test-support.js";

/** A store whose writes fail, which is what raises the workspace's own save refusal. */
class RejectingWriteAdapter extends MemoryPersistenceAdapter {
  public override async write(): Promise<void> {
    throw new Error("the store is closed");
  }
}

/**
 * A bridge whose detach refuses, which is what gives this column a banner to raise.
 *
 * The refusal is STATED rather than inherited from whatever the fixture happens not to
 * serve. This file is about the COLUMN — one row per distinct refusal, and a key that
 * survives a dismissal — so the source of the refusal is scaffolding, and scaffolding
 * that changes whenever a wire is served is scaffolding these cases silently lose.
 */
function bridgeRefusingDetach(): ConsoleBridge {
  return { ...createFixtureBridge({ scenario: SCENARIO }), auxiliaryWindows: refusingPlane() };
}

function renderSession(uiStateStore: UiStateStore): HTMLElement {
  const { container } = render(
    workspaceFor(
      { sessionId: SESSION_ID, store: sessionStore() },
      uiStateStore,
      false,
      bridgeRefusingDetach(),
    ),
  );
  return container;
}

/** Press the detach control the test pane body offers, and let the refusal settle. */
async function pressDetach(container: HTMLElement): Promise<void> {
  const control = container.querySelector<HTMLButtonElement>("[data-detach='timeline']");
  expect(control).not.toBeNull();
  await act(async () => {
    control?.click();
    await crossMacrotaskBoundary();
  });
}

/**
 * One workspace and one bridge, with the route between two sessions inside that mount.
 *
 * UNKEYED, which is the whole shape these cases are about: the workspace stays mounted
 * across a navigation between two open sessions, so a value held for the life of the
 * MOUNT survives the route. ONE bridge across both renders, because the fixture mints a
 * new one per call and a replaced transport is a second reason to drop what this column
 * holds — a case that let both move could not say which one did the clearing.
 */
function renderRoutableSession(): {
  readonly container: HTMLElement;
  readonly routeTo: (session: WorkspaceSession) => void;
} {
  const uiStateStore = memoryStore();
  const bridge = bridgeRefusingDetach();
  const { container, rerender } = render(
    workspaceFor({ sessionId: SESSION_ID, store: sessionStore() }, uiStateStore, false, bridge),
  );
  return {
    container,
    routeTo: (session) => {
      rerender(workspaceFor(session, uiStateStore, false, bridge));
    },
  };
}

/** Wait for the pane whose body offers the detach control these cases press. */
async function awaitDetachable(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(container.querySelector("[data-detach='timeline']")).not.toBeNull();
  });
}

function bannerRows(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".meridian-workspace__banner")];
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
  await act(async () => {
    control?.click();
    await crossMacrotaskBoundary();
  });
}

describe("Workspace — the banner column", () => {
  it("counts a refusal raised three times rather than stacking three of it", async () => {
    // Every press refuses with the same three fields, so three rows would say one
    // thing three times — three chances to dismiss the wrong one and no more
    // information than the first.
    const container = renderSession(memoryStore());
    await waitFor(() => {
      expect(container.querySelector("[data-detach='timeline']")).not.toBeNull();
    });

    await pressDetach(container);
    await pressDetach(container);
    await pressDetach(container);

    expect(bannerRows(container)).toHaveLength(1);
    expect(rowCarrying(container, "shell-absent").textContent).toContain("×3");
  });

  it("negative control: one raise carries no count at all", async () => {
    // Without this, the case above would pass over a row that rendered a count on
    // every banner, and "×1" would be noise on the common case.
    const container = renderSession(memoryStore());
    await waitFor(() => {
      expect(container.querySelector("[data-detach='timeline']")).not.toBeNull();
    });

    await pressDetach(container);

    expect(bannerRows(container)).toHaveLength(1);
    expect(rowCarrying(container, "shell-absent").textContent).not.toContain("×");
  });

  it("keeps a surviving banner's own node when another is dismissed", async () => {
    // Keyed by array position, dismissing the first banner renumbered the rest: React
    // unmounted and remounted rows nobody had touched, which loses focus from the
    // dismiss control a person is tabbing through and re-announces the row.
    const container = renderSession(new UiStateStore({ adapter: new RejectingWriteAdapter() }));
    await waitFor(() => {
      expect(container.querySelector("[data-detach='timeline']")).not.toBeNull();
    });
    // The failing store raises its own refusal on the arrangement the restore opened.
    await waitFor(() => {
      expect(bannerRows(container).length).toBeGreaterThan(0);
    });
    await pressDetach(container);
    const raisedCount = bannerRows(container).length;
    // The store refuses the deck's arrangement and the sidebar's in different words,
    // so this column carries more than the two the case strictly needs.
    expect(raisedCount).toBeGreaterThan(1);

    const survivor = rowCarrying(container, "shell-absent");
    const dismissed = bannerRows(container).find((row) => row !== survivor);
    expect(dismissed).toBeDefined();
    if (dismissed !== undefined) {
      await dismiss(dismissed);
    }

    expect(bannerRows(container)).toHaveLength(raisedCount - 1);
    // The same element, not one carrying the same words: a remount is what the old
    // position key caused, and it is invisible in the markup.
    expect(rowCarrying(container, "shell-absent")).toBe(survivor);
  });
});

describe("Workspace — the banner column belongs to the session that raised it", () => {
  it("stops showing one session's banners once the workspace routes to another", async () => {
    // The defect: a mount-lifetime list. The workspace is not remounted between two
    // open sessions, so a refusal raised while the first was on screen went on standing
    // over the second's deck — a sentence about an act nobody performed in the session
    // they are looking at, with nothing on screen tying it to the one they left.
    const { container, routeTo } = renderRoutableSession();
    await awaitDetachable(container);
    await pressDetach(container);
    expect(bannerRows(container)).toHaveLength(1);

    routeTo(otherSession());

    expect(bannerRows(container)).toHaveLength(0);
  });

  it("negative control: the session arrived at raises banners of its own", async () => {
    // Two ways the case above could pass over a broken column, and this closes both: a
    // column that had stopped raising banners at all, and one that folded the arriving
    // session's refusal into the row the previous session left standing — which is the
    // same triple, so the coalescing rule would count it rather than draw it.
    const { container, routeTo } = renderRoutableSession();
    await awaitDetachable(container);
    await pressDetach(container);

    routeTo(otherSession());
    await awaitDetachable(container);
    await pressDetach(container);

    expect(bannerRows(container)).toHaveLength(1);
    expect(rowCarrying(container, "shell-absent").textContent).not.toContain("×");
  });
});
