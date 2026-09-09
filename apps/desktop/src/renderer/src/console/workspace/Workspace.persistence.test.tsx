// The arrangement the workspace restores, the one it saves, and the session each is
// filed under.
//
// The persistence pair is the risky half and it fails quietly in both directions — a
// restore that never ran leaves a person's arrangement on disk and invisible, and a
// save that runs before the restore OVERWRITES it with an empty deck. Both look like
// "the deck opened with one pane", which is also what success looks like the first
// time.
//
// Navigating between two open sessions is that same failure with a second partition in
// it. Sessions are opened and never closed, so moving from one to another re-renders
// this component rather than remounting it, and a queued arrangement can flush after
// the surface already shows somebody else's session.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UiStateStore } from "../persistence/index.js";
import { DECK_LAYOUT_RECORD_KEY } from "./layout/layout-persistence.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import {
  GatedPersistenceAdapter,
  SESSION_B_ID,
  SESSION_ID,
  memoryStore,
  otherSession,
  renderWorkspace,
  saveLayout,
  sessionStore,
  workspaceFor,
  type WorkspaceSession,
} from "./Workspace.test-support.js";

/** How many panes a saved deck record holds. Its one non-pane key is `$deck`. */
function panesInRecord(value: unknown): number {
  return Object.keys(value as Record<string, unknown>).length - 1;
}

describe("Workspace — the saved arrangement", () => {
  it("opens the ledger alone when nothing was saved", async () => {
    const { container } = renderWorkspace(memoryStore());
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });
    expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("timeline");
  });

  it("negative control: a saved arrangement is restored instead", async () => {
    // Without this, the case above would pass over a workspace that ignored the
    // record entirely and always opened one ledger.
    const store = memoryStore();
    await saveLayout(store, SESSION_ID, ["timeline", "runs"]);
    const { container } = renderWorkspace(store);
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(2);
    });
    expect(
      [...container.querySelectorAll("[data-body]")].map((body) => body.getAttribute("data-body")),
    ).toStrictEqual(["timeline", "runs"]);
  });

  it("saves the arrangement it opened, so the fallback ledger survives a restart", async () => {
    const store = memoryStore();
    renderWorkspace(store);
    await waitFor(async () => {
      const record = await store.read(SESSION_ID, DECK_LAYOUT_RECORD_KEY);
      expect(record).not.toBeUndefined();
    });
  });

  it("does not overwrite a saved arrangement with an empty deck", async () => {
    // The ordering failure this file exists for: a save that fired before the
    // restore completed would replace two panes with none, and the deck would look
    // exactly like a first run.
    const store = memoryStore();
    await saveLayout(store, SESSION_ID, ["timeline", "runs"]);
    const { container } = renderWorkspace(store);
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(2);
    });
    const record = await store.read(SESSION_ID, DECK_LAYOUT_RECORD_KEY);
    const value = record?.value as Record<string, unknown> | undefined;
    expect(Object.keys(value ?? {}).length).toBeGreaterThan(2);
  });

  it("renders what a restore refused inside the deck", async () => {
    const store = memoryStore();
    await store.write(SESSION_ID, DECK_LAYOUT_RECORD_KEY, "layout", {
      $deck: { version: 99, density: "standard" },
      "pane-1": { position: 0, kind: "timeline" },
    });
    const { container } = renderWorkspace(store);
    await waitFor(() => {
      // Scoped to the deck's own refusal strip: the announcer's polite region
      // carries `role="status"` too and renders above every surface.
      expect(
        container.querySelector('.meridian-deck__refusals[role="status"]')?.textContent,
      ).toContain("written by a different version");
    });
    // Discarded WHOLE: the deck falls back to the ledger rather than adopting the
    // pane the unknown record happened to name.
    expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
  });
});

describe("Workspace — navigating between two sessions the shell already has open", () => {
  /** Cycle deck focus, which commits an arrangement without opening or closing a pane. */
  function cycleDeckFocus(container: HTMLElement): void {
    const deck = container.querySelector(".meridian-deck");
    expect(deck).not.toBeNull();
    if (deck !== null) {
      fireEvent.keyDown(deck, { key: "ArrowRight", altKey: true });
    }
  }

  it("files a queued arrangement under the session that made it, not the one now on screen", async () => {
    // The defect: sessions are opened and never closed, so navigating straight from
    // one to another re-renders this component rather than remounting it. With the
    // writer's partition read at write time, the first session's queued arrangement
    // was filed under the second session's partition and overwrote its saved deck.
    const adapter = new GatedPersistenceAdapter();
    const store = new UiStateStore({ adapter });
    await saveLayout(store, SESSION_ID, ["timeline", "runs"]);
    await saveLayout(store, SESSION_B_ID, ["timeline"]);

    const first: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container, rerender } = render(workspaceFor(first, store, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(2);
    });

    // One write in flight against a closed gate, and a second arrangement waiting
    // behind it — the state a resize drag spends its whole length in.
    adapter.holdWrites();
    adapter.holdReads();
    // Twice: the first commit goes in flight against the closed gate, the second
    // lands in the writer's single pending slot. That slot is the whole subject —
    // it is what outlives the navigation below.
    cycleDeckFocus(container);
    cycleDeckFocus(container);
    await crossMacrotaskBoundary();
    const askedBeforeNavigation = adapter.asked.length;

    rerender(workspaceFor(otherSession(), store, false));
    // The arriving session's restore is held open, so the queued arrangement flushes
    // while the surface already shows the second session — the ordering decided here
    // rather than left to whichever promise happens to settle first.
    adapter.releaseWrites();
    await waitFor(() => {
      expect(adapter.asked.length).toBeGreaterThan(askedBeforeNavigation);
    });
    adapter.releaseReads();
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });

    const filedUnderSecond = adapter.asked.filter((write) => write.partition === SESSION_B_ID);
    expect(filedUnderSecond.length).toBeGreaterThan(0);
    expect(filedUnderSecond.map((write) => panesInRecord(write.value))).not.toContain(2);
  });

  it("starts the second session's deck from its own record, not the first one's panes", async () => {
    // The half with no race in it at all: the restore replaces wholesale but only
    // runs where a record exists, so a session with none used to inherit whatever
    // panes were already on screen — and then have them written under its own name.
    const store = memoryStore();
    await saveLayout(store, SESSION_ID, ["timeline", "runs"]);

    const first: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container, rerender } = render(workspaceFor(first, store, true));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(2);
    });

    rerender(workspaceFor(otherSession(), store, true));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });
    expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("timeline");
  });

  it("negative control: without the key the second session inherits the first one's deck", async () => {
    // Mounted at a stable position with no key, the subtree survives the navigation
    // and carries the arrangement with it. This is the case that makes the key above
    // an instrument rather than a decoration.
    const store = memoryStore();
    await saveLayout(store, SESSION_ID, ["timeline", "runs"]);

    const first: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container, rerender } = render(workspaceFor(first, store, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(2);
    });

    rerender(workspaceFor(otherSession(), store, false));
    await waitFor(async () => {
      const record = await store.read(SESSION_B_ID, DECK_LAYOUT_RECORD_KEY);
      expect(record).not.toBeUndefined();
    });
    expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(2);
  });
});
