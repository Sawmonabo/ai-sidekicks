// What the section's one read burst puts on screen, and a card's way into the pane layout,
// driving the real section over scripted daemon calls.

import { fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HEALTHY_WORKSPACE_ID, sessionOperations } from "./repo-mounts.test-support.js";
import { MOUNT_CARD_SELECTOR, renderSection } from "./repo-section.test-support.js";

describe("RepoSection — the mounts this session actually holds", () => {
  it("draws a card per mount, each carrying its own health verdict", async () => {
    const section = renderSection(sessionOperations());

    await section.advanceUntil(() => {
      expect(section.container.querySelectorAll(MOUNT_CARD_SELECTOR)).toHaveLength(3);
    });
    // Health is the axis only `repo.mountRead` carries. One card of each verdict, the whole of
    // `RepoMountHealth.status`, so every rendering is reachable from one session.
    const [healthy, unreachable, drifted] = [
      ...section.container.querySelectorAll(MOUNT_CARD_SELECTOR),
    ];
    expect(within(healthy as HTMLElement).getByText("healthy")).toBeDefined();
    expect(within(unreachable as HTMLElement).getByText("unreachable")).toBeDefined();
    expect(within(drifted as HTMLElement).getByText("identity_mismatch")).toBeDefined();
    // Each card names its root, so the three are three mounts rather than one drawn thrice.
    const labels = [healthy, unreachable, drifted].map((card) => card?.getAttribute("aria-label"));
    expect(new Set(labels).size).toBe(3);
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
