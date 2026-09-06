// The workspace: what it composes, and what a cast chip press resolves to.
//
// Its other two subjects have files of their own. The arrangement it saves and
// restores is `Workspace.persistence.test.tsx`; the pane moved into a window of its
// own is `Workspace.auxiliary.test.tsx`. All three mount through the same shape, which
// lives once in `Workspace.test-support.tsx`.

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../bridge/index.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../core/index.js";
import { DraftStore } from "../persistence/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { FrameStore, SessionStore } from "../store/index.js";
import { registerActorFollowHandler, unregisterActorFollowHandler } from "../seats/index.js";
import { ACTOR_FOLLOW_ANNOUNCEMENTS } from "./cast-bar/actor-follow.js";
import { Workspace } from "./Workspace.js";
import {
  SCENARIO,
  SESSION_ID,
  WORKSPACE_TIMELINE_PANE_ID,
  memoryStore,
  renderWorkspace,
  sessionStore,
  testRegistry,
} from "./Workspace.test-support.js";

/** A store whose log already carries rows for the participant on the wheel. */
function sessionStoreWithRows(): SessionStore {
  const store = sessionStore();
  store.applyBatch([
    {
      id: "event-1",
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "user.message",
      occurredAt: "2026-01-01T09:01:00.000Z",
      actorId: "participant-you",
    },
    {
      id: "event-2",
      sessionId: SESSION_ID,
      sequence: 2,
      kind: "user.message",
      occurredAt: "2026-01-01T09:02:00.000Z",
      actorId: "participant-you",
    },
  ]);
  return store;
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

describe("Workspace — the sidebar it composes beside the deck", () => {
  it("mounts the session sidebar, which nothing else in the console does", async () => {
    // The gap this composition closes: every family registers into the sidebar seat,
    // and until the workspace rendered the column there was no surface those sections
    // could ever appear on.
    const { container } = renderWorkspace(memoryStore());
    await waitFor(() => {
      expect(container.querySelector(".meridian-sidebar")).not.toBeNull();
    });
    expect(container.querySelectorAll("[data-sidebar-section]")).toHaveLength(8);
  });

  it("nests the deck's own group inside the split rather than replacing it", async () => {
    // Two groups, and the deck's is untouched: a sidebar drag resizes the split and a
    // pane drag resizes the deck, so neither gesture reaches the other's record.
    const { container } = renderWorkspace(memoryStore());
    await waitFor(() => {
      expect(container.querySelector(".meridian-deck__pane")).not.toBeNull();
    });
    const split = container.querySelector(".meridian-workspace__split");
    expect(split).not.toBeNull();
    expect(split?.querySelector(".meridian-deck__group")).not.toBeNull();
    expect(split?.querySelector(".meridian-sidebar")).not.toBeNull();
  });

  it("negative control: a route with no session store composes no sidebar", async () => {
    // Without this the cases above would pass over a workspace that rendered the column
    // whether or not there was a session for its sections to be a view of.
    // The two providers the frame mounts above every surface, over one bridge: the
    // deck reads the window's clock off the resolved one.
    const bridge = createFixtureBridge({ scenario: SCENARIO });
    const { container } = render(
      <SidekicksBridgeProvider bridge={bridge}>
        <LiveAnnouncerProvider>
          <Workspace
            bridge={bridge}
            frameStore={new FrameStore({ initialRoute: { kind: "sessions" } })}
            sessionStore={undefined}
            uiStateStore={memoryStore()}
            draftStore={new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT })}
            route={{ kind: "sessions" }}
            registry={testRegistry()}
          />
        </LiveAnnouncerProvider>
      </SidekicksBridgeProvider>,
    );
    await waitFor(() => {
      expect(container.querySelector(".meridian-workspace__split")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-sidebar")).toBeNull();
  });
});

describe("Workspace — following an actor from the cast bar", () => {
  afterEach(() => {
    unregisterActorFollowHandler(WORKSPACE_TIMELINE_PANE_ID);
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
    registerActorFollowHandler(WORKSPACE_TIMELINE_PANE_ID, follow);
    const { container } = renderWorkspace(memoryStore(), sessionStoreWithRows());
    await waitFor(() => {
      expect(container.querySelector(".meridian-cast-chip")).not.toBeNull();
    });

    // The seat is keyed by pane, so the constant above is only right while the deck
    // holds the one pane the workspace opened. Asserted rather than assumed.
    expect(container.querySelectorAll(".meridian-deck__pane")).toHaveLength(1);
    pressFirstChip(container);

    expect(follow).toHaveBeenCalledWith({
      participantId: "participant-you",
      newestSequence: 2,
    });
    expect(politeText(container)).toBe("");
  });

  it("says so rather than doing nothing when the participant has no row", async () => {
    const follow = vi.fn().mockReturnValue("revealed");
    registerActorFollowHandler(WORKSPACE_TIMELINE_PANE_ID, follow);
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
