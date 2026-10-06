// Pure projection of repo-mount health, workspace health and execution-mode capabilities. Nothing
// here touches the filesystem, a clock or a database: the service layer probes and hands in the
// `{row, probe}` pair.
//
// - An unavailable execution root reads as `stale` on every read surface, detected on read only;
//   `markStale` and `assertWritable` belong to the workspace service.
// - Capability projection never silently substitutes a mode: every mode missing from
//   `availableModes` appears in `restrictions` with a reason, including any narrowing for a
//   `stale` workspace.

import {
  RepoMountHealthSchema,
  type ExecutionMode,
  type RepoMountHealth,
  type VcsType,
  type WorkspaceState,
} from "@ai-sidekicks/contracts/repo/repo";

/**
 * One synchronous filesystem measurement, handed in by the service layer. Every projection checks
 * `probedPath` against its row's path and refuses a mismatch, so a mispaired fold cannot report a
 * wrong verdict.
 */
export interface FilesystemPathProbe {
  readonly probedPath: string;
  // Binary because `RepoMountHealth.status` has exactly two members.
  readonly reachable: boolean;
  readonly checkedAt: string;
}

/**
 * The `repo_mounts` field the health projection reads. Lifecycle `state` is absent on purpose:
 * health is root reachability alone, so a `detached` mount whose root is on disk is `healthy`.
 */
export interface RepoMountHealthRow {
  readonly canonicalRoot: string;
}

/** Projects a mount's health from the probe of its canonical root; throws on a path mismatch. */
export function computeRepoMountHealth(
  mountRow: RepoMountHealthRow,
  probe: FilesystemPathProbe,
): RepoMountHealth {
  assertProbeTargets(probe, mountRow.canonicalRoot, "repo mount's canonical root");
  return RepoMountHealthSchema.parse({
    status: probe.reachable ? "healthy" : "unreachable",
    checkedAt: probe.checkedAt,
  });
}

// Compile-time assignability pin; the `_` prefix exempts it from `no-unused-vars`.
type _AssertExtends<A extends B, B> = A;

// The probe-owed and no-probe states, pinned total over `WorkspaceState` and disjoint below, so a
// new workspace state fails a compile instead of landing on one side.
const PROBE_BEARING_STATE_ROSTER = ["ready", "busy"] as const satisfies readonly WorkspaceState[];
const NON_PROBE_BEARING_STATE_ROSTER = [
  "preparing",
  "stale",
  "archived",
] as const satisfies readonly WorkspaceState[];

type _AssertEveryWorkspaceStateHasAProbePolicy = _AssertExtends<
  WorkspaceState,
  (typeof PROBE_BEARING_STATE_ROSTER)[number] | (typeof NON_PROBE_BEARING_STATE_ROSTER)[number]
>;
type _AssertProbePolicyRostersAreDisjoint = _AssertExtends<
  Extract<
    (typeof PROBE_BEARING_STATE_ROSTER)[number],
    (typeof NON_PROBE_BEARING_STATE_ROSTER)[number]
  >,
  never
>;

/**
 * The workspace states that carry a live execution root and so owe a probe on read; exported so
 * the service can skip the I/O for the others. `preparing` has a root in flux, `stale` is already
 * the fault verdict and never auto-healed, and `archived` is terminal history.
 */
export const PROBE_BEARING_WORKSPACE_STATES: ReadonlySet<WorkspaceState> = new Set<WorkspaceState>(
  PROBE_BEARING_STATE_ROSTER,
);

// The complement, so `computeWorkspaceHealth` fails closed on a state outside the vocabulary.
const NON_PROBE_BEARING_WORKSPACE_STATES: ReadonlySet<WorkspaceState> = new Set<WorkspaceState>(
  NON_PROBE_BEARING_STATE_ROSTER,
);

/** The `workspaces` fields the health projection reads, structural like the mount row. */
export interface WorkspaceHealthRow {
  readonly state: WorkspaceState;
  // NULL until preparation completes, like the `workspaces.fs_root` column.
  readonly fsRoot: string | null;
}

/** One workspace's health: the state to report, and whether `markStale` must persist it. */
export interface WorkspaceHealthProjection {
  // The row's state, or `stale` when the probe found the root unavailable.
  readonly observedState: WorkspaceState;
  // The probe instant, or `null` when none is owed; daemon-internal, the wire carries `state` only.
  readonly checkedAt: string | null;
  readonly staleTransitionRequired: boolean;
}

/**
 * Projects a workspace's health from its row and the probe of its root. The probe is required for
 * a probe-bearing state and forbidden otherwise, and a mismatch throws rather than answering from
 * partial input. A reachable probe never heals a `stale` workspace.
 */
export function computeWorkspaceHealth(
  workspaceRow: WorkspaceHealthRow,
  probe: FilesystemPathProbe | null,
): WorkspaceHealthProjection {
  if (NON_PROBE_BEARING_WORKSPACE_STATES.has(workspaceRow.state)) {
    if (probe !== null) {
      throw new Error(
        `computeWorkspaceHealth: a workspace in state "${workspaceRow.state}" owes no ` +
          "execution-root probe, but one was supplied. Its verdict would be discarded (a " +
          "terminal or root-less workspace is not re-derived from the filesystem, and a stale " +
          "workspace is never auto-healed), so accepting it silently would hide a mispaired row " +
          "and probe.",
      );
    }
    return {
      observedState: workspaceRow.state,
      checkedAt: null,
      staleTransitionRequired: false,
    };
  }
  if (!PROBE_BEARING_WORKSPACE_STATES.has(workspaceRow.state)) {
    // Positive membership on both sides, so a state outside the closed vocabulary fails closed.
    throw new Error(
      "computeWorkspaceHealth: no probe policy is registered for workspace state " +
        `"${String(workspaceRow.state)}". Every value of the closed WorkspaceState union is ` +
        "either probe-bearing or not; a value outside that vocabulary is a corrupt row, and " +
        "answering it from either branch would guess at a policy no code defines.",
    );
  }
  if (workspaceRow.fsRoot === null) {
    throw new Error(
      `computeWorkspaceHealth: a workspace in state "${workspaceRow.state}" must carry a ` +
        "resolved fs_root; this row carries NULL. A probe-bearing state with no execution root " +
        "is a corrupt row — the preparation path sets fs_root whenever it writes either " +
        "state — and there is nothing to probe.",
    );
  }
  if (probe === null) {
    throw new Error(
      `computeWorkspaceHealth: a workspace in state "${workspaceRow.state}" requires an ` +
        "execution-root probe. Answering without one would report the row's own state as a " +
        "checked verdict, which is exactly the unobserved-staleness failure the on-read probe " +
        "floor exists to prevent.",
    );
  }
  assertProbeTargets(probe, workspaceRow.fsRoot, "workspace's execution root");
  // The only health transition derived here; a reachable root leaves the state untouched.
  const observedState: WorkspaceState = probe.reachable ? workspaceRow.state : "stale";
  return {
    observedState,
    checkedAt: probe.checkedAt,
    // Whether to persist it (a held `busy` row is not staled) is the workspace service's call.
    staleTransitionRequired: observedState !== workspaceRow.state,
  };
}

// The matrix is keyed by `vcs_type` alone: worktree availability is not probed at read time, and a
// mode that cannot be prepared fails at preparation.

/**
 * The modes a mount's workspace may take, its default, and a reason for each mode it may not take.
 * `restrictions` is omitted when nothing is restricted.
 */
interface ExecutionModeCapabilities {
  readonly availableModes: ExecutionMode[];
  readonly defaultMode: ExecutionMode;
  readonly restrictions?: Partial<Record<ExecutionMode, string>>;
}

/** One mode's standing for one kind of mount; the unavailable arm requires a reason. */
type ExecutionModeVerdict =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/**
 * The capability answer for one `vcs_type`. The `Record<ExecutionMode, ...>` makes the verdict
 * table total, so a mode added in contracts fails this compile.
 */
interface VcsTypeCapabilityProfile {
  readonly defaultMode: ExecutionMode;
  readonly modeVerdicts: Readonly<Record<ExecutionMode, ExecutionModeVerdict>>;
}

// A git mount: both modes, nothing restricted.
const GIT_CAPABILITY_PROFILE = {
  // Coding runs default to a worktree rather than mutating the main checkout.
  defaultMode: "provisioned-worktree",
  modeVerdicts: {
    "bound-root": { available: true },
    "provisioned-worktree": { available: true },
  },
} as const satisfies VcsTypeCapabilityProfile;

// The taxonomy order in which `availableModes` and `restrictions` are emitted, pinned total below.
const EXECUTION_MODES_IN_TAXONOMY_ORDER = [
  "bound-root",
  "provisioned-worktree",
] as const satisfies readonly ExecutionMode[];

type _AssertTaxonomyOrderIsExhaustive = _AssertExtends<
  ExecutionMode,
  (typeof EXECUTION_MODES_IN_TAXONOMY_ORDER)[number]
>;

/** The `repo_mounts` field the capability projection reads. */
export interface ExecutionModeCapabilityRow {
  readonly vcsType: VcsType;
}

/** Projects a mount's allowed execution modes, with a reason for each mode it does not allow. */
export function computeExecutionModeCapabilities(
  mountRow: ExecutionModeCapabilityRow,
): ExecutionModeCapabilities {
  return projectCapabilityProfile(capabilityProfileFor(mountRow.vcsType));
}

/**
 * Resolves the profile for one `vcs_type`. The `never` binding fails the compile for a new member,
 * and the throw fails closed for a raw database value instead of answering with git modes.
 */
function capabilityProfileFor(vcsType: VcsType): VcsTypeCapabilityProfile {
  switch (vcsType) {
    case "git":
      return GIT_CAPABILITY_PROFILE;
    default: {
      const unregisteredVcsType: never = vcsType;
      throw new Error(
        "computeExecutionModeCapabilities: no capability profile is registered for vcs_type " +
          `"${String(unregisteredVcsType)}". Every value of the closed VcsType union needs a ` +
          "profile — a mount whose capabilities cannot be projected must fail the read, never " +
          "receive another vcs_type's answer.",
      );
    }
  }
}

function projectCapabilityProfile(profile: VcsTypeCapabilityProfile): ExecutionModeCapabilities {
  // Built fresh per call: a shared array is one caller's `.push` from corrupting later responses.
  const availableModes: ExecutionMode[] = [];
  const restrictions: Partial<Record<ExecutionMode, string>> = {};
  for (const executionMode of EXECUTION_MODES_IN_TAXONOMY_ORDER) {
    const verdict: ExecutionModeVerdict = profile.modeVerdicts[executionMode];
    if (verdict.available) {
      availableModes.push(executionMode);
    } else {
      restrictions[executionMode] = verdict.reason;
    }
  }
  return {
    availableModes,
    defaultMode: profile.defaultMode,
    // Omitted, not `{}`, when nothing is restricted; the spread stops an explicit `undefined` key.
    ...(Object.keys(restrictions).length > 0 ? { restrictions } : {}),
  };
}

/**
 * Refuses a probe that measured something other than the row's own path. Compares bytes, not the
 * trust-envelope validator's normalized semantics, so a probe of a path that merely normalizes
 * alike is refused. Neither path appears in the message, as paths stay out of errors callers see.
 */
function assertProbeTargets(
  probe: FilesystemPathProbe,
  expectedPath: string,
  subjectDescription: string,
): void {
  if (probe.probedPath !== expectedPath) {
    throw new Error(
      `Health projection refused a probe that did not measure the ${subjectDescription}: the ` +
        "probed path and the row's path differ. Attributing another path's verdict to this row " +
        "would report a confident, wrong health answer, which no downstream surface can detect.",
    );
  }
}
