// The workspace: what it composes.
//
// Its other two subjects have files of their own. The arrangement it saves and
// restores is `Workspace.persistence.test.tsx`; the pane moved into a window of its
// own is `Workspace.auxiliary.test.tsx`. All three mount through the same shape, which
// lives once in `Workspace.test-support.tsx`.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../core/index.js";
import { DraftStore } from "../persistence/index.js";
import { FrameStore } from "../store/index.js";
import { Workspace } from "./Workspace.js";
import {
  SCENARIO,
  SESSION_ID,
  memoryStore,
  renderWorkspace,
  testRegistry,
  underWindowProviders,
} from "./Workspace.test-support.js";

describe("Workspace — what it composes", () => {
  it("renders the session header above the deck", async () => {
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
    expect(container.querySelectorAll("[data-sidebar-section]")).toHaveLength(7);
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
    // Through the family's own mount shape rather than a copy of it: what a window
    // puts above a workspace — the bridge providers, the announcer, and the
    // frame-lifetime binding — is one thing, and a second spelling of it here rendered
    // a workspace with no binding above it.
    const bridge = createFixtureBridge({ scenario: SCENARIO });
    const { container } = render(
      underWindowProviders(
        bridge,
        <Workspace
          bridge={bridge}
          frameStore={new FrameStore({ initialRoute: { kind: "sessions" } })}
          sessionStore={undefined}
          uiStateStore={memoryStore()}
          draftStore={new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT })}
          route={{ kind: "sessions" }}
          paneRegistry={testRegistry()}
        />,
      ),
    );
    await waitFor(() => {
      expect(container.querySelector(".meridian-workspace__split")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-sidebar")).toBeNull();
  });
});
