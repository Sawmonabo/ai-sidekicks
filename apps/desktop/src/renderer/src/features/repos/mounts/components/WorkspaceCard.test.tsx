// A workspace row: it wears its binding and lifecycle position, a stale row quotes its
// `lastError`, and the root preparation is held while the mount withholds its controls.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { scriptedRepoOperations } from "../../operations.test-support.js";

import { readBindControlAvailability } from "../bind-control-availability.js";
import type { RepoWorkspaceRow } from "../reading.js";
import { buildMount, workspaceRow as workspace } from "../repo-mounts.test-support.js";
import { WorkspaceCard } from "./WorkspaceCard.js";

/** The availability a healthy, attached mount hands down, composed the way the card gets it. */
const HEALTHY_MOUNT_BIND_CONTROLS = readBindControlAvailability(buildMount());

function renderRow(
  row: RepoWorkspaceRow,
  overrides: Partial<React.ComponentProps<typeof WorkspaceCard>> = {},
): ReturnType<typeof render> {
  const { bridge, clock } = bridgeOnClock("repos");
  return render(
    <WorkspaceCard
      workspace={row}
      bindControls={HEALTHY_MOUNT_BIND_CONTROLS}
      bridge={bridge}
      operations={scriptedRepoOperations()}
      onRequestRead={() => undefined}
      {...overrides}
    />,
    { wrapper: bridgeWrapper(bridge, clock) },
  );
}

/** A workspace whose row offers a root to prepare, in the mode that provisions one. */
const WRITABLE_ROW: RepoWorkspaceRow = workspace({ executionMode: "provisioned-worktree" });

/** A withholding mount's real availability, composed by the module the card reads it from. */
const DETACHED_MOUNT_BIND_CONTROLS = readBindControlAvailability(buildMount({ state: "detached" }));

describe("WorkspaceCard — the stale row", () => {
  it("quotes `lastError` inline, verbatim", () => {
    const detail = "fatal: could not read from remote repository (exit 128)";
    const { getByText, container } = renderRow(workspace({ state: "stale", lastError: detail }));
    expect(getByText(detail)).toBeDefined();
    expect(container.querySelector(".meridian-workspace-card__last-error")).not.toBeNull();
  });
});

describe("WorkspaceCard — the row wears what the list gave it", () => {
  it("wears exactly the binding and the lifecycle position", () => {
    const { container } = renderRow(
      workspace({ state: "busy", executionMode: "provisioned-worktree" }),
    );
    const chips = container.querySelectorAll(".meridian-chip__label");
    expect([...chips].map((chip) => chip.textContent)).toStrictEqual([
      "Provisioned worktree",
      "Busy",
    ]);
  });
});

describe("WorkspaceCard — the root preparation follows the mount", () => {
  function branchInput(container: HTMLElement): HTMLInputElement | null {
    return within(container).queryByLabelText<HTMLInputElement>("Branch");
  }

  it("holds the root preparation while the mount withholds its bind controls", () => {
    // A prepare is a bind, and the mount refuses every bind; the form must not collect a
    // branch name for a call the daemon will refuse.
    const { container } = renderRow(WRITABLE_ROW, { bindControls: DETACHED_MOUNT_BIND_CONTROLS });

    expect(branchInput(container)?.disabled).toBe(true);
    expect(container.querySelector(".meridian-prepare-root__held")).not.toBeNull();
  });
});
