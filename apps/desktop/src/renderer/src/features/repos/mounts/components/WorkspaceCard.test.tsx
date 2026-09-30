// A workspace row carries what the list gave it and nothing it invented. There is no health
// chip: the list carries no health member, so a row that synthesized one would answer a
// question the daemon did not.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStore } from "@renderer/store/session/session-store.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";

import { readBindControlAvailability } from "../mount-health.js";
import type { RepoWorkspaceRow } from "../repo-mounts-model.js";
import {
  CANONICAL_ROOT,
  buildMount,
  workspaceRow as workspace,
} from "../repo-mounts.test-support.js";
import { WorkspaceCard } from "./WorkspaceCard.js";

/** The posture a healthy, attached mount hands down, composed the way the card gets it. */
const HEALTHY_MOUNT_BIND_CONTROLS = readBindControlAvailability(buildMount());

function renderRow(
  row: RepoWorkspaceRow,
  overrides: Partial<React.ComponentProps<typeof WorkspaceCard>> = {},
): ReturnType<typeof render> {
  const { bridge, clock } = bridgeOnClock("repos");
  return render(
    <WorkspaceCard
      workspace={row}
      capabilities={undefined}
      pendingMode={undefined}
      bindControls={HEALTHY_MOUNT_BIND_CONTROLS}
      bridge={bridge}
      operations={scriptedRepoOperations()}
      sessionStore={new SessionStore({ sessionId: "session-repos" })}
      onSelectExecutionMode={() => undefined}
      onRequestRead={() => undefined}
      {...overrides}
    />,
    { wrapper: bridgeWrapper(bridge, clock) },
  );
}

/** A workspace whose row offers a root to prepare, in the mode that provisions one. */
const WRITABLE_ROW: RepoWorkspaceRow = workspace({ executionMode: "provisioned-worktree" });

/** A withholding mount's real posture, composed by the module the card reads it from. */
const DETACHED_MOUNT_BIND_CONTROLS = readBindControlAvailability(buildMount({ state: "detached" }));

describe("WorkspaceCard — the root", () => {
  it("renders the root the wire gave it", () => {
    const { getByTitle } = renderRow(workspace());
    expect(getByTitle(CANONICAL_ROOT)).toBeDefined();
  });

  it("says the root is pending while the workspace is provisioning", () => {
    // `fsRoot` is absent until the root is prepared; an empty cell would read as no root.
    const { container, getByText } = renderRow(
      workspace({ state: "preparing", fsRoot: undefined }),
    );
    expect(getByText("Root pending")).toBeDefined();
    expect(container.querySelector(".meridian-nothing--computing")).not.toBeNull();
  });

  it("negative control: a ready row with a root does not claim the root is pending", () => {
    const { queryByText } = renderRow(workspace());
    expect(queryByText("Root pending")).toBeNull();
  });
});

describe("WorkspaceCard — the stale row", () => {
  it("quotes `lastError` inline, verbatim", () => {
    const detail = "fatal: could not read from remote repository (exit 128)";
    const { getByText, container } = renderRow(workspace({ state: "stale", lastError: detail }));
    expect(getByText(detail)).toBeDefined();
    expect(container.querySelector(".meridian-workspace-card__last-error")).not.toBeNull();
  });

  it("negative control: a ready row renders no error region at all", () => {
    // `lastError` exists only on a stale row; always rendering it would show an empty box.
    const { container } = renderRow(workspace());
    expect(container.querySelector(".meridian-workspace-card__last-error")).toBeNull();
  });
});

describe("WorkspaceCard — two chips, and no third axis", () => {
  it("wears exactly the binding and the lifecycle position", () => {
    const { container } = renderRow(
      workspace({ state: "busy", executionMode: "provisioned-worktree" }),
    );
    const chips = container.querySelectorAll(".meridian-chip__label");
    expect([...chips].map((chip) => chip.textContent)).toStrictEqual([
      "provisioned-worktree",
      "busy",
    ]);
  });

  it("negative control: no chip anywhere reads as a mount health verdict", () => {
    // The two words `RepoMountHealth` ships; either here means a health axis was synthesized.
    const { container } = renderRow(workspace({ state: "stale", lastError: "path vanished" }));
    const head = container.querySelector(".meridian-workspace-card__head");
    expect(within(head as HTMLElement).queryByText("healthy")).toBeNull();
    expect(within(head as HTMLElement).queryByText("unreachable")).toBeNull();
  });
});

describe("WorkspaceCard — one posture for both binding controls", () => {
  function branchInput(container: HTMLElement): HTMLInputElement | null {
    return container.querySelector<HTMLInputElement>(".meridian-prepare-root__branch-input");
  }

  it("holds the root preparation while the mount withholds its bind controls", () => {
    // A prepare is a bind, and the mount refuses every bind; the form must not collect a
    // branch name for a call the daemon will refuse.
    const { container } = renderRow(WRITABLE_ROW, { bindControls: DETACHED_MOUNT_BIND_CONTROLS });

    expect(branchInput(container)?.disabled).toBe(true);
    expect(container.querySelector(".meridian-prepare-root__held")).not.toBeNull();
  });

  it("holds the root preparation while a mode switch is on the wire", () => {
    // A prepare sent now would be for the mode being left: its call and reuse question both
    // read `workspace.executionMode`, which the pending switch is about to change.
    const { container } = renderRow(WRITABLE_ROW, { pendingMode: "bound-root" });

    expect(branchInput(container)?.disabled).toBe(true);
    expect(container.querySelector(".meridian-prepare-root__held")).not.toBeNull();
  });

  it("negative control: a writable row on a healthy mount offers the preparation", () => {
    // Without this the two cases above would pass against a control never offered.
    const { container } = renderRow(WRITABLE_ROW);

    expect(branchInput(container)?.disabled).toBe(false);
    expect(container.querySelector(".meridian-prepare-root__held")).toBeNull();
  });
});
