// What the section's one read burst puts on screen, driving the real section over scripted
// daemon calls. The controls are in `RepoSection.controls.test.ts`.

import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { REPO_MOUNTS_NOT_READ_TITLE } from "./repo-mounts-copy.js";
import { sessionOperations } from "./repo-mounts.test-support.js";
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

describe("RepoSection — before the first read settles", () => {
  it("says it has not read, and draws no card", () => {
    // Nothing is advanced, so the read is still unmade.
    const section = renderSection(sessionOperations());

    expect(section.container.textContent).toContain(REPO_MOUNTS_NOT_READ_TITLE);
    expect(section.container.querySelectorAll(MOUNT_CARD_SELECTOR)).toHaveLength(0);
  });
});
