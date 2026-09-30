// Proves the projector reports a reachable mount healthy, a failed probe as an unreachable mount
// and a stale workspace that owes its transition, and that the capability projection offers the
// git modes with the provisioned-worktree default and accounts for every mode exactly once.

import { describe, expect, it } from "vitest";

import type {
  ExecutionMode,
  VcsType,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceState,
} from "@ai-sidekicks/contracts";

import {
  computeExecutionModeCapabilities,
  computeRepoMountHealth,
  computeWorkspaceHealth,
} from "../workspace-projector.js";
import type {
  FilesystemPathProbe,
  RepoMountHealthRow,
  WorkspaceHealthRow,
} from "../workspace-projector.js";

// No test opens a file, so these paths need not exist; they only have to be distinct, because the
// projector checks that a probe measured the row's own path.
const MOUNT_CANONICAL_ROOT: string = "/srv/sessions/repos/ai-sidekicks";
const WORKSPACE_FS_ROOT: string = "/srv/sessions/workspaces/main-checkout";

const MOUNT_ROW: RepoMountHealthRow = { canonicalRoot: MOUNT_CANONICAL_ROOT };

const PROBE_INSTANT: string = "2026-08-04T12:00:00.000Z";

// `satisfies` proves every element is a real member and the `_AssertExtends` pins prove every
// member is listed, so a member added to contracts cannot leave the partition passing over a stale
// roster.
const ALL_EXECUTION_MODES = [
  "bound-root",
  "provisioned-worktree",
] as const satisfies readonly ExecutionMode[];

const ALL_VCS_TYPES = ["git"] as const satisfies readonly VcsType[];

// The `_` prefix exempts these aliases from `no-unused-vars`; they exist only to be type-checked.
type _AssertExtends<A extends B, B> = A;
type _AssertExecutionModeRosterIsComplete = _AssertExtends<
  ExecutionMode,
  (typeof ALL_EXECUTION_MODES)[number]
>;
type _AssertVcsTypeRosterIsComplete = _AssertExtends<VcsType, (typeof ALL_VCS_TYPES)[number]>;

function probeOf(probedPath: string, reachable: boolean): FilesystemPathProbe {
  return { probedPath, reachable, checkedAt: PROBE_INSTANT };
}

function workspaceRow(state: WorkspaceState): WorkspaceHealthRow {
  return { state, fsRoot: WORKSPACE_FS_ROOT };
}

function capabilitiesFor(vcsType: VcsType): WorkspaceExecutionModeCapabilitiesReadResponse {
  return computeExecutionModeCapabilities({ vcsType });
}

/** The restricted modes of a projection, read without casting a key back. */
function restrictedModesOf(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
): ExecutionMode[] {
  return ALL_EXECUTION_MODES.filter((mode) => capabilities.restrictions?.[mode] !== undefined);
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
    const capabilities = capabilitiesFor("git");

    expect(capabilities.availableModes).toEqual(["bound-root", "provisioned-worktree"]);
    expect(capabilities.defaultMode).toBe("provisioned-worktree");
  });
});

describe("computeExecutionModeCapabilities — partition", () => {
  for (const vcsType of ALL_VCS_TYPES) {
    it(`partitions every execution mode for a ${vcsType} mount`, () => {
      const capabilities = capabilitiesFor(vcsType);
      const restricted = restrictedModesOf(capabilities);
      const available = capabilities.availableModes;

      // Total: no mode is dropped.
      for (const mode of ALL_EXECUTION_MODES) {
        expect(available.includes(mode) || restricted.includes(mode)).toBe(true);
      }
      // Disjoint: no mode is both offered and refused.
      expect(available.filter((mode) => restricted.includes(mode))).toEqual([]);
      // Each mode is counted exactly once.
      expect(available.length + restricted.length).toBe(ALL_EXECUTION_MODES.length);
    });
  }
});
