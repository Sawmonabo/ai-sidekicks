// The arrangement the session screen restores, the one it saves, and the session each is
// filed under.
//
// The persistence pair is the risky half and it fails quietly in both directions — a
// restore that never ran leaves a person's arrangement on disk and invisible, and a
// save that runs before the restore OVERWRITES it with an empty pane layout. Both look like
// "the pane layout opened with one pane", which is also what success looks like the first
// time.
//
// Navigating between two open sessions is that same failure with a second partition in
// it. Sessions are opened and never closed, so moving from one to another re-renders
// this component rather than remounting it, and a queued arrangement can flush after
// the screen already shows somebody else's session.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { PANE_LAYOUT_RECORD_KEY } from "./pane-layout/layout-persistence.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import {
  GatedPersistenceAdapter,
  SESSION_B_ID,
  SESSION_ID,
  memoryStore,
  otherSession,
  renderSessionScreen,
  saveLayout,
  sessionStore,
  workspaceFor,
  type SessionWithStore,
} from "./SessionScreen.test-support.js";

/** How many panes a saved pane layout record holds. Its one non-pane key is `$paneLayout`. */
function panesInRecord(value: unknown): number {
  return Object.keys(value as Record<string, unknown>).length - 1;
}

describe("SessionScreen — the saved arrangement", () => {
  it("opens the transcript alone when nothing was saved", async () => {
    const { container } = renderSessionScreen(memoryStore());
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(1);
    });
    expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("transcript");
  });

  it("negative control: a saved arrangement is restored instead", async () => {
    // Without this, the case above would pass over a session screen that ignored the
    // record entirely and always opened one transcript.
    const store = memoryStore();
    await saveLayout(store, SESSION_ID, ["transcript", "terminal"]);
    const { container } = renderSessionScreen(store);
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
    });
    expect(
      [...container.querySelectorAll("[data-body]")].map((body) => body.getAttribute("data-body")),
    ).toStrictEqual(["transcript", "terminal"]);
  });

  it("saves the arrangement it opened, so the fallback transcript survives a restart", async () => {
    const store = memoryStore();
    renderSessionScreen(store);
    await waitFor(async () => {
      const record = await store.read(SESSION_ID, PANE_LAYOUT_RECORD_KEY);
      expect(record).not.toBeUndefined();
    });
  });

  it("does not overwrite a saved arrangement with an empty pane layout", async () => {
    // The ordering failure this file exists for: a save that fired before the
    // restore completed would replace two panes with none, and the pane layout would look
    // exactly like a first run.
    const store = memoryStore();
    await saveLayout(store, SESSION_ID, ["transcript", "terminal"]);
    const { container } = renderSessionScreen(store);
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
    });
    const record = await store.read(SESSION_ID, PANE_LAYOUT_RECORD_KEY);
    const value = record?.value as Record<string, unknown> | undefined;
    expect(Object.keys(value ?? {}).length).toBeGreaterThan(2);
  });

  it("renders what a restore refused inside the pane layout", async () => {
    const store = memoryStore();
    await store.write(SESSION_ID, PANE_LAYOUT_RECORD_KEY, "layout", {
      $paneLayout: { version: 99, density: "standard" },
      "pane-1": { position: 0, kind: "transcript" },
    });
    const { container } = renderSessionScreen(store);
    await waitFor(() => {
      // Scoped to the pane layout's own refusal strip: the announcer's polite region
      // carries `role="status"` too and renders above every view.
      expect(
        container.querySelector('.meridian-pane-layout__refusals[role="status"]')?.textContent,
      ).toContain("written by a different version");
    });
    // Discarded WHOLE: the pane layout falls back to the transcript rather than adopting the
    // pane the unknown record happened to name.
    expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(1);
  });
});

describe("SessionScreen — navigating between two sessions the window already has open", () => {
  /** Cycle pane layout focus, which commits an arrangement without opening or closing a pane. */
  function cyclePaneFocus(container: HTMLElement): void {
    const paneLayoutElement = container.querySelector(".meridian-pane-layout");
    expect(paneLayoutElement).not.toBeNull();
    if (paneLayoutElement !== null) {
      fireEvent.keyDown(paneLayoutElement, { key: "ArrowRight", altKey: true });
    }
  }

  it("files a queued arrangement under the session that made it, not the one now on screen", async () => {
    // The defect: sessions are opened and never closed, so navigating straight from
    // one to another re-renders this component rather than remounting it. With the
    // writer's partition read at write time, the first session's queued arrangement
    // was filed under the second session's partition and overwrote its saved pane layout.
    const adapter = new GatedPersistenceAdapter();
    const store = new UiStateStore({ adapter });
    await saveLayout(store, SESSION_ID, ["transcript", "terminal"]);
    await saveLayout(store, SESSION_B_ID, ["transcript"]);

    const first: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };
    const { container, rerender } = render(workspaceFor(first, store, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
    });

    // One write in flight against a closed gate, and a second arrangement waiting
    // behind it — the state a resize drag spends its whole length in.
    adapter.holdWrites();
    adapter.holdReads();
    // Twice: the first commit goes in flight against the closed gate, the second
    // lands in the writer's single pending request. That request is the whole subject —
    // it is what outlives the navigation below.
    cyclePaneFocus(container);
    cyclePaneFocus(container);
    await crossMacrotaskBoundary();
    const askedBeforeNavigation = adapter.asked.length;

    rerender(workspaceFor(otherSession(), store, false));
    // The arriving session's restore is held open, so the queued arrangement flushes
    // while the screen already shows the second session — the ordering decided here
    // rather than left to whichever promise happens to settle first.
    adapter.releaseWrites();
    await waitFor(() => {
      expect(adapter.asked.length).toBeGreaterThan(askedBeforeNavigation);
    });
    adapter.releaseReads();
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(1);
    });

    const filedUnderSecond = adapter.asked.filter((write) => write.partition === SESSION_B_ID);
    expect(filedUnderSecond.length).toBeGreaterThan(0);
    expect(filedUnderSecond.map((write) => panesInRecord(write.value))).not.toContain(2);
  });

  it("starts the second session's pane layout from its own record, not the first one's panes", async () => {
    // The half with no race in it at all: the restore replaces wholesale but only
    // runs where a record exists, so a session with none used to inherit whatever
    // panes were already on screen — and then have them written under its own name.
    const store = memoryStore();
    await saveLayout(store, SESSION_ID, ["transcript", "terminal"]);

    const first: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };
    const { container, rerender } = render(workspaceFor(first, store, true));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
    });

    rerender(workspaceFor(otherSession(), store, true));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(1);
    });
    expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("transcript");
  });

  it("negative control: without the key the second session inherits the first one's pane layout", async () => {
    // Mounted at a stable position with no key, the subtree survives the navigation
    // and carries the arrangement with it. This is the case that makes the key above
    // an instrument rather than a decoration.
    const store = memoryStore();
    await saveLayout(store, SESSION_ID, ["transcript", "terminal"]);

    const first: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };
    const { container, rerender } = render(workspaceFor(first, store, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
    });

    rerender(workspaceFor(otherSession(), store, false));
    await waitFor(async () => {
      const record = await store.read(SESSION_B_ID, PANE_LAYOUT_RECORD_KEY);
      expect(record).not.toBeUndefined();
    });
    expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
  });
});
