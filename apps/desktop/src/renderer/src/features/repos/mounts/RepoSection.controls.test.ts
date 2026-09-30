// The controls the section carries: its one mutating entry point, and a card's way into the
// pane layout. Both mount the real section over scripted daemon calls
// (`repo-section.test-support.tsx`).

import { fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderSection } from "./repo-section.test-support.js";
import { HEALTHY_WORKSPACE_ID, sessionOperations } from "./repo-mounts.test-support.js";

describe("RepoSection — the one mutating entry point", () => {
  it("offers the attach on the section itself, above the mounts it already holds", async () => {
    // `repo.attach` is a registered daemon method, and without this control a session's first
    // repository could not be started from the desktop.
    const section = renderSection(sessionOperations());

    await section.advanceUntil(() => {
      expect(within(section.container).getByText("Attach a repository")).toBeDefined();
    });
  });

  it("negative control: the empty-mount card no longer sends a person to another client", async () => {
    // A card saying attaching is reached through the command-line and SDK clients would be
    // true of this console and false of the wire.
    const section = renderSection(sessionOperations());

    await section.advanceUntil(() => {
      expect(within(section.container).getByText("Attach a repository")).toBeDefined();
    });
    expect(section.container.textContent).not.toContain("command-line and SDK");
  });
});

describe("RepoSection — a card's way into the pane layout", () => {
  it("opens a diff pane at the row's own address, in the pane layout it was handed", async () => {
    // The opener is handed in by the pane layout, not imported: a sidebar in an auxiliary
    // window opens its panes in that window's layout, so every press must arrive through this
    // callback.
    const openPane = vi.fn();
    const section = renderSection(sessionOperations(), openPane);
    await section.advanceUntil(() => {
      expect(
        within(section.container).getByLabelText(
          `Open the changes of workspace ${HEALTHY_WORKSPACE_ID}`,
        ),
      ).toBeDefined();
    });
    fireEvent.click(
      within(section.container).getByLabelText(
        `Open the changes of workspace ${HEALTHY_WORKSPACE_ID}`,
      ),
    );
    expect(openPane).toHaveBeenCalledWith({
      kind: "diff",
      entity: { kind: "workspace", id: HEALTHY_WORKSPACE_ID },
    });
  });
});
