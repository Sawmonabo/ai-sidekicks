// The workspace: the arrangement it restores, the one it saves, and the ledger it
// falls back to.
//
// The persistence pair is the risky half and it fails quietly in both directions —
// a restore that never ran leaves a person's arrangement on disk and invisible, and
// a save that runs before the restore OVERWRITES it with an empty deck. Both look
// like "the deck opened with one pane", which is also what success looks like the
// first time.

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../core/index.js";
import { createFixtureBridge } from "../bridge/index.js";
import type { ConsoleScenario } from "../bridge/scenario.js";
import { DraftStore, UiStateStore } from "../persistence/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import { FrameStore, SessionStore } from "../store/index.js";
import {
  ConsolePaneRegistry,
  registerActorFollowHandler,
  unregisterActorFollowHandler,
} from "./seats/index.js";
import { ACTOR_FOLLOW_ANNOUNCEMENTS } from "./actor-follow.js";
import { Workspace } from "./Workspace.js";
import { DeckLayout } from "./deck/deck-layout.js";

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

/** A registry whose bodies say which kind they are, so a pane is identifiable. */
function testRegistry(): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  for (const kind of ["timeline", "runs"] as const) {
    registry.register({
      kind,
      owner: "workspace-test",
      openInWindow: kind === "timeline",
      render: () => <p data-body={kind}>{kind} body</p>,
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
      [...container.querySelectorAll("[data-body]")].map((body) => body.textContent),
    ).toStrictEqual(["timeline body", "runs body"]);
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
