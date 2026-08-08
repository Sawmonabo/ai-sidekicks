// Typed carriers for every Plan-010 error code — the `worktree.*` and
// `clone.*` namespaces in full, plus the three `workspace.*` rows this plan
// INTRODUCES (Plan-010 Phase 2 T2.2).
//
// Spec coverage:
//   * `Spec-010 §Resolved Questions and V1 Scope Decisions` — the
//     provenance-split collision policy ("a caller-supplied branch name that
//     collides with a live checkout is refused with the typed collision
//     error — user intent is never silently adapted"), the base-ref policy
//     ("preparation against a detached-HEAD mount with no explicit base ref is
//     refused rather than guessed"), and the branch-mode bind-only rule ("a
//     mismatch is a typed refusal"). The refusals are
//     {@link WorktreeBranchCollisionError}, {@link WorktreeCreateFailedError}
//     and {@link WorkspaceBranchMismatchError}.
//   * `Spec-010 §Fallback Behavior` — "if an intended reuse candidate is dirty
//     or incompatible with the requested branch strategy, the system must
//     require explicit user choice", and "a candidate that becomes dirty
//     between check and bind is refused rather than silently bound; a candidate
//     incompatible with the requested branch strategy is never bindable". The
//     refusal is {@link WorktreeReuseConflictError}. The same section's
//     blocked-in-setup disposition is what
//     {@link WorkspaceExecutionRootUnresolvedError} reports.
//   * `error-contracts.md §Worktree` + `§Ephemeral Clone` + `§Workspace` — the
//     ratified registries (D-010-4) these classes carry. Every code string and
//     notional HTTP status below is quoted from those tables; this module mints
//     none.
//
// Invariants carried here (canonical text in
// `docs/plans/010-worktree-lifecycle-and-execution-modes.md` §Invariants):
//   * I-010-4 (active-branch uniqueness) — CARRIER leg only: the typed
//     collision signal a service raises when the partial-unique
//     `idx_worktrees_active_branch` arbitrates a refusing collision. The
//     index-arbitrated insert-retry that produces it binds on
//     `worktree-service.ts`.
//   * I-010-7 (no silent mode substitution) — carrier leg: prepare-time
//     unavailability is `worktree.create_failed` / `clone.prepare_failed`,
//     never a substituted mode. Select-time capability refusal stays on
//     Plan-009's `workspace.mode_unsupported`, which is why no
//     `worktree.unsupported` code exists here (D-010-4 states the omission
//     explicitly).
//   * I-010-8 (explicit reuse only) — carrier leg: a dirty candidate without
//     acknowledgement, and an incompatible candidate with or without one, both
//     refuse through {@link WorktreeReuseConflictError}. The verdicts bind on
//     `worktree-service.ts`'s `validateReuse`.
//
// ---------------------------------------------------------------------------
// SCOPE: ten classes, and the one code deliberately ABSENT
// ---------------------------------------------------------------------------
//
// D-010-4's §Workspace extension list names FOUR codes, and only THREE of them
// are Plan-010's to declare. `workspace.busy` (409) is already shipped and
// Plan-009-owned — `WorkspaceBusyError` in
// `../workspace/workspace-service.ts`, raised by `markBusy` under CP-009-7's
// one-holding-run rule. Re-declaring it here would fork a live symbol: two
// classes minting one code, with `instanceof` discrimination silently
// depending on which module a throw site imported. Plan-010 consumes that
// carrier through the Plan-009 primitive it belongs to (CP-010-4) and declares
// it nowhere. T2.2 does not even raise it: the retire path's refusal is
// `worktree.retire_conflict`, its own code.
//
// The same rule keeps `repo.not_found` out of this file. A `create` naming a
// mount that does not resolve raises Plan-009's `RepoMountNotFoundError`
// (`../workspace/repo-errors.js`) rather than a Plan-010 re-mint.
//
// ---------------------------------------------------------------------------
// Why these extend `DaemonDomainError`
// ---------------------------------------------------------------------------
//
// The base (`../ipc/domain-error.js`) is projected by a SINGLE `instanceof`
// branch in `mapJsonRpcError`, so all ten reach the wire with no per-class
// mapper edit: `code` becomes the envelope's `data.type` and `detail` becomes
// `data.fields` (through that module's `sanitizeFields` seam). This is the
// path Plan-010 ratifies rather than an implementation liberty — the plan's
// Phase-3 §Preconditions track BL-143 as the landed precondition without which
// T3.8's wire assertions would observe anonymous `-32603` errors instead of
// the ratified codes, and T2.2's `Consumes` names the base class shape as its
// only dependency on it. This file is a Phase-2 CARRIER declaration; no phase
// edits `jsonrpc-error-mapping.ts` on its behalf.
//
// `jsonRpcCode` is set on exactly the TWO not-found carriers. The base class
// fixes that rule — "a not-found namespace error rides `-32602`, like
// `session.not_found`", a supplied id that does not resolve being structurally
// a param-shape failure — and BL-143 landed `repo.not_found` at `-32602` as
// its worked example on both sides of the wire, with `workspace.not_found`
// following it. The other eight stay UNSET, taking the mapper's documented
// `-32603` default with the dotted identifier in `data.type`: no numeric is
// ratified for their rows, and selecting one here would be this file inventing
// wire behavior Phase 3 then has to honor. `httpStatus` IS fixed per class,
// verbatim from the registries' status columns.
//
// ---------------------------------------------------------------------------
// Message discipline — no filesystem paths, by construction
// ---------------------------------------------------------------------------
//
// `error-contracts.md §Worktree` requires that failure messages "MUST NOT echo
// attempted filesystem paths (error-sanitization discipline, same posture as
// §Repo)", and `§Ephemeral Clone` adopts the same posture. Rather than leave
// that to throw-site discipline, NO class here accepts a caller-supplied
// message: every message is derived from the class and its own arguments, so
// no prose channel exists through which a path could travel.
//
// What the arguments themselves may carry is bounded the same way and is
// uneven by design, exactly as `../workspace/repo-errors.js`'s is:
//
//   * The three DISCRIMINANT-BEARING carriers
//     ({@link WorktreeCreateFailedError}, {@link WorktreeReuseConflictError},
//     {@link ClonePrepareFailedError}) admit a closed reason enum and nothing
//     else, so their whole message is a table lookup. A git `stderr` capture —
//     the one value on these paths most likely to contain a path — has no
//     channel to reach any of them.
//
//     {@link ClonePrepareFailedError} took no argument at all when T2.2
//     declared it, deliberately: T2.3 owned the clone-prepare failure
//     taxonomy, and minting a discriminant here on its behalf would have
//     pre-committed every downstream importer to a shape no ratified surface
//     asked for. T2.3 has since supplied it from its five real throw sites
//     ({@link ClonePrepareFailureReason}) — the additive widening that
//     argument-free staging was holding open, taken by the task that owns the
//     taxonomy rather than guessed by the one that declared the carrier.
//   * The ID- and REF-bearing carriers interpolate opaque identifiers (mount /
//     worktree / clone / workspace ids) and git REF NAMES (branch names) into
//     `message` and `detail`. Neither class is a path: ids are opaque scalars
//     by daemon convention, and a branch name is the value the caller itself
//     supplied on the wire, capped at `WORKTREE_GIT_REF_MAX_LEN`. The
//     substrate's `sanitizeErrorMessage` / `sanitizeFields` is the enforcing
//     layer should a caller ever pass something path-shaped.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { DaemonDomainError } from "../ipc/domain-error.js";

// ==========================================================================
// Code registries
// ==========================================================================
//
// THREE unions rather than one, mirroring the three `error-contracts.md`
// sections these codes are ratified in. A single flat union would read as one
// registry and would quietly obscure the §Workspace asymmetry that matters
// most here: that section is SHARED, Plan-009 owns four of its rows
// (`workspace.busy` among them — see the header), and Plan-010 introduces
// three. Splitting makes each union a faithful census of one section's
// Plan-010 membership, and makes the `satisfies` pin on every `super()` call
// below name the section it is quoting from.
//
// Type-bound locally rather than imported from `packages/contracts`: the
// strings are daemon-internal in Phase 2, and the hoist-to-contracts question
// first has a consumer at Phase 3, where the SDK observes them on the wire —
// the same staging `../workspace/repo-errors.js` records for the `repo.*`
// five.
//
// Note the asymmetry between the compile-time and instance-level surfaces.
// Each `super()` call pins its literal with `satisfies`, so a mistyped code
// fails to compile — but the base declares `code` as `string` and the
// subclasses deliberately do NOT redeclare it (under `useDefineForClassFields`
// an uninitialized redeclaration is emitted as a field and would clobber the
// value the base constructor just assigned). Instances therefore expose
// `code: string`; consumers discriminate by `instanceof`, never by narrowing
// `code`.

/** The five `error-contracts.md §Worktree` codes (D-010-4), in row order. */
export type WorktreeErrorCode =
  | "worktree.not_found"
  | "worktree.create_failed"
  | "worktree.branch_collision"
  | "worktree.reuse_conflict"
  | "worktree.retire_conflict";

/**
 * Runtime companion to {@link WorktreeErrorCode}, in `§Worktree` row order.
 * Exported so a suite can pin set-equality against the codes the carriers
 * actually emit — catching a registry row that gained no carrier and a carrier
 * that minted an unregistered code. Set-equality alone cannot see a carrier the
 * suite forgot to enumerate, so the suite pairs it with a census of this
 * module's exported constructors.
 *
 * Annotated explicitly: the package inherits `isolatedDeclarations` from the
 * root `tsconfig.base.json`, under which an un-annotated exported const fails
 * TS9010.
 */
export const WORKTREE_ERROR_CODES: readonly WorktreeErrorCode[] = [
  "worktree.not_found",
  "worktree.create_failed",
  "worktree.branch_collision",
  "worktree.reuse_conflict",
  "worktree.retire_conflict",
];

/** The two `error-contracts.md §Ephemeral Clone` codes (D-010-4), in row order. */
export type EphemeralCloneErrorCode = "clone.not_found" | "clone.prepare_failed";

/** Runtime companion to {@link EphemeralCloneErrorCode}, in `§Ephemeral Clone` row order. */
export const EPHEMERAL_CLONE_ERROR_CODES: readonly EphemeralCloneErrorCode[] = [
  "clone.not_found",
  "clone.prepare_failed",
];

/**
 * The three `error-contracts.md §Workspace` rows Plan-010 INTRODUCES (D-010-4).
 *
 * A strict SUBSET of that section, and the exclusions are the contract rather
 * than an omission. `workspace.not_found`, `workspace.provisioning_failed`,
 * `workspace.mode_unsupported`, `workspace.stale` and `workspace.busy` are
 * Plan-009's rows with Plan-009 carriers (`../workspace/workspace-service.js`);
 * naming any of them here would either fork a live class or advertise a code
 * no Plan-010 module raises. The prefixed name distinguishes this union from
 * Plan-009's `WorkspaceServiceErrorCode`, which is the census for the OTHER
 * side of the same section.
 */
export type Plan010WorkspaceErrorCode =
  | "workspace.branch_mismatch"
  | "workspace.execution_root_unresolved"
  | "workspace.branch_name_required";

/** Runtime companion to {@link Plan010WorkspaceErrorCode}, in `§Workspace` row order. */
export const PLAN_010_WORKSPACE_ERROR_CODES: readonly Plan010WorkspaceErrorCode[] = [
  "workspace.branch_mismatch",
  "workspace.execution_root_unresolved",
  "workspace.branch_name_required",
];

// ==========================================================================
// Closed failure discriminants
// ==========================================================================

/**
 * Why worktree creation failed. Closed and non-path-bearing, so the
 * discriminant is safe to carry all the way to the wire — the same shape as
 * `RepoRootResolutionReason` in `../workspace/repo-errors.js`, and as the
 * ratified `transport.invalid_protocol_version` `{ reason }` payload.
 *
 * Six members. Five are reachable from `worktree-service.ts`'s `create` and are
 * listed in the order it reaches them; the sixth, `branch_name_underivable`,
 * belongs to `deriveWorktreeBranchName` alone — see its entry.
 *
 *   * `base_ref_option_like` — the supplied `baseRef` begins with `-`. The
 *     field reaches `git worktree add` in the POSITIONAL commit-ish slot and
 *     D-010-8 gives it no pre-git validation, so a leading-dash value would be
 *     consumed as an OPTION rather than as a commit-ish: git's `parse_options`
 *     keeps scanning for options after a non-option argument. This is the
 *     option-injection obligation `packages/contracts/src/worktree.ts` assigns
 *     to T2.2 at `WORKTREE_GIT_REF_MAX_LEN`, discharged by refusal before any
 *     git call (the alternative discharge — a `--` separator before the
 *     positionals — is left to the acceptance tier that can verify `git
 *     worktree add` honors one).
 *   * `base_ref_unresolved` — no `baseRef` was supplied and the mount's `HEAD`
 *     could not be resolved to a branch. D-010-8's detached-HEAD refusal is
 *     the headline case; a `HEAD` query that did not complete at all lands
 *     here too, deliberately, because both leave the daemon without a base and
 *     the decision that matters is the same one — refuse rather than guess.
 *   * `branch_name_unavailable` — the D-010-7 `suffix` arm exhausted its
 *     ordinal budget without finding a free name, or the next candidate — the
 *     caller's own name included — would exceed `WORKTREE_GIT_REF_MAX_LEN`,
 *     which T2.5's status projection enforces on every response. Both are one
 *     answer: the request's policy has no usable name left.
 *   * `execution_root_unavailable` — the execution root's parent directory
 *     could not be prepared under the daemon's execution-roots directory
 *     (D-010-6).
 *   * `git_invocation_failed` — the `git worktree add` invocation did not
 *     complete successfully. This is also where D-010-4's "prepare-time
 *     dynamic worktree unavailability" lands, per its explicit ruling that
 *     such a failure is `worktree.create_failed` and never a
 *     `worktree.unsupported` that does not exist.
 *
 * And the sixth, last in the union so the create-reachable five read as one
 * contiguous block:
 *
 *   * `branch_name_underivable` — neither derivation input was usable (a
 *     queue-item summary that slugifies to something non-empty, or a run id
 *     for the `run-<short-id>` fallback). Raised by `deriveWorktreeBranchName`
 *     and reachable ONLY through a direct call to it. `create` cannot reach
 *     it: by D-010-19 that seam takes `branchName` REQUIRED and holds no
 *     derivation inputs at all, because the name is resolved one layer up — at
 *     the run-setup gate, the sole holder of the queue-item summary. It is
 *     deliberately NOT `workspace.branch_name_required`: that code is the WIRE
 *     refusal and names the workspace, which neither the derivation helper nor
 *     the worktree service holds — `create` takes no `workspaceId` at all. A
 *     wire-initiated prepare refuses with the workspace-scoped code; this
 *     reason is what keeps the derivation helper total for a caller that
 *     reaches it directly.
 */
export type WorktreeCreateFailureReason =
  | "base_ref_option_like"
  | "base_ref_unresolved"
  | "branch_name_unavailable"
  | "execution_root_unavailable"
  | "git_invocation_failed"
  | "branch_name_underivable";

/**
 * Fixed, path-free message per creation-failure reason. A lookup rather than
 * interpolation, so the text cannot vary with throw-site input — in
 * particular, so a git `stderr` capture has no route into it. Typing it as a
 * total `Record` over the union makes a future reason without a message a
 * compile error rather than an `undefined` message (the
 * `ROOT_RESOLUTION_MESSAGES` discipline in `../workspace/repo-errors.js`).
 */
const WORKTREE_CREATE_FAILURE_MESSAGES: Record<WorktreeCreateFailureReason, string> = {
  base_ref_option_like:
    "worktree creation failed: the supplied base ref begins with '-' and would be read as a git option rather than as a commit-ish",
  base_ref_unresolved:
    "worktree creation failed: no base ref was supplied and the repo mount's HEAD does not resolve to a branch",
  branch_name_unavailable:
    "worktree creation failed: no usable branch name was available under the request's collision policy and the ref-length cap",
  execution_root_unavailable:
    "worktree creation failed: the daemon execution root could not be prepared",
  git_invocation_failed: "worktree creation failed: the git worktree invocation did not complete",
  branch_name_underivable:
    "worktree creation failed: no branch name could be derived, since neither a slugifiable summary nor a run id was available",
};

/**
 * Why an explicitly named reuse candidate cannot bind (D-010-15). Closed and
 * non-path-bearing, for the same reason {@link WorktreeCreateFailureReason} is.
 *
 * Five members over the four checks `validateReuse`'s own contract names —
 * mount, liveness, branch, cleanliness — evaluated cheapest and most
 * fundamental first, so no git process is spawned for a candidate that is
 * already doomed. The last TWO members both arise from the single cleanliness
 * step, and `cleanliness_unresolved` is the earlier of them: it is raised from
 * inside the cleanliness query itself, strictly before there is a verdict for
 * the acknowledgement gate to weigh:
 *
 *   * `mount_mismatch` — the candidate belongs to a different repo mount.
 *     `packages/contracts/src/worktree.ts` assigns this check to T2.2 at
 *     `ExecutionRootPrepareRequest.reuseWorktreeId` ("MOUNT CONSISTENCY is a
 *     T2.2 obligation rather than a shape one … it rides T2.2's
 *     `validateReuse` compatibility verdict"), because binding it would put
 *     the execution root inside a DIFFERENT repository.
 *   * `not_live` — the candidate is `retired` or `failed`. Distinct from a
 *     candidate that never existed, which is {@link WorktreeNotFoundError}:
 *     `error-contracts.md §Worktree` scopes this code to a candidate "no
 *     longer live", and answering 409 for an id that names nothing would send
 *     a caller to repair a row that is not there.
 *   * `branch_mismatch` — the candidate holds a different branch than the
 *     requested one. INCOMPATIBILITY, which `Spec-010 §Fallback Behavior`
 *     makes unbindable regardless of acknowledgement (I-010-8).
 *   * `dirty_unacknowledged` — the candidate holds uncommitted work and the
 *     caller supplied no `acknowledgeDirtyCandidate`. TOCTOU-scoped by
 *     design: a candidate that turned dirty after a reuse check refuses here.
 *   * `cleanliness_unresolved` — the cleanliness query did not complete, so
 *     the daemon holds no verdict. Refusing is the fail-closed direction: the
 *     acknowledgement gate is meaningless without a cleanliness answer, and
 *     binding on an unknown verdict is the silent bind D-010-15 forbids.
 */
export type WorktreeReuseConflictReason =
  | "mount_mismatch"
  | "not_live"
  | "branch_mismatch"
  | "dirty_unacknowledged"
  | "cleanliness_unresolved";

/**
 * Why ephemeral clone preparation failed. Closed and non-path-bearing, for the
 * same reason {@link WorktreeCreateFailureReason} is.
 *
 * Five members, in the order `ephemeral-clone-service.ts`'s `prepare` reaches
 * them. The first four are the sibling's shape — a step of the preparation did
 * not work — and the fifth is not, which is why it is last:
 *
 *   * `execution_root_unavailable` — the clone-roots directory could not be
 *     prepared under the daemon's execution-roots directory (D-010-6). Named
 *     identically to its {@link WorktreeCreateFailureReason} member because it
 *     is the same failure of the same D-010-6 step; the two unions are distinct
 *     types, so the shared spelling costs nothing and makes the parallel legible.
 *   * `clone_invocation_failed` — the `git clone` invocation did not complete.
 *     Deliberately NOT the sibling's `git_invocation_failed`: preparation makes
 *     THREE git invocations, and the other two's failures are the next two
 *     members, so a name that said only "a git call failed" would not
 *     discriminate.
 *   * `base_branch_unreadable` — the `git branch --show-current` read of the
 *     clone's own HEAD did not complete. UNREADABLE rather than the siblings'
 *     "unavailable", and the difference is the member's whole point: the
 *     siblings name something that could not be brought into existence, whereas
 *     a base branch can be LAWFULLY ABSENT. When no branch references the
 *     source's HEAD commit, the clone's own HEAD lands detached — a merely
 *     detached source does not suffice, `git clone` resolving the remote HEAD
 *     to a branch naming that commit — and there the read succeeds and prints
 *     nothing, and the preparation goes on to report no base branch at all —
 *     not this reason, not any failure. This member fires only when the
 *     invocation itself fails.
 *     Collapsing the two would let a transient read failure followed by a
 *     successful branch cut ship silently self-anchored provenance into
 *     `branch_contexts`, which CP-010-6 hands to Plan-011 for PR and diff
 *     attribution.
 *   * `head_branch_unavailable` — the `git checkout -b` invocation did not
 *     create the caller's head branch. Its reachable case is a name that already
 *     exists in the fresh clone, the source's own default branch being the
 *     obvious one. The obligation to CREATE the supplied head branch is the
 *     Plan-010 Phase-2 T2.3 row's; D-010-19 is the separate ruling that makes
 *     the name REQUIRED at this seam rather than derivable inside it. A name
 *     that is already present is refused rather than silently bound, the same
 *     "user intent is never silently adapted" posture D-010-7 takes for worktree
 *     branch collisions.
 *   * `concurrently_retired` — the clone row left `creating` while git was
 *     running, which only a concurrent `dispose` or `retireRunClone` can do.
 *     Unlike every other member this reports no defect: the preparation was
 *     CANCELLED by a legitimate concurrent retirement, and the compare-and-swap
 *     to `ready` is what observes it. It still belongs on `clone.prepare_failed`
 *     rather than on a conflict code, because the caller's disposition is the
 *     registry row's exactly — no usable clone came out of the call and the run
 *     stays blocked in setup — and the repair (prepare again) is the same one.
 *     The directory git did materialize is not leaked by reporting it this way:
 *     the row is already `retired`, so the cleanup sweep owns its removal.
 */
export type ClonePrepareFailureReason =
  | "execution_root_unavailable"
  | "clone_invocation_failed"
  | "base_branch_unreadable"
  | "head_branch_unavailable"
  | "concurrently_retired";

/** Fixed, path-free message per clone-preparation reason. Total `Record`, as above. */
const CLONE_PREPARE_FAILURE_MESSAGES: Record<ClonePrepareFailureReason, string> = {
  execution_root_unavailable:
    "ephemeral clone preparation failed: the daemon execution root could not be prepared",
  clone_invocation_failed:
    "ephemeral clone preparation failed: the git clone invocation did not complete",
  base_branch_unreadable:
    "ephemeral clone preparation failed: the clone's base branch could not be read",
  head_branch_unavailable:
    "ephemeral clone preparation failed: the requested head branch could not be created in the clone",
  concurrently_retired:
    "ephemeral clone preparation failed: the clone was retired by a concurrent disposal before preparation completed",
};

/** Fixed, path-free message per reuse-conflict reason. Total `Record`, as above. */
const WORKTREE_REUSE_CONFLICT_MESSAGES: Record<WorktreeReuseConflictReason, string> = {
  mount_mismatch: "worktree reuse refused: the candidate belongs to a different repo mount",
  not_live: "worktree reuse refused: the candidate is no longer live",
  branch_mismatch:
    "worktree reuse refused: the candidate holds a different branch than the one requested, and an incompatible candidate never binds",
  dirty_unacknowledged:
    "worktree reuse refused: the candidate holds uncommitted changes and the caller did not acknowledge a dirty candidate",
  cleanliness_unresolved:
    "worktree reuse refused: the candidate's working-tree cleanliness could not be determined",
};

// ==========================================================================
// `error-contracts.md §Worktree`
// ==========================================================================

/**
 * `worktree.not_found` — "Worktree does not exist" (`error-contracts.md
 * §Worktree`, notional HTTP 404).
 *
 * Carries the unresolved worktree id, mirroring the `RepoMountNotFoundError` /
 * `WorkspaceNotFoundError` precedents — and, like them, is the ONE class in its
 * namespace that sets `jsonRpcCode` (see the header).
 */
export class WorktreeNotFoundError extends DaemonDomainError {
  /** The worktree id that did not resolve. Projects to `data.fields.worktreeId`. */
  readonly worktreeId: string;

  constructor(worktreeId: string) {
    super(`worktree ${worktreeId} does not exist`, {
      code: "worktree.not_found" satisfies WorktreeErrorCode,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 404,
      detail: { worktreeId },
    });
    this.worktreeId = worktreeId;
  }
}

/**
 * `worktree.create_failed` — "Worktree creation failed (git error, filesystem
 * error, or dynamic worktree unavailability at provisioning time); the owning
 * workspace transitions to `stale` via `failReprovision` and the failure detail
 * rides `workspace.stale` metadata" (`error-contracts.md §Worktree`, notional
 * HTTP 500).
 *
 * The closed {@link WorktreeCreateFailureReason} is the ONLY constructor
 * argument, and that is what discharges the §Worktree no-path-echo ban
 * structurally rather than by throw-site discipline: the underlying git
 * `stderr` — the value on this path most likely to name a filesystem path — is
 * given no channel into either the message or the wire `detail`. It stays in
 * the service's own scope and never enters the carrier.
 *
 * The accepted cost is that the git failure's own text is not recoverable from
 * this error. The registry's own compensating surface is the row: a failed
 * creation persists as a `worktrees` row in state `failed`, queryable through
 * `repo.worktreeStatusRead` (D-010-11), and the workspace-level incident is
 * evented as `workspace.stale`.
 */
export class WorktreeCreateFailedError extends DaemonDomainError {
  /** Non-path-bearing failure discriminant. Projects to `data.fields.reason`. */
  readonly reason: WorktreeCreateFailureReason;

  constructor(reason: WorktreeCreateFailureReason) {
    super(WORKTREE_CREATE_FAILURE_MESSAGES[reason], {
      code: "worktree.create_failed" satisfies WorktreeErrorCode,
      httpStatus: 500,
      detail: { reason },
    });
    this.reason = reason;
  }
}

/**
 * `worktree.branch_collision` — "Caller-supplied branch name collides with a
 * live checkout on the same mount; user intent is never silently adapted —
 * daemon-derived default names ordinal-suffix instead" (`error-contracts.md
 * §Worktree`, notional HTTP 409; the D-010-7 provenance-split collision
 * policy).
 *
 * Raised ONLY on the `onCollision: 'refuse'` arm. The `suffix` arm never
 * reaches a carrier — it takes the first free ordinal and reports the chosen
 * name verbatim, which is the whole of the provenance split.
 *
 * Carries the colliding branch name and the mount it collided on: both are the
 * caller's own inputs, and without the name the refusal cannot say what to
 * change. Neither is a filesystem path — a branch name is a git ref name, and
 * a mount id is an opaque identifier.
 */
export class WorktreeBranchCollisionError extends DaemonDomainError {
  /** The mount the collision occurred on. Projects to `data.fields.repoMountId`. */
  readonly repoMountId: string;
  /** The caller-supplied branch name that collided. Projects to `data.fields.branchName`. */
  readonly branchName: string;

  constructor(repoMountId: string, branchName: string) {
    super(
      `worktree creation refused: branch ${branchName} already has a live checkout on repo mount ${repoMountId}`,
      {
        code: "worktree.branch_collision" satisfies WorktreeErrorCode,
        httpStatus: 409,
        detail: { repoMountId, branchName },
      },
    );
    this.repoMountId = repoMountId;
    this.branchName = branchName;
  }
}

/**
 * `worktree.reuse_conflict` — "Explicit reuse candidate is dirty without
 * `acknowledgeDirtyCandidate`, incompatible with the requested branch strategy
 * (never bindable), or no longer live" (`error-contracts.md §Worktree`,
 * notional HTTP 409; `Spec-010 §Fallback Behavior`). Carrier leg of I-010-8.
 *
 * Carries the closed {@link WorktreeReuseConflictReason}, which is what lets a
 * caller distinguish the refusal a user can clear (acknowledge the dirty
 * candidate) from the two they cannot (an incompatible or non-live candidate
 * never binds) — the distinction `Spec-010 §Fallback Behavior`'s "must require
 * explicit user choice" rests on. It is also the value a Phase-3
 * `repo.worktreeReuseCheck` projection can render into
 * `WorktreeReuseCheckResponse.reason` without inventing prose of its own.
 */
export class WorktreeReuseConflictError extends DaemonDomainError {
  /** The refused candidate. Projects to `data.fields.worktreeId`. */
  readonly worktreeId: string;
  /** Non-path-bearing refusal discriminant. Projects to `data.fields.reason`. */
  readonly reason: WorktreeReuseConflictReason;

  constructor(worktreeId: string, reason: WorktreeReuseConflictReason) {
    super(WORKTREE_REUSE_CONFLICT_MESSAGES[reason], {
      code: "worktree.reuse_conflict" satisfies WorktreeErrorCode,
      httpStatus: 409,
      detail: { worktreeId, reason },
    });
    this.worktreeId = worktreeId;
    this.reason = reason;
  }
}

/**
 * `worktree.retire_conflict` — "Retire refused while the worktree is the
 * execution root held by an active run (busy owning workspace)"
 * (`error-contracts.md §Worktree`, notional HTTP 409).
 *
 * Names the holding workspace, which is the only repair affordance the caller
 * has: the refusal is cleared by the run releasing its hold, and nothing else
 * in the daemon reports WHICH workspace is holding a given worktree. The same
 * reasoning `WorkspaceBusyError` gives for naming its holding run.
 */
export class WorktreeRetireConflictError extends DaemonDomainError {
  /** The worktree whose retirement was refused. Projects to `data.fields.worktreeId`. */
  readonly worktreeId: string;
  /** The `busy` workspace bound to it. Projects to `data.fields.holdingWorkspaceId`. */
  readonly holdingWorkspaceId: string;

  constructor(worktreeId: string, holdingWorkspaceId: string) {
    super(
      `worktree ${worktreeId} cannot be retired: workspace ${holdingWorkspaceId} is holding it for an active run`,
      {
        code: "worktree.retire_conflict" satisfies WorktreeErrorCode,
        httpStatus: 409,
        detail: { worktreeId, holdingWorkspaceId },
      },
    );
    this.worktreeId = worktreeId;
    this.holdingWorkspaceId = holdingWorkspaceId;
  }
}

// ==========================================================================
// `error-contracts.md §Ephemeral Clone`
// ==========================================================================

/**
 * `clone.not_found` — "Ephemeral clone does not exist" (`error-contracts.md
 * §Ephemeral Clone`, notional HTTP 404).
 *
 * Declared here rather than in `ephemeral-clone-service.ts` because T2.2's row
 * makes this file the home of EVERY Plan-010 typed error class; T2.3 imports
 * it. Sets `jsonRpcCode` for the same reason {@link WorktreeNotFoundError}
 * does.
 */
export class CloneNotFoundError extends DaemonDomainError {
  /** The clone id that did not resolve. Projects to `data.fields.cloneId`. */
  readonly cloneId: string;

  constructor(cloneId: string) {
    super(`ephemeral clone ${cloneId} does not exist`, {
      code: "clone.not_found" satisfies EphemeralCloneErrorCode,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 404,
      detail: { cloneId },
    });
    this.cloneId = cloneId;
  }
}

/**
 * `clone.prepare_failed` — "Ephemeral clone preparation failed; the owning
 * workspace transitions to `stale` via `failReprovision` and the run stays
 * blocked in setup" (`error-contracts.md §Ephemeral Clone`, notional HTTP 500;
 * `Spec-010 §Fallback Behavior`).
 *
 * Carries the closed {@link ClonePrepareFailureReason}, and nothing else — the
 * shape its `worktree.create_failed` sibling has, reached the same way. This
 * class was declared ARGUMENT-FREE by T2.2 on purpose: a closed reason enum
 * would not have breached the §Ephemeral Clone no-path ban, but T2.3 owned the
 * clone-prepare failure taxonomy, and minting a discriminant here on its behalf
 * would have pre-committed every downstream importer to a shape no ratified
 * surface asked for. The widening was left to whoever first had real throw
 * sites, on the reasoning that adding a parameter later is additive whereas
 * retracting a leaky one after Phase 3 ships is not. T2.3 supplied the
 * members, one per point its `prepare` can fail.
 *
 * The reason is what lets a caller tell the defect members apart from the one
 * non-defect (`concurrently_retired`, a preparation cancelled by a concurrent
 * disposal) without parsing prose, and it is the value the workspace-level
 * incident can carry into `workspace.stale` metadata. The underlying git
 * `stderr` is still given no channel here — it stays in the service's scope,
 * and the persisted row remains the queryable trail (D-010-11): state `failed`
 * on every defect arm, and already `retired` on the cancelled one.
 */
export class ClonePrepareFailedError extends DaemonDomainError {
  /** Non-path-bearing failure discriminant. Projects to `data.fields.reason`. */
  readonly reason: ClonePrepareFailureReason;

  constructor(reason: ClonePrepareFailureReason) {
    super(CLONE_PREPARE_FAILURE_MESSAGES[reason], {
      code: "clone.prepare_failed" satisfies EphemeralCloneErrorCode,
      httpStatus: 500,
      detail: { reason },
    });
    this.reason = reason;
  }
}

// ==========================================================================
// `error-contracts.md §Workspace` — the three Plan-010 rows
// ==========================================================================

/**
 * `workspace.branch_mismatch` — "`branch` mode bind-only verification failed:
 * the main checkout's current branch does not match the requested branch
 * context; the daemon never switches branches in the main checkout"
 * (`error-contracts.md §Workspace`, notional HTTP 409; D-010-9;
 * `Spec-010 §Resolved Questions and V1 Scope Decisions`). Carrier leg of
 * I-010-6 on the `branch`-mode arm, where the refusal is what keeps the main
 * checkout unmutated.
 *
 * Carries BOTH ref names because the refusal's entire repair affordance is the
 * comparison: a caller told only that the branches disagree cannot tell whether
 * to re-target the run or to switch the checkout themselves. Both are git ref
 * names rather than paths, and the requested one is the caller's own input.
 */
export class WorkspaceBranchMismatchError extends DaemonDomainError {
  /** The workspace whose bind-only verification failed. Projects to `data.fields.workspaceId`. */
  readonly workspaceId: string;
  /** The branch the caller asked to execute against. Projects to `data.fields.requestedBranchName`. */
  readonly requestedBranchName: string;
  /** The branch the main checkout is actually on. Projects to `data.fields.currentBranchName`. */
  readonly currentBranchName: string;

  constructor(workspaceId: string, requestedBranchName: string, currentBranchName: string) {
    super(
      `branch-mode bind refused for workspace ${workspaceId}: the checkout is on ${currentBranchName}, not the requested ${requestedBranchName}; the daemon never switches branches in the main checkout`,
      {
        code: "workspace.branch_mismatch" satisfies Plan010WorkspaceErrorCode,
        httpStatus: 409,
        detail: { workspaceId, requestedBranchName, currentBranchName },
      },
    );
    this.workspaceId = workspaceId;
    this.requestedBranchName = requestedBranchName;
    this.currentBranchName = currentBranchName;
  }
}

/**
 * `workspace.execution_root_unresolved` — "A repo-bound run reached the setup
 * gate with no resolved execution root for the workspace's selected mode and
 * root preparation failed; the run parks in `starting`"
 * (`error-contracts.md §Workspace`, notional HTTP 409; D-010-16;
 * `Spec-010 §Fallback Behavior`'s blocked-in-setup disposition).
 *
 * D-010-16 specifies this refusal as "wrapping the underlying typed cause", so
 * the carrier records that cause's dotted CODE — not the cause object. The
 * code alone is what a caller acts on (it is the `data.type` they would have
 * seen had the underlying refusal reached them directly), and carrying the
 * object would drag the cause's own message into this one's, re-opening the
 * prose channel the header closes.
 *
 * `null` when the underlying failure carried no registered code — a defect
 * with no wire identity, which the gate must still park honestly rather than
 * mislabel. The same nullable-attribution shape `WorkspaceBusyError` uses for
 * its holding run.
 */
export class WorkspaceExecutionRootUnresolvedError extends DaemonDomainError {
  /** The workspace whose execution root did not resolve. Projects to `data.fields.workspaceId`. */
  readonly workspaceId: string;
  /** The wrapped cause's dotted code, or `null` when it carried none. */
  readonly causeCode: string | null;

  constructor(workspaceId: string, causeCode: string | null) {
    super(
      causeCode === null
        ? `workspace ${workspaceId} has no resolved execution root: root preparation failed and the run stays parked in setup`
        : `workspace ${workspaceId} has no resolved execution root: root preparation failed with ${causeCode} and the run stays parked in setup`,
      {
        code: "workspace.execution_root_unresolved" satisfies Plan010WorkspaceErrorCode,
        httpStatus: 409,
        detail: causeCode === null ? { workspaceId } : { workspaceId, causeCode },
      },
    );
    this.workspaceId = workspaceId;
    this.causeCode = causeCode;
  }
}

/**
 * `workspace.branch_name_required` — "A writable-mode wire-initiated (pre-run)
 * `repo.executionRootPrepare` omitted `branchName`: the Spec-010 slug rule's
 * derivation inputs (queue-item summary / run id) exist only on the run-setup
 * gate path, so wire prepares must carry the branch"
 * (`error-contracts.md §Workspace`, notional HTTP 400; D-010-19).
 *
 * The typed form of `ExecutionRootPrepareRequest.branchName`'s
 * schema-optional-but-service-conditional requiredness. It cannot be a parse
 * error: the requiredness is conditioned on the workspace's SELECTED MODE,
 * which lives on the `workspaces` row and is invisible at parse time — the
 * reasoning `packages/contracts/src/worktree.ts` gives at that field. Raised
 * before any git call.
 */
export class WorkspaceBranchNameRequiredError extends DaemonDomainError {
  /** The workspace the prepare targeted. Projects to `data.fields.workspaceId`. */
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(
      `execution root prepare refused for workspace ${workspaceId}: a writable-mode prepare must carry a branch name, because the daemon's derivation inputs exist only on the run-setup gate path`,
      {
        code: "workspace.branch_name_required" satisfies Plan010WorkspaceErrorCode,
        httpStatus: 400,
        detail: { workspaceId },
      },
    );
    this.workspaceId = workspaceId;
  }
}
