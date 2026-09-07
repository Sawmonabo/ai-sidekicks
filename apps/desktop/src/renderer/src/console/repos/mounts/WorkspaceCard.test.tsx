// A workspace row carries what the list gave it, and nothing it invented.
//
// The load-bearing negative control here is the absence of a health chip.
// `WorkspaceCard.tsx` names it a Never, and the reason is
// structural: `WorkspaceListResponse` carries no health member because a mount's
// reachability is the MOUNT's projection. A row that synthesised one would be
// answering a question the daemon deliberately did not answer.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { fixtureBridgeWithGrowth } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { SessionStore } from "../../store/index.js";

import { bindControlPosture } from "./mount-health.js";
import type { RepoWorkspaceRow } from "./repo-mounts-model.js";
import { CANONICAL_ROOT, mount, workspaceRow as workspace } from "./repo-mounts.test-support.js";
import { WorkspaceCard } from "./WorkspaceCard.js";

/** The posture a healthy, attached mount hands down, composed the way the card gets it. */
const HEALTHY_MOUNT_BIND_CONTROLS = bindControlPosture(mount());

function renderRow(
  row: RepoWorkspaceRow,
  overrides: Partial<React.ComponentProps<typeof WorkspaceCard>> = {},
): ReturnType<typeof render> {
  return render(
    <WorkspaceCard
      workspace={row}
      capabilities={undefined}
      refusal={undefined}
      refusalMode={undefined}
      pendingMode={undefined}
      bindControls={HEALTHY_MOUNT_BIND_CONTROLS}
      mountCanonicalRoot={CANONICAL_ROOT}
      bridge={fixtureBridgeWithGrowth(REPOS_SCENARIO, {})}
      sessionStore={new SessionStore({ sessionId: "session-repos" })}
      onSelectExecutionMode={() => undefined}
      onRequestRead={() => undefined}
      {...overrides}
    />,
  );
}

/** The one workspace whose row offers a root to prepare, in the mode that materialises one. */
const WRITABLE_ROW: RepoWorkspaceRow = workspace({ executionMode: "worktree" });

/** A withholding mount's real posture, composed by the module the card reads it from. */
const DETACHED_MOUNT_BIND_CONTROLS = bindControlPosture(mount({ state: "detached" }));

describe("WorkspaceCard — the root", () => {
  it("renders the root the wire gave it", () => {
    const { getByTitle } = renderRow(workspace());
    expect(getByTitle(CANONICAL_ROOT)).toBeDefined();
  });

  it("says the root is pending while the workspace is provisioning", () => {
    // `WorkspaceBindResponse.fsRoot` is absent for a writable bind until provisioning
    // completes; an empty cell would read as "this workspace has no root", which is a
    // different and false fact.
    const { container, getByText } = renderRow(
      workspace({ state: "provisioning", fsRoot: undefined }),
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
    // `lastError` is present only on a row that went stale from a recorded failure, so
    // a card that always rendered the region would show an empty red box on every
    // healthy workspace.
    const { container } = renderRow(workspace());
    expect(container.querySelector(".meridian-workspace-card__last-error")).toBeNull();
  });
});

describe("WorkspaceCard — two chips, and no third axis", () => {
  it("wears exactly the binding and the lifecycle position", () => {
    const { container } = renderRow(workspace({ state: "busy", executionMode: "worktree" }));
    const chips = container.querySelectorAll(".meridian-chip__label");
    expect([...chips].map((chip) => chip.textContent)).toStrictEqual(["worktree", "busy"]);
  });

  it("negative control: no chip anywhere reads as a mount health verdict", () => {
    // The two words `RepoMountHealth` ships. If either ever appears on this row, a
    // health axis has been synthesised onto a projection that carries none.
    const { container } = renderRow(workspace({ state: "stale", lastError: "path vanished" }));
    const head = container.querySelector(".meridian-workspace-card__head");
    expect(within(head as HTMLElement).queryByText("healthy")).toBeNull();
    expect(within(head as HTMLElement).queryByText("unreachable")).toBeNull();
  });
});

describe("WorkspaceCard — one posture for both binding controls", () => {
  /** Whether the root-preparation form is live, read off the control the form is entered through. */
  function branchInput(container: HTMLElement): HTMLInputElement | null {
    return container.querySelector<HTMLInputElement>(".meridian-prepare-root__branch-input");
  }

  it("holds the root preparation while the mount withholds its bind controls", () => {
    // A detached, unreachable, or identity-mismatched mount refuses every bind and
    // every run, and a prepare is a bind. Offering the form there collects a branch
    // name for a call the daemon has already said it will not accept.
    const { container } = renderRow(WRITABLE_ROW, { bindControls: DETACHED_MOUNT_BIND_CONTROLS });

    expect(branchInput(container)?.disabled).toBe(true);
    expect(container.querySelector(".meridian-prepare-root__held")).not.toBeNull();
  });

  it("holds the root preparation while a mode switch is on the wire", () => {
    // Which call a prepare sends and whether it asks a reuse question are both read
    // off `workspace.executionMode`, which is the member the pending switch is about
    // to change — so a prepare sent now is a prepare for the mode being left.
    const { container } = renderRow(WRITABLE_ROW, { pendingMode: "ephemeral clone" });

    expect(branchInput(container)?.disabled).toBe(true);
    expect(container.querySelector(".meridian-prepare-root__held")).not.toBeNull();
  });

  it("negative control: a writable row on a healthy mount offers the preparation", () => {
    // Without this the two cases above would pass against a control that was never
    // offered at all, which is a root nobody can prepare ahead of a run.
    const { container } = renderRow(WRITABLE_ROW);

    expect(branchInput(container)?.disabled).toBe(false);
    expect(container.querySelector(".meridian-prepare-root__held")).toBeNull();
  });
});
