// Proves the projector reports a reachable mount healthy, a failed probe as an unreachable mount
// and a stale workspace that owes its transition, and that the capability projection offers the
// git modes with the provisioned-worktree default.

import { describe, expect, it } from "vitest";

import type { WorkspaceState } from "@ai-sidekicks/contracts/repo/repo";

import {
  computeExecutionModeCapabilities,
  computeRepoMountHealth,
  computeWorkspaceHealth,
} from "../projector.js";
import type { FilesystemPathProbe, RepoMountHealthRow, WorkspaceHealthRow } from "../projector.js";

// No test opens a file, so these paths need not exist; they only have to be distinct, because the
// projector checks that a probe measured the row's own path.
const MOUNT_CANONICAL_ROOT: string = "/srv/sessions/repos/ai-sidekicks";
const WORKSPACE_FS_ROOT: string = "/srv/sessions/workspaces/main-checkout";

const MOUNT_ROW: RepoMountHealthRow = { canonicalRoot: MOUNT_CANONICAL_ROOT };

const PROBE_INSTANT: string = "2026-08-04T12:00:00.000Z";

function probeOf(probedPath: string, reachable: boolean): FilesystemPathProbe {
  return { probedPath, reachable, checkedAt: PROBE_INSTANT };
}

function workspaceRow(state: WorkspaceState): WorkspaceHealthRow {
  return { state, fsRoot: WORKSPACE_FS_ROOT };
}

describe("computeRepoMountHealth — derived projection", () => {
  it("reports healthy for a reachable canonical root, carrying the probe instant", () => {
    const probe = probeOf(MOUNT_CANONICAL_ROOT, true);

    expect(computeRepoMountHealth(MOUNT_ROW, probe)).toEqual({
      status: "healthy",
      checkedAt: PROBE_INSTANT,
    });
  });

  it("reports unreachable for a failed probe of the same root", () => {
    const probe = probeOf(MOUNT_CANONICAL_ROOT, false);

    expect(computeRepoMountHealth(MOUNT_ROW, probe)).toEqual({
      status: "unreachable",
      checkedAt: PROBE_INSTANT,
    });
  });
});

describe("computeWorkspaceHealth — stale derivation", () => {
  it("derives stale from a failed probe of a ready workspace, and owes the transition", () => {
    const probe = probeOf(WORKSPACE_FS_ROOT, false);
    const health = computeWorkspaceHealth(workspaceRow("ready"), probe);

    expect(health).toEqual({
      observedState: "stale",
      checkedAt: PROBE_INSTANT,
      staleTransitionRequired: true,
    });
  });
});

describe("health projections — one outage, two surfaces", () => {
  it("reads an unreachable filesystem as BOTH an unreachable mount and a stale workspace", () => {
    // One filesystem fault seen through two projections; neither masks it.
    const mountHealth = computeRepoMountHealth(MOUNT_ROW, probeOf(MOUNT_CANONICAL_ROOT, false));
    const outage = probeOf(WORKSPACE_FS_ROOT, false);
    const workspaceHealth = computeWorkspaceHealth(workspaceRow("ready"), outage);

    expect(mountHealth.status).toBe("unreachable");
    expect(workspaceHealth.observedState).toBe("stale");
    expect(workspaceHealth.staleTransitionRequired).toBe(true);
  });
});

describe("computeExecutionModeCapabilities — git mounts", () => {
  it("offers both modes with provisioned-worktree default", () => {
    const capabilities = computeExecutionModeCapabilities({ vcsType: "git" });

    expect(capabilities.availableModes).toEqual(["bound-root", "provisioned-worktree"]);
    expect(capabilities.defaultMode).toBe("provisioned-worktree");
  });
});
