// The arrangement the session screen restores and the session it is filed under, through the
// mounted screen. Sessions are opened and never closed, so moving between two re-renders this
// component and a queued arrangement can flush after the screen shows the other session.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { windowDiagnosticCapture } from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
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
  let detachForwarder: (() => void) | undefined;

  afterEach(() => {
    detachForwarder?.();
    detachForwarder = undefined;
  });

  it("records what a restore refused in the window's diagnostics and draws none of it", async () => {
    windowDiagnosticCapture.flush();
    const batches: string[] = [];
    detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    batches.length = 0;
    const store = memoryStore();
    await store.write(SESSION_ID, PANE_LAYOUT_RECORD_KEY, "layout", {
      $paneLayout: { version: 99, density: "standard" },
      "pane-1": { position: 0, kind: "transcript" },
    });
    const { container } = renderSessionScreen(store);
    // Discarded whole: the pane layout falls back to the transcript instead of adopting the
    // pane the unknown record named.
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-pane-layout__pane")).toHaveLength(1);
    });
    windowDiagnosticCapture.flush();
    const restoreRecords = batches
      .flatMap((batch) => batch.split("\n"))
      .map((line) => JSON.parse(line) as { kind: string; detail: string })
      .filter((record) => record.kind === "pane-layout-not-restored")
      .map((record) => record.detail);
    expect(restoreRecords).toStrictEqual([`session ${SESSION_ID}: snapshot-version-unknown`]);
    expect(container.textContent).not.toContain("written by a different version");
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
    // Navigating straight between sessions re-renders rather than remounts, so the writer must
    // take the partition with the request, not read it at write time, or the first session's
    // queued arrangement would land in the second's partition over its saved pane layout.
    const adapter = new GatedPersistenceAdapter();
    const store = new UiStateStore({ adapter });
    await saveLayout(store, SESSION_ID, ["transcript", "terminal"]);
    await saveLayout(store, SESSION_B_ID, ["transcript"]);

    const first: SessionWithStore = { sessionId: SESSION_ID, store: sessionStore() };
    const { container, rerender } = render(workspaceFor(first, store));
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

    rerender(workspaceFor(otherSession(), store));
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
});
