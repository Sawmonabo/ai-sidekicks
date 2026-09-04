// A workspace row carries what the list gave it, and nothing it invented.
//
// The load-bearing negative control here is the absence of a health chip.
// `WorkspaceCard.tsx` names it a Never, and the reason is
// structural: `WorkspaceListResponse` carries no health member because a mount's
// reachability is the MOUNT's projection. A row that synthesised one would be
// answering a question the daemon deliberately did not answer.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RepoWorkspaceRow } from "./repo-mounts-reader.js";
import { WorkspaceCard } from "./WorkspaceCard.js";

function workspace(overrides: Partial<RepoWorkspaceRow> = {}): RepoWorkspaceRow {
  return {
    id: "workspace-1",
    repoMountId: "mount-1",
    executionMode: "read-only",
    state: "ready",
    fsRoot: "/Users/dev/code/thing",
    ...overrides,
  } as RepoWorkspaceRow;
}

function renderRow(row: RepoWorkspaceRow): ReturnType<typeof render> {
  return render(
    <WorkspaceCard
      workspace={row}
      capabilities={undefined}
      refusal={undefined}
      pendingMode={undefined}
      modeControlsOffered
      onSelectExecutionMode={() => undefined}
    />,
  );
}

describe("WorkspaceCard — the root", () => {
  it("renders the root the wire gave it", () => {
    const { getByTitle } = renderRow(workspace());
    expect(getByTitle("/Users/dev/code/thing")).toBeDefined();
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
