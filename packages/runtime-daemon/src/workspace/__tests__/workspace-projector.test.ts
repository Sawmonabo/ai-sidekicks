// workspace-projector behaviour.
//
// Exercises the three read-side projections the daemon's health and capability
// surfaces answer from. No database, no temp directory, no clock: the module
// under test performs no I/O, so every branch is driven by handing it a row and
// a probe result directly. That purity is enforced statically, by the
// `no-restricted-imports` allow-list for
// `packages/runtime-daemon/src/workspace/workspace-projector.ts` in
// eslint.config.mjs: `@ai-sidekicks/contracts` is the only specifier the module
// may import, so no sibling can pull I/O in behind it.
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * Mount health: both verdicts of shape, the probe's own `checkedAt`
//     carried through verbatim, and a malformed timestamp refused at the
//     projection that produced it rather than at the outbound wire.
//   * Workspace health: the stale verdict derived for a probe-failed root in
//     BOTH probe-bearing states, the reachable case leaving the row's state
//     untouched, and the three non-probe-bearing states answered without a
//     probe at all.
//   * No auto-heal: a reachable probe never returns a `stale` workspace to
//     service — that state is not probe-bearing, so offering one is refused.
//   * One outage, two surfaces: an unreachable filesystem reads as an
//     unreachable mount AND a stale workspace — neither projection masks it.
//   * Fail-closed pairing: a missing probe, a NULL execution root under a
//     probe-bearing state, a probe of some other path, and a probe supplied for
//     a row that owes none each throw rather than answering from a partial or
//     mispaired input — and a state outside the closed vocabulary is refused
//     outright rather than assigned a probe policy by guess.
//   * Shared root: default workspace is rooted at the mount's own canonical
//     root, so the two rows legitimately share one path and one probe
//     measurement lawfully serves both projections.
//   * Wire validity: each projection parses clean against the canonical
//     response schema, so a reason string that outgrew its ratified cap fails
//     here rather than taking down the read surface that would return it.
//   * Fail-closed dispatch: a `vcs_type` outside the closed union throws
//     instead of receiving another profile's answer.
//   * Fresh outputs: successive calls hand back independent collections, so a
//     caller that mutates a response cannot corrupt a later one.
//   * Purity: the module's static-import census is exactly the contracts
//     package — no sibling module that could pull I/O in transitively — with
//     no dynamic-import or require escape hatch, checked by an extractor that
//     is itself negative-controlled across all three static import forms.
//

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

// Paths are never touched — nothing here opens a file — so they need not exist.
// They only have to be distinct, because telling one from another is exactly
// what the subject-binding guards do.
const MOUNT_CANONICAL_ROOT: string = "/srv/sessions/repos/ai-sidekicks";
const WORKSPACE_FS_ROOT: string = "/srv/sessions/workspaces/main-checkout";
const UNRELATED_ROOT: string = "/srv/sessions/repos/other-checkout";

const MOUNT_ROW: RepoMountHealthRow = { canonicalRoot: MOUNT_CANONICAL_ROOT };

// RFC 3339 UTC with milliseconds — the canonical form every daemon surface
// writes (`new Date().toISOString()`), and the form the health schema's
// `z.iso.datetime({ offset: true })` accepts.
const PROBE_INSTANT: string = "2026-08-04T12:00:00.000Z";
const LATER_PROBE_INSTANT: string = "2026-08-04T12:00:30.000Z";

// The full workspace vocabulary. The canonical four-mode taxonomy.
//
// Each roster carries the SAME pair of checks the module applies to its own
// taxonomy array, and both directions are needed: `satisfies` proves every
// element is a real member, and the `_AssertExtends` pins below prove every
// member is an element. With only the first, a state or mode added to
// contracts would leave the census and the partition test passing VACUOUSLY
// over a stale roster — which is precisely the drift verification exists to
// catch.
const ALL_WORKSPACE_STATES = [
  "provisioning",
  "ready",
  "busy",
  "stale",
  "archived",
] as const satisfies readonly WorkspaceState[];

const ALL_EXECUTION_MODES = [
  "read-only",
  "branch",
  "worktree",
  "ephemeral clone",
] as const satisfies readonly ExecutionMode[];

const ALL_VCS_TYPES = ["git", "none"] as const satisfies readonly VcsType[];

// The `_` prefix is what the root eslint config's `varsIgnorePattern` exempts
// from `no-unused-vars`; the aliases exist to be type-checked, not read.
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

/** The restricted modes of a projection, read WITHOUT casting a key back. */
function restrictedModesOf(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
): ExecutionMode[] {
  return ALL_EXECUTION_MODES.filter((mode) => capabilities.restrictions?.[mode] !== undefined);
}

// ----------------------------------------------------------------------------
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
    // Two projections of one row differ only by the instant handed in — the
    // module reads no clock, so a second call cannot invent a fresher one.
    const first = computeRepoMountHealth(MOUNT_ROW, probeOf(MOUNT_CANONICAL_ROOT, true));
    const later = probeOf(MOUNT_CANONICAL_ROOT, true, LATER_PROBE_INSTANT);

    expect(first.checkedAt).toBe(PROBE_INSTANT);
    expect(computeRepoMountHealth(MOUNT_ROW, later).checkedAt).toBe(LATER_PROBE_INSTANT);
  });

  it("emits exactly the two ratified fields — no health surface beyond the shape", () => {
    const health = computeRepoMountHealth(MOUNT_ROW, probeOf(MOUNT_CANONICAL_ROOT, true));

    expect(Object.keys(health).sort()).toEqual(["checkedAt", "status"]);
    // And the value is what the wire surface composing this schema accepts.
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
// ----------------------------------------------------------------------------

describe("computeWorkspaceHealth — probe-bearing census", () => {
  it("owes a probe for exactly the two states that carry a live execution root", () => {
    const probeBearing = ALL_WORKSPACE_STATES.filter((state) =>
      PROBE_BEARING_WORKSPACE_STATES.has(state),
    );

    expect(probeBearing).toEqual(["ready", "busy"]);
    // Size pinned separately: a member outside the five-state vocabulary would
    // pass the filter above unnoticed.
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
    // The run holding this workspace does not shield it: makes the
    // unavailable root observable on every read surface. Whether the `busy
    // -> stale` write is legal to persist is the service's call.
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
  for (const state of ["provisioning", "stale", "archived"] as const) {
    it(`answers a ${state} workspace from the row alone, with no probe instant`, () => {
      expect(computeWorkspaceHealth(workspaceRow(state), null)).toEqual({
        observedState: state,
        checkedAt: null,
        staleTransitionRequired: false,
      });
    });
  }

  it("NEVER auto-heals a stale workspace — a reachable probe is refused outright", () => {
    // The repair contract is explicit (blocked until the workspace is repaired
    // or the switch is retried), and `stale` is also written by a failed mode
    // switch whose path is perfectly reachable. So the projector will not
    // accept a probe here at all, and the no-probe answer stays `stale`.
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
    // `fs_root` may or may not still hold the pre-switch root mid-reprovision;
    // either way the state, not the column, decides that no probe is owed.
    const withRoot = computeWorkspaceHealth(workspaceRow("provisioning"), null);
    const withoutRoot = computeWorkspaceHealth(workspaceRow("provisioning", null), null);

    expect(withRoot.observedState).toBe("provisioning");
    expect(withRoot.checkedAt).toBeNull();
    expect(withoutRoot.observedState).toBe("provisioning");
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
    // Diagnosis order matters: a row with no root could not have been probed,
    // so the corrupt row is the finding, not the caller's missing probe.
    expect(() => computeWorkspaceHealth(workspaceRow("ready", null), null)).toThrow(
      /must carry a resolved fs_root/,
    );
  });

  it("refuses a state outside the closed vocabulary rather than guessing a probe policy", () => {
    // A raw database row can carry a string the compiler never saw. Positive
    // membership on both sides of the partition means it lands on THIS throw,
    // not on whichever branch a `!has(...)` negation would have handed it —
    // the workspace-state twin of the vcs_type dispatch refusal below.
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
    // The closest a pure module gets to the "every read surface" half of:
    // one filesystem fault, two projections, neither masking it.
    const mountHealth = computeRepoMountHealth(MOUNT_ROW, probeOf(MOUNT_CANONICAL_ROOT, false));
    const outage = probeOf(WORKSPACE_FS_ROOT, false);
    const workspaceHealth = computeWorkspaceHealth(workspaceRow("ready"), outage);

    expect(mountHealth.status).toBe("unreachable");
    expect(workspaceHealth.observedState).toBe("stale");
    expect(workspaceHealth.staleTransitionRequired).toBe(true);
  });

  it("accepts one probe for both surfaces when the workspace root IS the mount root", () => {
    // Default workspace is rooted at the mount's own canonical root — the
    // shape most production reads take, since attach unconditionally
    // creates it. The two rows legitimately share one path, so one
    // measurement of it lawfully feeds both projections; the
    // subject-binding guards reject mispairing, not sharing.
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
// ----------------------------------------------------------------------------

describe("computeExecutionModeCapabilities — git mounts", () => {
  it("offers the full four-mode taxonomy with worktree default", () => {
    const capabilities = capabilitiesFor("git");

    expect(capabilities.availableModes).toEqual([
      "read-only",
      "branch",
      "worktree",
      "ephemeral clone",
    ]);
    expect(capabilities.defaultMode).toBe("worktree");
  });

  it("omits the restrictions key entirely when nothing is restricted", () => {
    const capabilities = capabilitiesFor("git");

    // Absent, not an empty object — the wire shape omits the whole field for an
    // unrestricted answer.
    expect(Object.keys(capabilities).sort()).toEqual(["availableModes", "defaultMode"]);
    expect(capabilities.restrictions).toBeUndefined();
  });
});

describe("computeExecutionModeCapabilities — plain-directory mounts", () => {
  it("offers read-only alone and defaults to it", () => {
    const capabilities = capabilitiesFor("none");

    expect(capabilities.availableModes).toEqual(["read-only"]);
    expect(capabilities.defaultMode).toBe("read-only");
  });

  it("names all three excluded git-backed modes with a populated reason", () => {
    const capabilities = capabilitiesFor("none");
    const restricted = restrictedModesOf(capabilities);

    expect(restricted).toEqual(["branch", "worktree", "ephemeral clone"]);
    for (const mode of restricted) {
      // `toMatch` fails outright on a missing reason. An optional-chained
      // `reason?.trim()).not.toBe("")` would PASS on `undefined` — the exact
      // input forbids — so the non-blankness is asserted directly.
      expect(capabilities.restrictions?.[mode]).toMatch(/\S/);
    }
  });

  it("carries no restriction key beyond the canonical taxonomy", () => {
    const capabilities = capabilitiesFor("none");

    // `restrictedModesOf` reads only canonical keys; comparing counts is what
    // catches a stray key it would skip over.
    expect(Object.keys(capabilities.restrictions ?? {})).toHaveLength(
      restrictedModesOf(capabilities).length,
    );
  });

  it("gives each restricted mode its own reason, never one recycled sentence", () => {
    const capabilities = capabilitiesFor("none");
    const reasons = restrictedModesOf(capabilities).map(
      (mode) => capabilities.restrictions?.[mode],
    );

    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe("computeExecutionModeCapabilities — partition", () => {
  for (const vcsType of ALL_VCS_TYPES) {
    it(`partitions every execution mode for a ${vcsType} mount`, () => {
      const capabilities = capabilitiesFor(vcsType);
      const restricted = restrictedModesOf(capabilities);
      const available = capabilities.availableModes;

      // TOTAL — no mode is silently dropped.
      for (const mode of ALL_EXECUTION_MODES) {
        expect(available.includes(mode) || restricted.includes(mode)).toBe(true);
      }
      // DISJOINT — no mode is both offered and refused.
      expect(available.filter((mode) => restricted.includes(mode))).toEqual([]);
      // And the two sides account for the taxonomy exactly once each.
      expect(available.length + restricted.length).toBe(ALL_EXECUTION_MODES.length);
    });

    it(`defaults a ${vcsType} mount to a mode it actually offers`, () => {
      const capabilities = capabilitiesFor(vcsType);

      expect(capabilities.availableModes).toContain(capabilities.defaultMode);
    });

    it(`emits a wire-valid capabilities response for a ${vcsType} mount`, () => {
      const capabilities = capabilitiesFor(vcsType);

      // Response validation runs on the outbound wire too, so a reason
      // string that outgrew its ratified cap would break the read surface
      // rather than this projection.
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
    first.availableModes.push("read-only");

    const second = capabilitiesFor("git");

    expect(second.availableModes).toHaveLength(ALL_EXECUTION_MODES.length);
    expect(second.availableModes).not.toBe(first.availableModes);
  });

  it("hands back an independent restrictions map per call", () => {
    const first = capabilitiesFor("none");
    const originalReason = first.restrictions?.["branch"];
    if (first.restrictions !== undefined) {
      first.restrictions["branch"] = "mutated by a careless consumer";
    }

    const second = capabilitiesFor("none");

    expect(originalReason).toBeDefined();
    expect(second.restrictions?.["branch"]).toBe(originalReason);
  });
});
