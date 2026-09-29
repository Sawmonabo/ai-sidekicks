// The controls the section and its rows carry: the section's one mutating entry point, and a
// card's way into the pane layout. Both mount the real section over scripted daemon calls, which is
// why the mount and the container selectors they share live in
// `repo-section.test-support.tsx`.

import { fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderSection } from "./repo-section.test-support.js";
import { HEALTHY_WORKSPACE_ID, sessionOperations } from "./repo-mounts.test-support.js";

describe("RepoSection — the one mutating entry point", () => {
  it("offers the attach on the section itself, above the mounts it already holds", async () => {
    // Before this the section could only ever REPORT repositories: `repo.attach` is a
    // registered daemon method and the console had no control that reached it, so a
    // session's first repository could not be started from the desktop at all.
    const section = renderSection(sessionOperations());

    await section.advanceUntil(() => {
      expect(within(section.container).getByText("Attach a repository")).toBeDefined();
    });
  });

  it("negative control: the empty-mount card no longer sends a person to another client", async () => {
    // The card used to say attaching was reached through the command-line and SDK
    // surfaces, which was true of this console and false of the wire.
    const section = renderSection(sessionOperations());

    await section.advanceUntil(() => {
      expect(within(section.container).getByText("Attach a repository")).toBeDefined();
    });
    expect(section.container.textContent).not.toContain("command-line and SDK");
  });
});

describe("RepoSection — a card's way into the pane layout", () => {
  it("opens a diff pane at the row's own address, in the pane layout it was handed", async () => {
    // THE OPENER IS THE SEAT'S AND NOT A MODULE THIS FAMILY IMPORTS, which is what the
    // section is proving here: a sidebar rendered in an auxiliary window opens its panes
    // in THAT window's pane layout, so every card's press has to arrive back through this
    // callback rather than through anything the family reached for itself.
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
