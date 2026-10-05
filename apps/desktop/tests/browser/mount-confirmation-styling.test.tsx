// The browser tier: a mounts confirmation draws as a dialog. Its trigger, backdrop and popup take
// their whole treatment from the global sheets beside their own class, so a sheet nothing loads
// leaves the popup in the page's flow under a native button; only a real engine's cascade shows
// which rules reached the element.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RootRemovalConfirmation } from "#renderer/features/repos/mounts/execution-roots/removal/RootRemovalConfirmation.js";
import { scriptedRepoOperations } from "#renderer/features/repos/repo-operations.test-support.js";
import { bridgeOnClock } from "../helpers/fixture/bridge.js";

const WORKTREE_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

afterEach(() => {
  cleanup();
});

describe("browser — a mounts confirmation wears the shared dialog and button treatments", () => {
  it("lays the backdrop over the window and centers the popup above it", async () => {
    render(
      <RootRemovalConfirmation
        bridge={bridgeOnClock("repos").bridge}
        operations={scriptedRepoOperations()}
        rootId={WORKTREE_ID}
      />,
    );
    const trigger = screen.getByRole("button", { name: `Remove ${WORKTREE_ID}` });
    expect(getComputedStyle(trigger).borderTopStyle).toBe("solid");
    expect(getComputedStyle(trigger).cursor).toBe("pointer");

    await act(async () => {
      trigger.click();
    });

    const popup = await screen.findByRole("alertdialog");
    const backdrop = popup.ownerDocument.querySelector(".meridian-dialog__backdrop");
    expect(backdrop).not.toBeNull();
    expect(getComputedStyle(backdrop as Element).position).toBe("fixed");
    expect(getComputedStyle(popup).position).toBe("fixed");
    const box = popup.getBoundingClientRect();
    expect(Math.abs(box.left + box.width / 2 - window.innerWidth / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.top + box.height / 2 - window.innerHeight / 2)).toBeLessThanOrEqual(1);
  });
});
