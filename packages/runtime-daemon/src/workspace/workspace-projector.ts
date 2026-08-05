// Repo-mount health, workspace health, and execution-mode capability
// projection — Plan-009 T2.5.
//
// PURE PROJECTION, per the shipped `session/session-projector.ts` precedent:
// no filesystem call, no clock read, no database handle, no I/O of any kind
// inside a fold. The service layer (`repo-mount-service.ts` /
// `workspace-service.ts`) performs the synchronous availability probe the
// on-read floor mandates and feeds the `{row, probe}` pair in; the functions
// below turn that pair into a verdict and nothing else. Probe inputs are
// caller-supplied ARGUMENTS, never imports — which is what lets every branch
// here be driven deterministically from a test without a temp directory.
//
// Spec coverage:
//   • `Spec-009 §Fallback Behavior` — "If a workspace cannot support one or
//     more git-backed execution modes, the daemon must expose that capability
//     gap explicitly rather than silently substituting a different mode", and
//     "If a workspace path becomes unavailable after binding, the workspace
//     transitions to `stale`".
//   • `Spec-009 §Interfaces And Contracts` — `WorkspaceExecutionModeCapabilitiesRead`
//     "must expose which execution modes are currently valid for the bound
//     repo mount or workspace".
//   • `Spec-009 §State And Data Implications` — "Repo health and git metadata
//     belong to daemon-owned projection state rather than client cache": the
//     verdicts below are computed per read, and no `health` column exists to
//     read them back from.
//   • `Spec-009 §Repo Mount Health (V1 Definition)` — mount health is the
//     daemon-probed reachability of the canonical root, `healthy` when that
//     root is present and readable at probe time and `unreachable` otherwise,
//     with `checkedAt` the instant of the probe that produced the verdict.
//   • `Spec-009 §Acceptance Criteria` — AC3, "Non-git directory workspaces
//     remain usable without pretending to support git-only features": the
//     plain-directory profile below keeps `read-only` available and refuses
//     the three git-backed modes WITH A REASON rather than by omission.
//
// Invariants carried here:
//   • I-009-7 — an unavailable execution root is observable as `stale` on
//     every daemon read surface. This module carries the DERIVATION half:
//     `computeWorkspaceHealth` answers `stale` for a probe-failed row and
//     reports that the transition is owed, so every read surface routed
//     through it observes the same verdict. The persistence half (the
//     `markStale` write) and the write gate (`assertWritable`) are the
//     workspace service's, and the "every read surface" universal is closed by
//     the producers routing their reads through this seam.
//   • I-009-8 — capability projection never silently substitutes a mode: every
//     mode absent from `availableModes` appears in `restrictions` with a
//     reason. Here that is STRUCTURAL, not merely tested. The per-vcs-type
//     profiles below are TOTAL over `ExecutionMode`, and the per-mode verdict
//     type admits an unavailable mode only WITH a reason string, so a mode
//     cannot be dropped from `availableModes` without one — the omission the
//     invariant forbids is unrepresentable rather than caught after the fact.
//
// ----------------------------------------------------------------------------
// Two-layer health detection (D-009-5): only layer 1 lands here
// ----------------------------------------------------------------------------
//
// Layer 1 is the ON-READ PROBE FLOOR — every health-reporting read surface and
// every write gate probes filesystem availability synchronously before
// answering, which is the layer this module projects and the layer that
// satisfies `Spec-009 §Fallback Behavior` on its own, with zero scheduler
// dependency.
//
// Layer 2 is the daemon-owned BACKGROUND REFRESH (`Spec-009 §Default
// Behavior`) — a periodic re-probe of attached mounts on a daemon idle
// scheduler. Its wiring is NOT here, deliberately: no idle scheduler exists
// in this package at Phase-2 time. The
// precedent D-009-5 points at, the Plan-006 compactor, exposes a `tick()` and
// deliberately declines to invent the scheduler that would own its cadence
// (its header: "The idle scheduler that owns `tick()` owns the precondition"),
// and nothing in production code calls that `tick()` yet. Declaring a
// scheduler seam here to hang a re-probe off would be a premature interface in
// exactly the way the compactor refused, so the background layer lands with
// Phase 3 per D-009-5's own carve-out. The on-read floor keeps the spec
// satisfied in the meantime.
//
// ----------------------------------------------------------------------------
// One scope only: this module projects capabilities from a MOUNT
// ----------------------------------------------------------------------------
//
// `repo.executionModeCapabilitiesRead` has two scopes (see the two-scopes note
// on `WorkspaceExecutionModeCapabilitiesReadRequest` in
// `@ai-sidekicks/contracts`): a MOUNT-scoped read answers "what could a
// workspace on this mount do", which is the static matrix below, and a
// WORKSPACE-scoped read answers "what may THIS workspace do now", which
// additionally narrows writable modes for a `stale` workspace per
// `Spec-009 §Fallback Behavior`. T2.5 is specified for the mount-keyed matrix
// only, so the per-workspace narrowing is an UNASSIGNED obligation of the
// workspace-scoped read path (T2.4's service plus the Phase-3 handler), not
// something answered here.
//
// Whoever lands it MUST route it through the same per-mode verdict shape:
// narrowing by filtering `availableModes` in a handler would drop a mode
// without a reason and violate I-009-8 at the one surface the invariant exists
// to protect. Restricting a mode means giving it a verdict with a reason, in
// every scope.
//
// Refs: Plan-009 (repo attachment and workspace binding), ADR-006 §Decision
// (the four-mode taxonomy and the worktree-first writable default), D-009-2
// (the health projection shape), D-009-5 (the static capability matrix and the
// two-layer health detection).

import {
  RepoMountHealthSchema,
  WorkspaceExecutionModeCapabilitiesReadResponseSchema,
  type ExecutionMode,
  type RepoMountHealth,
  type VcsType,
  type WorkspaceExecutionModeCapabilitiesReadResponse,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// Probe input — what the service layer measured, handed in
// --------------------------------------------------------------------------

/**
 * One synchronous filesystem availability measurement, performed by the
 * service layer and handed to a projection below. Deliberately not an
 * abstraction over HOW the probe ran: this module never learns whether it was
 * a `stat`, an `opendir`, or a cached kernel answer, because the projection is
 * the same either way.
 *
 * `probedPath` is what makes the measurement ATTRIBUTABLE. Every projection
 * that consumes a probe checks it against the path its row declares and
 * refuses a mismatch — see the subject-binding guards below. Without it, a
 * multi-mount list fold (`Spec-009 §Acceptance Criteria` AC2 guarantees a
 * session holds several mounts and several workspaces) that mispairs rows and
 * probes reports a confident, wrong verdict for both rows.
 */
export interface FilesystemPathProbe {
  // The absolute path the probe actually measured.
  readonly probedPath: string;
  // `true` when the path was present and readable at `checkedAt`
  // (`Spec-009 §Repo Mount Health (V1 Definition)`), `false` otherwise. Binary
  // because the verdict it feeds is binary: `RepoMountHealth.status` has
  // exactly two members, and D-009-2 rejects a third "we did not check" value
  // outright — the on-read floor means every read carries a fresh verdict.
  readonly reachable: boolean;
  // ISO 8601 instant of the measurement. The daemon's wall clock, read by the
  // service layer — never by this module, which owns no clock.
  readonly checkedAt: string;
}

// --------------------------------------------------------------------------
// Repo-mount health (D-009-2)
// --------------------------------------------------------------------------

/**
 * The `repo_mounts` fields the health projection reads — and ONLY those.
 * Narrow and structural on purpose, the same stance the sibling emitter takes
 * on its append seam: naming a full mount-row type here would pre-commit the
 * repo-mount service's row shape from a module that reads one column of it.
 *
 * `state` is deliberately absent. Mount health and mount lifecycle are
 * DISTINCT AXES (`Spec-009 §Repo Mount Health (V1 Definition)`: health is "the
 * daemon-probed reachability of the mount's canonical root", full stop, and
 * D-009-2 picks `"unreachable"` over `"stale"` precisely so the two
 * vocabularies cannot be confused). A `detached` mount whose root is still on
 * disk is `healthy`; folding the lifecycle state in would invent a semantics
 * neither the spec nor the ratified shape carries.
 */
export interface RepoMountHealthRow {
  // The resolver's absolute, symlink-resolved root — the path health is the
  // reachability OF, and the only path a mount health probe may target
  // (I-009-5: every trust-envelope and routing decision keys off
  // `canonical_root`, never `local_path`).
  readonly canonicalRoot: string;
}

/**
 * Project one mount's health from the probe of its canonical root — the
 * D-009-2 `{status, checkedAt}` derived projection, never a persisted column.
 *
 * Returns the value PARSED through `RepoMountHealthSchema` rather than the
 * object literal: this is a wire shape (`RepoMountReadResponse.health`
 * composes the same schema), so a malformed `checkedAt` fails HERE, at the
 * projection that produced it, instead of surviving to the outbound
 * response-validation boundary where the failure would be attributed to the
 * whole read rather than to the probe.
 */
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

// --------------------------------------------------------------------------
// Workspace health (I-009-7)
// --------------------------------------------------------------------------

// Same `_AssertExtends` idiom as the sibling emitter and contracts' event-core:
// a compile-time assignability pin, with the `_` prefix the root eslint
// config's `varsIgnorePattern` exempts from `no-unused-vars`. Declared locally
// rather than imported — a three-word type alias is not worth a module edge.
type _AssertExtends<A extends B, B> = A;

// The probe-owed / no-probe partition, spelled as two literal rosters so it can
// be pinned BOTH DIRECTIONS at compile time (the same pair-of-checks idiom as
// `EXECUTION_MODES_IN_TAXONOMY_ORDER` below): `satisfies` proves every element
// is a real state, and the two aliases beneath prove the pair is TOTAL over
// `WorkspaceState` and DISJOINT. A sixth workspace state added to contracts
// fails the totality pin here instead of silently landing on whichever side a
// runtime `!has(...)` negation happened to put it — the same silent-default
// threat `capabilityProfileFor` closes for `vcs_type` with its `never` guard.
const PROBE_BEARING_STATE_ROSTER = ["ready", "busy"] as const satisfies readonly WorkspaceState[];
const NON_PROBE_BEARING_STATE_ROSTER = [
  "provisioning",
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
 * The workspace states that carry a live execution root, and therefore the
 * states for which the on-read floor owes a probe. Exported because the
 * service layer must decide whether to perform the I/O BEFORE it can call
 * `computeWorkspaceHealth`, and the alternative to sharing this set is the
 * service re-deriving the same rule — two copies of one policy, free to drift.
 *
 * The three excluded states are excluded for three different reasons, and each
 * is load-bearing:
 *
 *   • `provisioning` — its execution root is in flux by definition
 *     (`Spec-009 §Execution Mode Transitions`: `fs_root` is updated as the
 *     switch completes). There is nothing stable to probe, and a failed probe
 *     of a half-provisioned root would report a fault where the model expects
 *     absence.
 *   • `stale` — already the fault verdict, and NOT auto-healed; see
 *     `computeWorkspaceHealth`.
 *   • `archived` — terminal (`Spec-009 §Detach Semantics (V1 Definition)`
 *     archives dependents and they stay historically linked to completed
 *     runs). A probe verdict cannot change a terminal row, and flipping one to
 *     `stale` would resurrect history into an active-fault state.
 */
export const PROBE_BEARING_WORKSPACE_STATES: ReadonlySet<WorkspaceState> = new Set<WorkspaceState>(
  PROBE_BEARING_STATE_ROSTER,
);

// The complement, module-private: the exported set alone is the policy a
// consumer needs (probe or don't), while this one exists so the dispatch in
// `computeWorkspaceHealth` can tell "owes no probe" from "state outside the
// vocabulary entirely" and fail closed on the latter.
const NON_PROBE_BEARING_WORKSPACE_STATES: ReadonlySet<WorkspaceState> = new Set<WorkspaceState>(
  NON_PROBE_BEARING_STATE_ROSTER,
);

/**
 * The `workspaces` fields the health projection reads — narrow and structural,
 * for the same reason as {@link RepoMountHealthRow}.
 */
export interface WorkspaceHealthRow {
  // The lifecycle position, which is also the workspace's HEALTH surface on
  // the wire (`WorkspaceListResponse.workspaces[].state`) — a workspace has no
  // second health object the way a mount does.
  readonly state: WorkspaceState;
  // The resolved execution root. `string | null`, matching the nullable
  // `workspaces.fs_root` column rather than the wire shape's optional
  // `fsRoot?: string` — a row is not a payload, and a writable bind
  // legitimately persists NULL until provisioning completes.
  readonly fsRoot: string | null;
}

/**
 * One workspace's health as of a read. `observedState` is what every daemon
 * read surface reports (I-009-7); `staleTransitionRequired` tells the service
 * whether that verdict is a CHANGE it must persist through `markStale`.
 */
export interface WorkspaceHealthProjection {
  // The state to report. Equal to the row's state except when a probe found
  // the execution root unavailable, in which case it is `stale`.
  readonly observedState: WorkspaceState;
  // Provenance of the verdict: the probe instant, or `null` for a row whose
  // state owes no probe (see {@link PROBE_BEARING_WORKSPACE_STATES}) — the two
  // nulls are one rule, not two cases. Daemon-internal, unlike
  // `RepoMountHealth.checkedAt`: workspace health rides the wire as `state`
  // alone, so this value has no response schema to satisfy and is not parsed.
  readonly checkedAt: string | null;
  // `true` iff `observedState` differs from the row — i.e. the service owes a
  // `markStale` write for the verdict just derived. Derived from that
  // comparison rather than tracked separately, so the two fields cannot
  // disagree.
  readonly staleTransitionRequired: boolean;
}

/**
 * Project one workspace's health from its row plus the probe of its execution
 * root, if its state owes one.
 *
 * NEVER AUTO-HEALS. A successful probe of a `stale` workspace's root reports
 * `stale`, unchanged. Two independent reasons, either sufficient: `stale` is
 * also written by a FAILED MODE SWITCH (`Spec-009 §Execution Mode
 * Transitions`, whose `metadata.lastError` records the detail), where the path
 * is perfectly reachable and nothing about the failure is repaired by the
 * path's existence; and the spec blocks write runs "until the workspace is
 * repaired or the mode switch is retried" — both explicit acts. Recovering a
 * workspace because a path reappeared would substitute a probe for the repair
 * the operator never performed. `stale` is therefore not probe-bearing at all,
 * and the caller is refused if it probes one.
 *
 * Fails closed on every row/probe pairing the model does not produce, rather
 * than answering from a partial input: a projection that quietly returned the
 * row's own state for a caller that skipped the probe would report `ready` for
 * a workspace nobody checked — the exact failure I-009-7 exists to prevent,
 * and one no downstream surface could detect.
 *
 * @param probe the measurement of `workspaceRow.fsRoot`, or `null` for a row
 *   whose state owes none. REQUIRED for a probe-bearing state and FORBIDDEN
 *   otherwise; either mismatch throws.
 */
export function computeWorkspaceHealth(
  workspaceRow: WorkspaceHealthRow,
  probe: FilesystemPathProbe | null,
): WorkspaceHealthProjection {
  if (NON_PROBE_BEARING_WORKSPACE_STATES.has(workspaceRow.state)) {
    if (probe !== null) {
      throw new Error(
        `computeWorkspaceHealth: a workspace in state "${workspaceRow.state}" owes no execution-root probe, ` +
          "but one was supplied. Its verdict would be discarded (a terminal or root-less workspace is not " +
          "re-derived from the filesystem, and a stale workspace is never auto-healed), so accepting it " +
          "silently would hide a mispaired row and probe.",
      );
    }
    return {
      observedState: workspaceRow.state,
      checkedAt: null,
      staleTransitionRequired: false,
    };
  }
  if (!PROBE_BEARING_WORKSPACE_STATES.has(workspaceRow.state)) {
    // Positive membership on BOTH sides, never a negation: a state string
    // outside the closed vocabulary (a raw database row past the compiler)
    // lands here rather than inheriting whichever branch a `!has(...)` would
    // have handed it. Guessing either policy would answer a health read from
    // a row the model does not describe.
    throw new Error(
      `computeWorkspaceHealth: no probe policy is registered for workspace state "${String(workspaceRow.state)}". ` +
        "Every value of the closed WorkspaceState union is either probe-bearing or not; a value outside " +
        "that vocabulary is a corrupt row, and answering it from either branch would guess at a policy " +
        "nobody ratified.",
    );
  }
  if (workspaceRow.fsRoot === null) {
    throw new Error(
      `computeWorkspaceHealth: a workspace in state "${workspaceRow.state}" must carry a resolved fs_root; ` +
        "this row carries NULL. A probe-bearing state with no execution root is a corrupt row — the bind " +
        "and reprovision paths set fs_root before either state is written — and there is nothing to probe.",
    );
  }
  if (probe === null) {
    throw new Error(
      `computeWorkspaceHealth: a workspace in state "${workspaceRow.state}" requires an execution-root probe. ` +
        "Answering without one would report the row's own state as a checked verdict, which is exactly the " +
        "unobserved-staleness failure the on-read probe floor exists to prevent.",
    );
  }
  assertProbeTargets(probe, workspaceRow.fsRoot, "workspace's execution root");
  // The ONLY health transition this projection derives. A reachable root
  // leaves the row's state untouched — `busy` stays `busy`, and this module
  // takes no position on run holds.
  const observedState: WorkspaceState = probe.reachable ? workspaceRow.state : "stale";
  return {
    observedState,
    checkedAt: probe.checkedAt,
    // Which transitions are LEGAL to persist (notably `busy -> stale`, where a
    // run is holding the workspace whose root just vanished) is the workspace
    // service's call, not this module's. The projection reports what a reader
    // must be told; the service decides what it may write.
    staleTransitionRequired: observedState !== workspaceRow.state,
  };
}

// --------------------------------------------------------------------------
// Execution-mode capabilities — the D-009-5 V1 static matrix (I-009-8)
// --------------------------------------------------------------------------
//
// STATIC BY `vcs_type`, by ratified decision. V1 does NOT probe per-repository
// worktree availability at capability-read time (the ADR-006 accepted
// trade-off): that surfaces at provisioning time through the
// `Spec-009 §Execution Mode Transitions` failure path, which is Plan-010's
// surface. A later probe-derived matrix extends `restrictions` additively
// without a contract change, which is why the verdict table below is keyed by
// mode rather than by a boolean list.

/**
 * One mode's standing for one kind of mount. The unavailable arm REQUIRES a
 * reason, and that requirement is the whole design: it is what makes I-009-8
 * ("every mode absent from `availableModes` appears in `restrictions` with a
 * reason") a property of the type rather than of a test. A mode cannot be
 * excluded silently because there is no way to spell an exclusion without
 * saying why.
 */
type ExecutionModeVerdict =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/**
 * The capability answer for one `vcs_type`, before it is folded into the wire
 * shape. `Record<ExecutionMode, ...>` makes the verdict table TOTAL over the
 * canonical four-mode taxonomy — a fifth mode registered in contracts fails
 * THIS compile rather than silently arriving with no standing at all, which
 * would leave it neither available nor restricted.
 */
interface VcsTypeCapabilityProfile {
  readonly defaultMode: ExecutionMode;
  readonly modeVerdicts: Readonly<Record<ExecutionMode, ExecutionModeVerdict>>;
}

// The shared premise of all three plain-directory refusals, factored out so
// the three reasons cannot drift into three different accounts of one fact.
const PLAIN_DIRECTORY_PREMISE = "This repo mount is a plain directory, not a git repository, so";

// A git-backed mount: the full ADR-006 §Decision taxonomy, nothing restricted.
const GIT_CAPABILITY_PROFILE = {
  // ADR-006 §Decision — writable coding runs default to dedicated `worktree`
  // execution rather than mutating the main checkout. This reports the default
  // for the next WRITABLE run and is NOT the fresh-workspace posture, which is
  // always `read-only` (`Spec-009 §Default Behavior`, and the
  // `workspaces.execution_mode` DDL default). The two disagree by design.
  defaultMode: "worktree",
  modeVerdicts: {
    "read-only": { available: true },
    branch: { available: true },
    worktree: { available: true },
    "ephemeral clone": { available: true },
  },
} as const satisfies VcsTypeCapabilityProfile;

// A plain-directory mount (D-009-4's single funnel): usable, with the
// git-backed modes refused BY REASON rather than by omission —
// `Spec-009 §Acceptance Criteria` AC3, "usable without pretending to support
// git-only features". The reasons ride the wire verbatim and are rendered
// verbatim by the renderer (I-009-14), so they are written for an operator.
const PLAIN_DIRECTORY_CAPABILITY_PROFILE = {
  // The only available mode is necessarily the default. There is no writable
  // mode to prefer, and D-009-5 names `read-only` here explicitly.
  defaultMode: "read-only",
  modeVerdicts: {
    "read-only": { available: true },
    branch: {
      available: false,
      reason: `${PLAIN_DIRECTORY_PREMISE} there is no branch to create or check out.`,
    },
    worktree: {
      available: false,
      reason: `${PLAIN_DIRECTORY_PREMISE} no git worktree can be provisioned from it.`,
    },
    "ephemeral clone": {
      available: false,
      reason: `${PLAIN_DIRECTORY_PREMISE} there is no repository to clone.`,
    },
  },
} as const satisfies VcsTypeCapabilityProfile;

// The canonical taxonomy in `ADR-006 §Decision` order, which is the order
// `availableModes` and `restrictions` are emitted in — deterministic output,
// so a test may compare against a literal array and a reader sees the modes in
// the order every document lists them.
//
// The pair of checks is what makes this a faithful enumeration rather than a
// hand-kept list: `satisfies` proves every ELEMENT is a real mode, and the
// assertion below proves every MODE is an element. Neither direction alone
// would catch a mode added to contracts and forgotten here.
const EXECUTION_MODES_IN_TAXONOMY_ORDER = [
  "read-only",
  "branch",
  "worktree",
  "ephemeral clone",
] as const satisfies readonly ExecutionMode[];

type _AssertTaxonomyOrderIsExhaustive = _AssertExtends<
  ExecutionMode,
  (typeof EXECUTION_MODES_IN_TAXONOMY_ORDER)[number]
>;

/**
 * The `repo_mounts` field the capability projection reads — narrow and
 * structural, for the same reason as {@link RepoMountHealthRow}.
 */
export interface ExecutionModeCapabilityRow {
  // The honest git/non-git verdict fixed at resolution time (I-009-4). The
  // capability matrix keys off it and off nothing else, which is why a
  // misclassified mount makes this projection lie about git-backed modes.
  readonly vcsType: VcsType;
}

/**
 * Project the execution modes a workspace on this mount may use, with an
 * explicit reason for every mode it may not (I-009-8).
 *
 * The answer depends on the mount's `vcs_type` and on nothing else in V1 — see
 * the static-matrix note above, and the two-scopes note in the file header for
 * why a per-workspace answer is a different surface.
 */
export function computeExecutionModeCapabilities(
  mountRow: ExecutionModeCapabilityRow,
): WorkspaceExecutionModeCapabilitiesReadResponse {
  return projectCapabilityProfile(capabilityProfileFor(mountRow.vcsType));
}

/**
 * Resolve the profile for one `vcs_type`. A `switch` with a `never` default
 * rather than a lookup table: the `never` binding makes a third `VcsType`
 * member fail this compile, AND the throw fails closed at runtime for a value
 * that reached here past the compiler (a raw database row, a plain-JS caller).
 * Answering an unrecognized `vcs_type` with the git profile would hand a
 * caller four modes for a mount that supports one; answering with the
 * plain-directory profile would hide git modes from a real repository. There
 * is no safe default, so there is no default.
 */
function capabilityProfileFor(vcsType: VcsType): VcsTypeCapabilityProfile {
  switch (vcsType) {
    case "git":
      return GIT_CAPABILITY_PROFILE;
    case "none":
      return PLAIN_DIRECTORY_CAPABILITY_PROFILE;
    default: {
      const unregisteredVcsType: never = vcsType;
      throw new Error(
        "computeExecutionModeCapabilities: no capability profile is registered for vcs_type " +
          `"${String(unregisteredVcsType)}". Every value of the closed VcsType union needs a profile — ` +
          "a mount whose capabilities cannot be projected must fail the read, never receive another " +
          "vcs_type's answer.",
      );
    }
  }
}

/**
 * Fold one profile's verdict table into the wire shape. Every mode lands in
 * exactly one of the two outputs, in taxonomy order — the partition is the
 * mechanism behind I-009-8, and it is total because the table is.
 */
function projectCapabilityProfile(
  profile: VcsTypeCapabilityProfile,
): WorkspaceExecutionModeCapabilitiesReadResponse {
  // Mutable, matching the wire shape's `ExecutionMode[]` (the canonical doc
  // spells it mutable), and freshly built PER CALL rather than memoized off
  // the static profile: a shared array handed to every caller is one caller's
  // `.push` away from corrupting every later response.
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
    // OMITTED ENTIRELY when nothing is restricted, not sent as `{}` — the wire
    // shape declares `restrictions` optional and the canonical doc omits the
    // whole field for an unrestricted answer. The declared `| undefined` means
    // an explicit `undefined` key would still type-check, so the omission is
    // enforced here by the conditional spread, not by the compiler.
    ...(Object.keys(restrictions).length > 0 ? { restrictions } : {}),
  };
}

// --------------------------------------------------------------------------
// Shared guards
// --------------------------------------------------------------------------

/**
 * Refuse a probe that measured something other than the row's own path.
 *
 * BYTE EQUALITY, deliberately not the case-folded, component-aware comparison
 * the trust-envelope validator performs. Those semantics answer "is this path
 * inside that one" for USER-SUPPLIED input; this guard answers "did the caller
 * probe the row it handed me", and the caller's only lawful source for
 * `probedPath` is the very row it passed — both values are daemon-produced and
 * already canonical. A normalizing comparison would accept a probe of a
 * DIFFERENT path that merely normalizes alike, which is the case this guard
 * exists to catch.
 *
 * Neither path appears in the message: a daemon error can reach a remote
 * caller through the JSON-RPC error mapping, and filesystem paths are not
 * disclosed there (the same sanitization discipline that keeps the attempted
 * path out of a trust-envelope violation). The call site identifies the
 * mispairing without them.
 */
function assertProbeTargets(
  probe: FilesystemPathProbe,
  expectedPath: string,
  subjectDescription: string,
): void {
  if (probe.probedPath !== expectedPath) {
    throw new Error(
      `Health projection refused a probe that did not measure the ${subjectDescription}: the probed path ` +
        "and the row's path differ. Attributing another path's verdict to this row would report a " +
        "confident, wrong health answer, which no downstream surface can detect.",
    );
  }
}

// --------------------------------------------------------------------------
// Static-matrix validation, once at import
// --------------------------------------------------------------------------

// Every `vcs_type`, pinned both directions like the rosters above: `satisfies`
// proves each element is a real member, and the alias beneath proves no member
// is missing — so a third `VcsType` cannot leave the validation below silently
// covering a subset of the profiles `capabilityProfileFor` dispatches to.
const ALL_VCS_TYPES = ["git", "none"] as const satisfies readonly VcsType[];
type _AssertVcsTypeRosterIsComplete = _AssertExtends<VcsType, (typeof ALL_VCS_TYPES)[number]>;

/**
 * Parse each profile's projection through the canonical response schema and
 * check that its `defaultMode` is one a caller may actually use.
 *
 * Driven by the pinned `ALL_VCS_TYPES` roster THROUGH `capabilityProfileFor`,
 * not over a hand-kept profile list: in a module whose thesis is that
 * hand-kept lists drift, the validator's own enumeration must not be one. A
 * profile reachable from the dispatch cannot be skipped here, and the dispatch
 * itself is exercised once per member at import.
 *
 * At IMPORT, not per call: the matrix is static, so a violation is a source
 * defect, and the import-time throw surfaces it in every consumer and every
 * test run rather than on the first capability read against a real mount. Same
 * posture as the sibling emitter's import-time parse of its envelope version.
 *
 * The schema pass is not ceremony — it is what bounds each reason string
 * against the ratified restriction-reason cap. An over-long reason would
 * otherwise persist happily here and fail outbound response validation at the
 * wire (I-009-10 validates both directions), turning a wordy sentence into a
 * broken read surface.
 */
function validateStaticCapabilityMatrix(): void {
  for (const vcsType of ALL_VCS_TYPES) {
    const capabilities: WorkspaceExecutionModeCapabilitiesReadResponse = projectCapabilityProfile(
      capabilityProfileFor(vcsType),
    );
    WorkspaceExecutionModeCapabilitiesReadResponseSchema.parse(capabilities);
    if (!capabilities.availableModes.includes(capabilities.defaultMode)) {
      throw new Error(
        `Static capability matrix is inconsistent for vcs_type "${vcsType}": defaultMode ` +
          `"${capabilities.defaultMode}" is not among the available modes ` +
          `[${capabilities.availableModes.join(", ")}]. Reporting a default a caller may not select is ` +
          "the silent substitution the capability projection exists to prevent.",
      );
    }
  }
}

validateStaticCapabilityMatrix();
