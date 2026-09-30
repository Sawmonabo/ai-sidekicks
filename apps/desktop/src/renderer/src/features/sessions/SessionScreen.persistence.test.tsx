// The arrangement the session screen restores, the one it saves, and the session each is
// filed under. Persistence fails quietly in both directions: a restore that never ran leaves
// the arrangement on disk and invisible, and a save before the restore overwrites it with an
// empty pane layout, which looks like a first run. Sessions are opened and never closed, so
// moving between two re-renders this component and a queued arrangement can flush after the
// screen shows the other session.

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
    // Without this, the case above would pass over a screen that ignored the record.
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
    // A save before the restore completed would replace two panes with none, looking exactly
    // like a first run.
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
      // Scoped to the refusal strip: the announcer's polite region also has `role="status"`.
      expect(
        container.querySelector('.meridian-pane-layout__refusals[role="status"]')?.textContent,
      ).toContain("written by a different version");
    });
    // Discarded whole: the pane layout falls back to the transcript instead of adopting the
    // pane the unknown record named.
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
    // Navigating straight between sessions re-renders rather than remounts. With the writer's
    // partition read at write time, the first session's queued arrangement was filed under
    // the second's partition and overwrote its saved pane layout.
    const adapter = new GatedPersistenceAdapter();
    const store = new UiStateStore({ adapter });
    await saveLayout(store, SESSION_ID, ["transcript", "terminal"]);
    await saveLayout(store, SESSION_B_ID, ["transcript"]);

    const first: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };
    const { container, rerender } = render(workspaceFor(first, store, false));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(2);
    });

    // One write in flight against a closed gate and a second waiting behind it, as in a drag.
    adapter.holdWrites();
    adapter.holdReads();
    // Twice: the first commit goes in flight, the second lands in the writer's single pending
    // request, which is what outlives the navigation below.
    cyclePaneFocus(container);
    cyclePaneFocus(container);
    await crossMacrotaskBoundary();
    const askedBeforeNavigation = adapter.asked.length;

    rerender(workspaceFor(otherSession(), store, false));
    // The arriving session's restore is held open, so the queued arrangement flushes while the
    // screen shows the second session; the ordering is decided here.
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
    // No race here: the restore replaces wholesale but only where a record exists, so a
    // session with none once inherited the panes on screen and wrote them under its own name.
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
    // With no key the subtree survives the navigation and carries the arrangement along,
    // which is what makes the key above an instrument.
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
