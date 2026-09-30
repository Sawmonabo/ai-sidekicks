// The workspace projector has three read-side projections: repo-mount health, workspace health and
// execution-mode capabilities. The module does no I/O, so these tests need no database, temp
// directory or clock; each branch is driven by handing in a row and a probe result. The
// `no-restricted-imports` allow-list in `eslint.config.mjs` enforces that purity by permitting
// only `@ai-sidekicks/contracts` as an import.
//
// Fail-closed cases throw rather than answer from a missing, mispaired or unknown input: a missing
// probe, a NULL execution root under a probe-bearing state, a probe of some other path, a probe
// for a state that owes none, a workspace state or `vcs_type` outside the closed vocabulary.

import { describe, expect, it } from "vitest";

import {
  RepoMountHealthSchema,
  WorkspaceExecutionModeCapabilitiesReadResponseSchema,
  type ExecutionMode,
  type VcsType,
  type WorkspaceExecutionModeCapabilitiesReadResponse,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

import {
  computeExecutionModeCapabilities,
  computeRepoMountHealth,
  computeWorkspaceHealth,
  PROBE_BEARING_WORKSPACE_STATES,
} from "../workspace-projector.js";
import type {
  ExecutionModeCapabilityRow,
  FilesystemPathProbe,
  RepoMountHealthRow,
  WorkspaceHealthRow,
} from "../workspace-projector.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// No test opens a file, so these paths need not exist; they only have to be distinct, because the
// projector checks that a probe measured the row's own path.
const MOUNT_CANONICAL_ROOT: string = "/srv/sessions/repos/ai-sidekicks";
const WORKSPACE_FS_ROOT: string = "/srv/sessions/workspaces/main-checkout";
const UNRELATED_ROOT: string = "/srv/sessions/repos/other-checkout";

const MOUNT_ROW: RepoMountHealthRow = { canonicalRoot: MOUNT_CANONICAL_ROOT };

// RFC 3339 UTC with milliseconds, which is what `new Date().toISOString()` writes and what the
// health schema's `z.iso.datetime({ offset: true })` accepts.
const PROBE_INSTANT: string = "2026-08-04T12:00:00.000Z";
const LATER_PROBE_INSTANT: string = "2026-08-04T12:00:30.000Z";

// The full workspace state, execution mode and vcs type vocabularies. `satisfies` proves every
// element is a real member and the `_AssertExtends` pins below prove every member is listed.
// Without the second check, a member added to contracts would leave the tests below passing over a
// stale roster.
const ALL_WORKSPACE_STATES = [
  "preparing",
  "ready",
  "busy",
  "stale",
  "archived",
] as const satisfies readonly WorkspaceState[];

const ALL_EXECUTION_MODES = [
  "bound-root",
  "provisioned-worktree",
] as const satisfies readonly ExecutionMode[];

const ALL_VCS_TYPES = ["git"] as const satisfies readonly VcsType[];

// The `_` prefix exempts these aliases from `no-unused-vars`; they exist only to be type-checked.
type _AssertExtends<A extends B, B> = A;
type _AssertWorkspaceStateRosterIsComplete = _AssertExtends<
  WorkspaceState,
  (typeof ALL_WORKSPACE_STATES)[number]
>;
type _AssertExecutionModeRosterIsComplete = _AssertExtends<
  ExecutionMode,
  (typeof ALL_EXECUTION_MODES)[number]
>;
type _AssertVcsTypeRosterIsComplete = _AssertExtends<VcsType, (typeof ALL_VCS_TYPES)[number]>;

function probeOf(
  probedPath: string,
  reachable: boolean,
  checkedAt: string = PROBE_INSTANT,
): FilesystemPathProbe {
  return { probedPath, reachable, checkedAt };
}

function workspaceRow(
  state: WorkspaceState,
  fsRoot: string | null = WORKSPACE_FS_ROOT,
): WorkspaceHealthRow {
  return { state, fsRoot };
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

// ----------------------------------------------------------------------------
// Mount health
// ----------------------------------------------------------------------------

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

  it("carries the PROBE's instant, never a clock of its own", () => {
    // The module reads no clock, so two projections of one row differ only by the instant handed
    // in.
    const first = computeRepoMountHealth(MOUNT_ROW, probeOf(MOUNT_CANONICAL_ROOT, true));
    const later = probeOf(MOUNT_CANONICAL_ROOT, true, LATER_PROBE_INSTANT);

    expect(first.checkedAt).toBe(PROBE_INSTANT);
    expect(computeRepoMountHealth(MOUNT_ROW, later).checkedAt).toBe(LATER_PROBE_INSTANT);
  });

  it("emits exactly the two ratified fields — no health surface beyond the shape", () => {
    const health = computeRepoMountHealth(MOUNT_ROW, probeOf(MOUNT_CANONICAL_ROOT, true));

    expect(Object.keys(health).sort()).toEqual(["checkedAt", "status"]);
    // The value is also valid on the wire.
    expect(() => RepoMountHealthSchema.parse(health)).not.toThrow();
  });

  it("refuses a probe that measured some other path", () => {
    const mismatched = probeOf(UNRELATED_ROOT, true);

    expect(() => computeRepoMountHealth(MOUNT_ROW, mismatched)).toThrow(
      /did not measure the repo mount's canonical root/,
    );
  });

  it("keeps both paths OUT of the mispaired-probe message", () => {
    const mismatched = probeOf(UNRELATED_ROOT, true);
    let message = "";

    try {
      computeRepoMountHealth(MOUNT_ROW, mismatched);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toBe("");
    expect(message).not.toContain(MOUNT_CANONICAL_ROOT);
    expect(message).not.toContain(UNRELATED_ROOT);
  });

  it("refuses a malformed probe instant at the projection, not at the wire", () => {
    const malformed = probeOf(MOUNT_CANONICAL_ROOT, true, "4 August 2026, just after lunch");

    expect(() => computeRepoMountHealth(MOUNT_ROW, malformed)).toThrow();
  });
});

// ----------------------------------------------------------------------------
// Workspace health
// ----------------------------------------------------------------------------

describe("computeWorkspaceHealth — probe-bearing census", () => {
  it("owes a probe for exactly the two states that carry a live execution root", () => {
    const probeBearing = ALL_WORKSPACE_STATES.filter((state) =>
      PROBE_BEARING_WORKSPACE_STATES.has(state),
    );

    expect(probeBearing).toEqual(["ready", "busy"]);
    // The filter above would not notice a member outside the five-state vocabulary.
    expect(PROBE_BEARING_WORKSPACE_STATES.size).toBe(2);
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

  it("derives stale from a failed probe of a BUSY workspace too", () => {
    // A run holding the workspace does not shield it from a failed probe. Whether the
    // `busy -> stale` write is legal to persist is the service's call.
    const health = computeWorkspaceHealth(workspaceRow("busy"), probeOf(WORKSPACE_FS_ROOT, false));

    expect(health.observedState).toBe("stale");
    expect(health.staleTransitionRequired).toBe(true);
  });

  it("leaves a reachable ready workspace ready, with no transition owed", () => {
    const health = computeWorkspaceHealth(workspaceRow("ready"), probeOf(WORKSPACE_FS_ROOT, true));

    expect(health).toEqual({
      observedState: "ready",
      checkedAt: PROBE_INSTANT,
      staleTransitionRequired: false,
    });
  });

  it("leaves a reachable busy workspace busy — it takes no position on run holds", () => {
    const health = computeWorkspaceHealth(workspaceRow("busy"), probeOf(WORKSPACE_FS_ROOT, true));

    expect(health.observedState).toBe("busy");
    expect(health.staleTransitionRequired).toBe(false);
  });
});

describe("computeWorkspaceHealth — states that owe no probe", () => {
  for (const state of ["preparing", "stale", "archived"] as const) {
    it(`answers a ${state} workspace from the row alone, with no probe instant`, () => {
      expect(computeWorkspaceHealth(workspaceRow(state), null)).toEqual({
        observedState: state,
        checkedAt: null,
        staleTransitionRequired: false,
      });
    });
  }

  it("NEVER auto-heals a stale workspace — a reachable probe is refused outright", () => {
    // A failed mode switch also writes `stale` while its path is reachable, so a reachable probe
    // must not heal it. The projector refuses a probe here, and the no-probe answer stays `stale`.
    const reachable = probeOf(WORKSPACE_FS_ROOT, true);

    expect(() => computeWorkspaceHealth(workspaceRow("stale"), reachable)).toThrow(
      /owes no execution-root probe/,
    );
    expect(computeWorkspaceHealth(workspaceRow("stale"), null).observedState).toBe("stale");
  });

  it("refuses a probe offered for a terminal archived workspace", () => {
    const probe = probeOf(WORKSPACE_FS_ROOT, false);

    expect(() => computeWorkspaceHealth(workspaceRow("archived"), probe)).toThrow(
      /owes no execution-root probe/,
    );
  });

  it("answers a provisioning workspace whether or not its row still carries a root", () => {
    // `fs_root` may still hold the pre-switch root during reprovisioning; either way the state,
    // not the column, decides that no probe is owed.
    const withRoot = computeWorkspaceHealth(workspaceRow("preparing"), null);
    const withoutRoot = computeWorkspaceHealth(workspaceRow("preparing", null), null);

    expect(withRoot.observedState).toBe("preparing");
    expect(withRoot.checkedAt).toBeNull();
    expect(withoutRoot.observedState).toBe("preparing");
  });
});

describe("computeWorkspaceHealth — fail-closed pairing", () => {
  it("refuses to answer a ready workspace with no probe at all", () => {
    expect(() => computeWorkspaceHealth(workspaceRow("ready"), null)).toThrow(
      /requires an execution-root probe/,
    );
  });

  it("refuses a probe-bearing row whose fs_root is NULL", () => {
    const probe = probeOf(WORKSPACE_FS_ROOT, true);

    expect(() => computeWorkspaceHealth(workspaceRow("ready", null), probe)).toThrow(
      /must carry a resolved fs_root/,
    );
  });

  it("refuses a probe that measured some other path", () => {
    const mismatched = probeOf(UNRELATED_ROOT, false);

    expect(() => computeWorkspaceHealth(workspaceRow("ready"), mismatched)).toThrow(
      /did not measure the workspace's execution root/,
    );
  });

  it("reports the NULL root rather than the missing probe when both are wrong", () => {
    // A row with no root could not have been probed, so the corrupt row is reported, not the
    // missing probe.
    expect(() => computeWorkspaceHealth(workspaceRow("ready", null), null)).toThrow(
      /must carry a resolved fs_root/,
    );
  });

  it("refuses a state outside the closed vocabulary rather than guessing a probe policy", () => {
    // A raw database row can carry a string the compiler never saw. Positive membership on both
    // sides of the partition sends it to this throw rather than to whichever branch a negated
    // `has` check would pick.
    const corruptRow = {
      state: "hibernating",
      fsRoot: WORKSPACE_FS_ROOT,
    } as unknown as WorkspaceHealthRow;

    expect(() => computeWorkspaceHealth(corruptRow, null)).toThrow(
      /no probe policy is registered for workspace state/,
    );
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

  it("accepts one probe for both surfaces when the workspace root IS the mount root", () => {
    // A bound-root workspace executes in the mount's own checkout, so both rows share one path and
    // one probe can serve both projections; the guards reject a mispaired probe, not a shared one.
    const sharedOutage = probeOf(MOUNT_CANONICAL_ROOT, false);
    const mountHealth = computeRepoMountHealth(MOUNT_ROW, sharedOutage);
    const workspaceHealth = computeWorkspaceHealth(
      workspaceRow("ready", MOUNT_CANONICAL_ROOT),
      sharedOutage,
    );

    expect(mountHealth.status).toBe("unreachable");
    expect(workspaceHealth.observedState).toBe("stale");
    expect(workspaceHealth.staleTransitionRequired).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Execution-mode capabilities
// ----------------------------------------------------------------------------

describe("computeExecutionModeCapabilities — git mounts", () => {
  it("offers both modes with provisioned-worktree default", () => {
    const capabilities = capabilitiesFor("git");

    expect(capabilities.availableModes).toEqual(["bound-root", "provisioned-worktree"]);
    expect(capabilities.defaultMode).toBe("provisioned-worktree");
  });

  it("omits the restrictions key entirely when nothing is restricted", () => {
    const capabilities = capabilitiesFor("git");

    // An unrestricted answer omits the field on the wire instead of sending an empty object.
    expect(Object.keys(capabilities).sort()).toEqual(["availableModes", "defaultMode"]);
    expect(capabilities.restrictions).toBeUndefined();
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

    it(`defaults a ${vcsType} mount to a mode it actually offers`, () => {
      const capabilities = capabilitiesFor(vcsType);

      expect(capabilities.availableModes).toContain(capabilities.defaultMode);
    });

    it(`emits a wire-valid capabilities response for a ${vcsType} mount`, () => {
      const capabilities = capabilitiesFor(vcsType);

      // The outbound wire validates responses too, so an over-long reason string would break the
      // read surface, not this projection.
      expect(() =>
        WorkspaceExecutionModeCapabilitiesReadResponseSchema.parse(capabilities),
      ).not.toThrow();
    });
  }
});

describe("computeExecutionModeCapabilities — fail-closed dispatch and fresh outputs", () => {
  it("refuses a vcs_type outside the closed union instead of answering with a profile", () => {
    const unregistered = { vcsType: "svn" } as unknown as ExecutionModeCapabilityRow;

    expect(() => computeExecutionModeCapabilities(unregistered)).toThrow(
      /no capability profile is registered for vcs_type/,
    );
  });

  it("hands back independent arrays per call, so one caller cannot corrupt the next", () => {
    const first = capabilitiesFor("git");
    first.availableModes.push("provisioned-worktree");

    const second = capabilitiesFor("git");

    expect(second.availableModes).toHaveLength(ALL_EXECUTION_MODES.length);
    expect(second.availableModes).not.toBe(first.availableModes);
  });
});
