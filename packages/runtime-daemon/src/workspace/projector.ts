// Pure projection of repo-mount health and workspace health. Nothing here touches the filesystem,
// git, a clock or a database: the service layer probes and hands in the row with what it observed.
// An unavailable execution root reads as `stale` on every read surface, detected on read only;
// `markStale` and `assertWritable` belong to the workspace service.

import {
  RepoMountHealthSchema,
  type RepoMountHealth,
  type WorkspaceState,
} from "@ai-sidekicks/contracts/repo/mount";

/**
 * One synchronous filesystem measurement, handed in by the service layer. Every projection checks
 * `probedPath` against its row's path and refuses a mismatch, so a mispaired fold cannot report a
 * wrong verdict.
 */
export interface FilesystemPathProbe {
  readonly probedPath: string;
  // Reachability only; a mount's identity is observed separately, from git.
  readonly reachable: boolean;
  readonly checkedAt: string;
}

/**
 * The `repo_mounts` facts the health projection reads. Lifecycle `state` is absent on purpose:
 * health is the root's reachability and identity, so a `detached` mount whose root is on disk and
 * still holds its repository is `healthy`.
 */
export interface RepoMountHealthRow {
  readonly canonicalRoot: string;
  /** The git common directory recorded at attach; `null` on a mount that carries none. */
  readonly commonDirAnchor: string | null;
}

/**
 * The repository git found at a reachable, anchored root: the anchored one, another one, or none
 * when git does not answer the root as a repository's working tree.
 */
export interface RepoMountIdentityObservation {
  readonly repository: "anchored" | "other" | "none";
}

/**
 * Projects a mount's health. `unreachable` comes first, since nothing more can be asked of a root
 * that cannot be probed; then `identity_mismatch` when the observed repository is not the anchored
 * one. An identity observation is required exactly when the root is reachable and anchored, and a
 * mismatch of probe and row throws.
 */
export function computeRepoMountHealth(
  mountRow: RepoMountHealthRow,
  probe: FilesystemPathProbe,
  identity: RepoMountIdentityObservation | null,
): RepoMountHealth {
  assertProbeTargets(probe, mountRow.canonicalRoot, "repo mount's canonical root");
  const owesIdentity = probe.reachable && mountRow.commonDirAnchor !== null;
  if (owesIdentity !== (identity !== null)) {
    throw new Error(
      "computeRepoMountHealth: an identity observation is owed exactly when the root is " +
        "reachable and the mount carries an anchor; answering from a mispaired observation " +
        "would report a verdict nothing measured.",
    );
  }
  if (!probe.reachable) {
    return RepoMountHealthSchema.parse({ status: "unreachable", checkedAt: probe.checkedAt });
  }
  if (identity === null || mountRow.commonDirAnchor === null) {
    return RepoMountHealthSchema.parse({ status: "healthy", checkedAt: probe.checkedAt });
  }
  if (identity.repository === "none") {
    return RepoMountHealthSchema.parse({
      status: "identity_mismatch",
      isRepository: false,
      checkedAt: probe.checkedAt,
    });
  }
  return RepoMountHealthSchema.parse(
    identity.repository === "anchored"
      ? { status: "healthy", checkedAt: probe.checkedAt }
      : { status: "identity_mismatch", isRepository: true, checkedAt: probe.checkedAt },
  );
}

// Compile-time assignability pin; the `_` prefix exempts it from `no-unused-vars`.
type _AssertExtends<A extends B, B> = A;

// The probe-owed and no-probe states, pinned total over `WorkspaceState` and disjoint below, so a
// new workspace state fails a compile instead of landing on one side.
const PROBE_BEARING_STATE_ROSTER = ["ready"] as const satisfies readonly WorkspaceState[];
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
    staleTransitionRequired: observedState !== workspaceRow.state,
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
