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

import { DECK_RESTORED_PANE_CAP } from "../core/index.js";
import { UiStateStore } from "../persistence/index.js";
import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import type { StoredRecord } from "../persistence/adapter.js";
import { DeckLayout } from "./deck/deck-layout.js";
import {
  SESSION_B_ID,
  SESSION_ID,
  memoryStore,
  otherSession,
  renderWorkspace,
  sessionStore,
  workspaceFor,
  type WorkspaceSession,
} from "./Workspace.test-support.js";

const DECK_LAYOUT_RECORD_KEY = "deck-layout";

/**
 * The memory adapter, plus a gate a test closes and a ledger of what was asked.
 *
 * Two things the plain adapter cannot give. The GATE holds a write open, which is
 * what puts a second arrangement in the writer's pending slot — the state a coalescing
 * writer spends a whole resize drag in, and the only state in which the partition it
 * files under can disagree with the one that asked. The LEDGER records the partition
 * every write NAMED, so the assertion is about where an arrangement was filed rather
 * than about which record happened to be written last.
 */
class GatedPersistenceAdapter extends MemoryPersistenceAdapter {
  readonly asked: { readonly partition: string; readonly value: unknown }[] = [];
  #writeGate = new SettlementGate();
  #readGate = new SettlementGate();

  public holdWrites(): void {
    this.#writeGate.close();
  }

  public releaseWrites(): void {
    this.#writeGate.open();
  }

  /** Holds the arriving session's restore open, so the ordering is decided here. */
  public holdReads(): void {
    this.#readGate.close();
  }

  public releaseReads(): void {
    this.#readGate.open();
  }

  public override async read(partition: string, key: string): Promise<StoredRecord | undefined> {
    await this.#readGate.passed();
    return super.read(partition, key);
  }

  public override async write(record: StoredRecord): Promise<void> {
    this.asked.push({ partition: record.partition, value: record.value });
    await this.#writeGate.passed();
    await super.write(record);
  }
}

/** One gate a test opens and closes. Open by default, so nothing waits by accident. */
class SettlementGate {
  #held: Promise<void> | undefined;
  #open: (() => void) | undefined;

  public close(): void {
    this.#held = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  public open(): void {
    this.#open?.();
    this.#open = undefined;
    this.#held = undefined;
  }

  public async passed(): Promise<void> {
    await this.#held;
  }
}

/** Let the write pump's `finally` chain run, without advancing any timer. */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

/** How many panes a saved deck record holds. Its one non-pane key is `$deck`. */
function panesInRecord(value: unknown): number {
  return Object.keys(value as Record<string, unknown>).length - 1;
}

/** A saved arrangement for one session, written by the grammar that reads it back. */
async function saveLayout(
  store: UiStateStore,
  partition: string,
  kinds: readonly ("timeline" | "runs")[],
): Promise<void> {
  const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
  for (const kind of kinds) {
    layout.open({ kind, entity: undefined });
  }
  const result = await store.write(
    partition,
    DECK_LAYOUT_RECORD_KEY,
    "layout",
    layout.toSnapshot(),
  );
  expect(result.outcome).toBe("written");
}

/** A saved arrangement, written by the same grammar that reads it back. */
async function saveTwoPaneLayout(store: UiStateStore): Promise<void> {
  const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
  layout.open({ kind: "timeline", entity: undefined });
  layout.open({ kind: "runs", entity: undefined });
  const result = await store.write(
    SESSION_ID,
    DECK_LAYOUT_RECORD_KEY,
    "layout",
    layout.toSnapshot(),
  );
  expect(result.outcome).toBe("written");
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
    await saveTwoPaneLayout(store);
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
    await saveTwoPaneLayout(store);
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
    await drainMicrotasks();
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
