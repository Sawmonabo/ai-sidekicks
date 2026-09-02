// The workspace: the arrangement it restores, the one it saves, and the ledger it
// falls back to.
//
// The persistence pair is the risky half and it fails quietly in both directions —
// a restore that never ran leaves a person's arrangement on disk and invisible, and
// a save that runs before the restore OVERWRITES it with an empty deck. Both look
// like "the deck opened with one pane", which is also what success looks like the
// first time.

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../core/index.js";
import { createFixtureBridge, type ConsoleBridge, type GrowthPort } from "../bridge/index.js";
import type { ConsoleScenario } from "../bridge/scenario.js";
import { DraftStore, UiStateStore } from "../persistence/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import type { StoredRecord } from "../persistence/adapter.js";
import { FrameStore, SessionStore } from "../store/index.js";
import {
  ConsolePaneRegistry,
  registerActorFollowHandler,
  unregisterActorFollowHandler,
} from "./seats/index.js";
import { ACTOR_FOLLOW_ANNOUNCEMENTS } from "./actor-follow.js";
import { Workspace } from "./Workspace.js";
import { DeckLayout } from "./deck/deck-layout.js";
import { usePaneControls } from "./deck/pane-controls.js";

const SESSION_ID = "session-workspace";
const DECK_LAYOUT_RECORD_KEY = "deck-layout";

const SCENARIO: ConsoleScenario = {
  id: "workspace",
  label: "Workspace",
  purpose: "Drives the workspace surface's composition.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you"],
  startedAtIso: "2026-01-01T09:00:00.000Z",
  beats: [],
  replies: [],
};

/**
 * A body that says which kind it is, and offers the host's own detach control.
 *
 * The control is read off `usePaneControls`, which is the seam a real pane header
 * reads it from — so a case that presses it drives the workspace through the same
 * path a person does, rather than through a callback the test invented.
 */
function TestPaneBody(props: { readonly kind: string }): React.JSX.Element {
  const controls = usePaneControls();
  return (
    <p data-body={props.kind}>
      {props.kind} body
      {controls?.onOpenInWindow === undefined ? null : (
        <button type="button" data-detach={props.kind} onClick={controls.onOpenInWindow}>
          Open in a window
        </button>
      )}
    </p>
  );
}

/** A registry whose bodies say which kind they are, so a pane is identifiable. */
function testRegistry(): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  for (const kind of ["timeline", "runs"] as const) {
    registry.register({
      kind,
      owner: "workspace-test",
      openInWindow: kind === "timeline",
      render: () => <TestPaneBody kind={kind} />,
    });
  }
  return registry;
}

function sessionStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: ["participant-you"] });
  return store;
}

/** A store whose log already carries rows for the participant on the wheel. */
function sessionStoreWithRows(): SessionStore {
  const store = sessionStore();
  store.applyBatch([
    {
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "user.message",
      occurredAt: "2026-01-01T09:01:00.000Z",
      actorParticipantId: "participant-you",
    },
    {
      sessionId: SESSION_ID,
      sequence: 2,
      kind: "user.message",
      occurredAt: "2026-01-01T09:02:00.000Z",
      actorParticipantId: "participant-you",
    },
  ]);
  return store;
}

interface RenderedWorkspace {
  readonly container: HTMLElement;
  readonly uiStateStore: UiStateStore;
}

/** One session the workspace can be pointed at, with the store it renders. */
interface WorkspaceSession {
  readonly sessionId: string;
  readonly store: SessionStore;
}

const SESSION_B_ID = "session-workspace-b";

/**
 * The workspace under the window's announcer, which is where `AppFrame` mounts it.
 *
 * The deck inside reads `useAnnounce` to say what a pane drop settled on, and that
 * hook throws outside the provider by design — so this wrapper is the production
 * mount shape rather than test scaffolding.
 */
function renderWorkspace(uiStateStore: UiStateStore, store?: SessionStore): RenderedWorkspace {
  const { container } = render(
    <LiveAnnouncerProvider>
      <Workspace
        bridge={createFixtureBridge({ scenario: SCENARIO })}
        frameStore={new FrameStore({ initialRoute: { kind: "workspace", sessionId: SESSION_ID } })}
        sessionStore={store ?? sessionStore()}
        uiStateStore={uiStateStore}
        draftStore={new DraftStore()}
        route={{ kind: "workspace", sessionId: SESSION_ID }}
        registry={testRegistry()}
      />
    </LiveAnnouncerProvider>,
  );
  return { container, uiStateStore };
}

function memoryStore(): UiStateStore {
  return new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
}

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

/** A second session, with a store of its own — never the first one's. */
function otherSession(): WorkspaceSession {
  const store = new SessionStore({ sessionId: SESSION_B_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: ["participant-you"] });
  return { sessionId: SESSION_B_ID, store };
}

/** The workspace for one session, in the shape `AppFrame` mounts it in. */
function workspaceFor(
  session: WorkspaceSession,
  uiStateStore: UiStateStore,
  isKeyed: boolean,
  bridge: ConsoleBridge = createFixtureBridge({ scenario: SCENARIO }),
): React.JSX.Element {
  return (
    <LiveAnnouncerProvider>
      <Workspace
        {...(isKeyed ? { key: session.sessionId } : {})}
        bridge={bridge}
        frameStore={
          new FrameStore({ initialRoute: { kind: "workspace", sessionId: session.sessionId } })
        }
        sessionStore={session.store}
        uiStateStore={uiStateStore}
        draftStore={new DraftStore()}
        route={{ kind: "workspace", sessionId: session.sessionId }}
        registry={testRegistry()}
      />
    </LiveAnnouncerProvider>
  );
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

describe("Workspace — what it composes", () => {
  it("renders the cast bar above the deck", async () => {
    const { container } = renderWorkspace(memoryStore());
    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__pane")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-cast-bar")).not.toBeNull();
    expect(container.querySelector(".meridian-cast-bar")?.textContent).toContain(SESSION_ID);
  });
});

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

describe("Workspace — following an actor from the cast bar", () => {
  afterEach(() => {
    unregisterActorFollowHandler();
  });

  /** Press the first chip in the bar, the way a person does. */
  function pressFirstChip(container: HTMLElement): void {
    const chip = container.querySelector<HTMLButtonElement>(".meridian-cast-chip");
    expect(chip).not.toBeNull();
    // Inside `act`, because the announcement the press raises is committed by the
    // announcer's own render pass and the assertions below read the live region.
    act(() => {
      chip?.click();
    });
  }

  function politeText(container: HTMLElement): string {
    return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
  }

  it("sends the actor's newest row through the ledger's follow seat", async () => {
    // The defect: the press only focused a pane, and in a deck holding one timeline
    // that pane was already focused — so following an actor moved nothing at all.
    const follow = vi.fn().mockReturnValue("revealed");
    registerActorFollowHandler("workspace-test", follow);
    const { container } = renderWorkspace(memoryStore(), sessionStoreWithRows());
    await waitFor(() => {
      expect(container.querySelector(".meridian-cast-chip")).not.toBeNull();
    });

    pressFirstChip(container);

    expect(follow).toHaveBeenCalledWith({
      participantId: "participant-you",
      newestSequence: 2,
    });
    expect(politeText(container)).toBe("");
  });

  it("says so rather than doing nothing when the participant has no row", async () => {
    const follow = vi.fn().mockReturnValue("revealed");
    registerActorFollowHandler("workspace-test", follow);
    const { container } = renderWorkspace(memoryStore());
    await waitFor(() => {
      expect(container.querySelector(".meridian-cast-chip")).not.toBeNull();
    });

    pressFirstChip(container);

    expect(follow).not.toHaveBeenCalled();
    expect(politeText(container)).toBe(ACTOR_FOLLOW_ANNOUNCEMENTS["no-activity"]);
  });

  // The negative control: with rows present but no ledger filling the seat, the press
  // says which of the two absences it hit. Without it the case above would pass over a
  // workspace that announced "nothing yet" for every press it could not complete.
  it("negative control: names the missing ledger rather than the missing row", async () => {
    const { container } = renderWorkspace(memoryStore(), sessionStoreWithRows());
    await waitFor(() => {
      expect(container.querySelector(".meridian-cast-chip")).not.toBeNull();
    });

    pressFirstChip(container);

    expect(politeText(container)).toBe(ACTOR_FOLLOW_ANNOUNCEMENTS["no-ledger"]);
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

describe("Workspace — a pane moved into a window of its own", () => {
  /** The fixture bridge, with the window operations this case needs served. */
  function bridgeServingWindowWire(overrides: Partial<GrowthPort>): ConsoleBridge {
    const base = createFixtureBridge({ scenario: SCENARIO });
    return { ...base, growth: { ...base.growth, ...overrides } };
  }

  const detachingPort: Partial<GrowthPort> = {
    windowDetachPane: async () => ({ status: "served", value: { windowId: "aux-1" } }),
    windowCloseAuxiliary: async () => ({ status: "served", value: undefined }),
  };

  /** Press the detach control the pane body offers, the way a header does. */
  function pressDetach(container: HTMLElement): void {
    const control = container.querySelector<HTMLButtonElement>("[data-detach='timeline']");
    expect(control).not.toBeNull();
    act(() => {
      control?.click();
    });
  }

  function placeholderText(container: HTMLElement): string {
    return container.querySelector(".meridian-deck__detached")?.textContent ?? "";
  }

  it("keeps the pane's slot and suppresses only its projection", async () => {
    // The defect: a successful detach closed the pane, so the layout filtered it out
    // and the window closing or crashing had no slot to return it to.
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(session, store, true, bridgeServingWindowWire(detachingPort)),
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });

    pressDetach(container);

    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__detached")).not.toBeNull();
    });
    expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    expect(container.querySelector("[data-body]")).toBeNull();
    expect(placeholderText(container)).toContain("window of its own");
  });

  it("returns the projection to the same slot when the pane comes back", async () => {
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(session, store, true, bridgeServingWindowWire(detachingPort)),
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });
    pressDetach(container);
    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__detached")).not.toBeNull();
    });

    const returnControl = [
      ...container.querySelectorAll<HTMLButtonElement>(".meridian-deck__detached-control"),
    ].find((button) => button.textContent === "Return it to the deck");
    expect(returnControl).not.toBeUndefined();
    act(() => {
      returnControl?.click();
    });

    await waitFor(() => {
      expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("timeline");
    });
    expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
  });

  it("renders the refusal where the crashed-window signal is not served", async () => {
    // A subscription this build cannot open is not the same fact as a window that has
    // not crashed. The placeholder says which of the two it is.
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(session, store, true, bridgeServingWindowWire(detachingPort)),
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });

    pressDetach(container);

    await waitFor(() => {
      expect(placeholderText(container)).toContain("is not registered yet");
    });
    // The refusal renders in the slot it is about, carrying its own code.
    expect(
      container.querySelector(".meridian-deck__detached .meridian-refusal")?.textContent,
    ).toContain("wire-unregistered");
  });

  it("negative control: a pane nobody detached renders its projection unchanged", async () => {
    // Without this, every case above would pass over a deck that drew the placeholder
    // for every pane it held.
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const { container } = render(
      workspaceFor(session, store, true, bridgeServingWindowWire(detachingPort)),
    );
    await waitFor(() => {
      expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("timeline");
    });
    expect(container.querySelector(".meridian-deck__detached")).toBeNull();
  });

  it("does not carry a detached pane into another session", async () => {
    const store = memoryStore();
    const session: WorkspaceSession = { sessionId: SESSION_ID, store: sessionStore() };
    const bridge = bridgeServingWindowWire(detachingPort);
    const { container, rerender } = render(workspaceFor(session, store, true, bridge));
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    });
    pressDetach(container);
    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__detached")).not.toBeNull();
    });

    rerender(workspaceFor(otherSession(), store, true, bridge));

    await waitFor(() => {
      expect(container.querySelector("[data-body]")?.getAttribute("data-body")).toBe("timeline");
    });
    expect(container.querySelector(".meridian-deck__detached")).toBeNull();
  });
});
