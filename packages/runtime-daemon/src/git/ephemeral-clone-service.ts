// Ephemeral-clone lifecycle service — the daemon-side owner of the
// `ephemeral_clones` table and of every git invocation that provisions a
// disposable clone root (Plan-010 Phase 2, T2.3).
//
// Spec coverage:
//   * `Spec-010 §Required Behavior` — `ephemeral clone` mode provisions a
//     disposable isolated clone before writable execution begins.
//   * `Spec-010 §Default Behavior` — provisioning git invocations neutralize
//     repository-controlled hook execution at the invocation layer, so cloning a
//     hostile repository executes no repository-controlled code.
//   * `Spec-010 §Fallback Behavior` — a failed clone preparation leaves the run
//     blocked in setup rather than substituting another execution mode; the
//     sweep records retirement with metadata preserved and removes the disk root
//     afterwards; retiring the clone backing a live `ephemeral clone`-mode
//     workspace's current root returns that workspace to `provisioning`, and
//     `stale` is reserved for fault paths.
//   * `Spec-010 §Resolved Questions and V1 Scope Decisions` — the TTL is daemon
//     configuration (default 24 hours) rather than a wire parameter, and clone
//     transitions are not separately evented in V1.
//
// Verifies invariant: I-010-9 (retirement is recorded before any disk mutation,
// and `cleaned_at` is stamped only after the removal succeeded), I-010-10 (every
// provisioning git invocation is hook-neutralized).
//
// Cross-plan obligations consumed here: CP-010-7 (this Plan-010-owned `src/git/`
// subtree) and CP-010-2 — the Plan-009 reprovision primitive, which arrives
// INJECTED (see {@link WorkspaceReprovisionBeginner}) rather than by importing
// `WorkspaceService`. CP-009-8 is what makes the disposition load-bearing rather
// than cosmetic: `workspaces.fs_root` is handed to Plan-012 as an approval scope
// root, so a `ready` workspace whose `fs_root` still names a disposed clone
// scopes approvals to a directory that is being deleted.
//
// ---------------------------------------------------------------------------
// D-010-11 — this service emits NOTHING, deliberately
// ---------------------------------------------------------------------------
//
// There is no event seam on this class and no `events` dependency. Ephemeral
// clones have no event types in the Spec-006 taxonomy: `Spec-010 §Resolved
// Questions and V1 Scope Decisions` keeps that registry closed and routes every
// clone transition through the OWNING WORKSPACE's lifecycle events plus the
// status-read surface. So the observable trail of a prepare is the caller's
// `workspace.provisioning` / `workspace.ready` pair, the trail of a failed
// prepare is the caller's `workspace.stale` (carrying the failure detail), and
// the trail of a sweep disposition is the `workspace.provisioning` that the
// injected reprovision primitive appends on Plan-009's side.
//
// The rows are still written for every transition — `creating`, `ready`,
// `failed`, `retired`, `cleaned_at` — because the status-read surface is what
// makes a failed or expired clone queryable at all.
//
// ---------------------------------------------------------------------------
// I-010-10 — hook neutralization is STRUCTURAL
// ---------------------------------------------------------------------------
//
// Every git invocation in this module goes through one private `#runGit`, and
// that method is the only place an argv is assembled. It prepends
// `-c core.hooksPath=<empty dir>` unconditionally, so the invariant's "every
// provisioning git invocation" quantifier is discharged by there being no other
// way to reach git from here — not by remembering the flag at each call site.
// A command-line `-c` outranks repository, global and system config and the
// `GIT_CONFIG_*` injection channel alike, and because it sits BEFORE the
// subcommand it is scoped to the invocation: it configures the clone operation
// without being written into the new clone's persistent config.
//
// That placement matters more here than it does for a worktree. `git clone`
// reads the SOURCE repository (whose hooks are the hostile ones D-010-10 is
// about) and then writes a fresh repository of its own, and the freshly written
// `.git/hooks` is populated from git's templates rather than from the source —
// so the neutralization has to cover the invocation, and the clone that results
// carries no `core.hooksPath` of ours into later commands run against it.
//
// The neutralization directory is created (recursively, idempotently) before
// each invocation rather than once at construction: an EMPTY directory is the
// mechanism, and a temp-file reaper that removed it between invocations would
// silently restore the repository's own hooks.
//
// Every invocation is `execFile` with an argv ARRAY — never a shell string — so
// a branch name or path containing shell metacharacters is one argument rather
// than a command. The remaining channel is option injection, and this module's
// only caller-supplied argv element is `branchName`, which rides the VALUE slot
// of `checkout -b <name>`: git's parser consumes it as that option's argument,
// not as a new option. Both positionals it passes (`clone <source> <target>`)
// are daemon-derived — the mount's canonical root and a path this service just
// minted under its own execution-roots directory.
//
// This is a RATIFIED discharge rather than an empirically verified one: no test
// in this package spawns real git, so the neutralization is asserted here by
// argv inspection. The hostile-repository sentinel fixture — a repo whose hooks
// would write a marker file if they ran — belongs to T2.6's real-git acceptance
// tier, and the clone leg of it is what turns the argv assertion into evidence.
//
// ---------------------------------------------------------------------------
// I-010-9 — recorded, then cleaned; and why the DISPOSITION comes first
// ---------------------------------------------------------------------------
//
// A retirement writes `state = 'retired'` and stops. `cleaned_at` stays NULL and
// the clone root stays on disk. {@link EphemeralCloneService.cleanupTick} is
// what removes the directory and stamps the column, in that order — so a crash
// between them leaves a row the next tick retries (the removal is `force`, hence
// idempotent), and never a row claiming a cleanup that did not happen.
//
// Within a retirement the ORDER is: workspace disposition first, clone row
// second. That is the opposite of what "record before you mutate" suggests at a
// glance, and it is forced by what each write means:
//
//   * The disposition is `beginReprovision(workspaceId, 'ephemeral clone')`,
//     which sets `fs_root = NULL` and moves the workspace `ready -> provisioning`.
//     `provisioning` is a state `markBusy` cannot claim (it requires `ready`), so
//     once it lands no new run can bind the root this tick is about to retire.
//   * A crash between the two therefore leaves a workspace in `provisioning`
//     with a live clone row — a state the next per-run prepare resolves and the
//     next tick re-retires, because the clone is still expired.
//   * The reverse order leaves the opposite window: a `retired` clone whose
//     workspace is still `ready` and still advertising the retired root as its
//     `fs_root`, which is exactly the CP-009-8 hazard above, and which a run
//     starting in that window would execute inside.
//
// Neither write is a disk mutation, so I-010-9's "recorded before any disk
// mutation" claim holds across both: leg (d) of the tick is the only thing in
// this file that touches the filesystem for a retirement.
//
// ---------------------------------------------------------------------------
// I-010-11 — no `workspaces` write happens here, and what that FORCES
// ---------------------------------------------------------------------------
//
// This service holds no statement that writes `workspaces`. It READS the table
// (to resolve a prepare's mount, and to decide a retirement's disposition), and
// every write rides the injected Plan-009 primitive.
//
// That constraint is what decides the busy-holder case, rather than a safety
// rule this module chose. `beginReprovision`'s legal predecessors are `ready`
// and `stale`; a workspace executing a run is `busy`. So for a clone that is the
// current execution root of a `busy` workspace there is NO lawful transition
// available to this service at all — it cannot dispose the workspace, and it may
// not reach into the table to do it anyway. Retiring the row regardless would
// hand leg (d) a root to delete out from under a running run.
//
// The deferral is therefore the only non-throwing branch the primitive leaves,
// and it is spelled ONCE, as {@link CLONE_NOT_HELD_BY_BUSY_WORKSPACE_PREDICATE},
// interpolated into all three candidate reads. Deferral is not abandonment: the
// clone stays expired, so the next tick after the run releases retires it.
//
// The guard is deliberately MODE-AGNOSTIC while the disposition is not. The
// guard asks "is a run executing in this directory", which is a fact about
// `workspaces.fs_root` and `busy` whatever the row calls its mode; the
// disposition asks the narrower `Spec-010 §Fallback Behavior` question — the
// clone backing a live `ephemeral clone`-mode workspace's current root — and so
// carries the mode check as well.
//
// `dispose` is the one path that retires a busy-held clone anyway: it is an
// explicit operator or wire disposal, `error-contracts.md §Ephemeral Clone`
// ratifies no conflict code to refuse it with, and the disk removal still defers
// (leg (d) carries the same guard), so the running run keeps its directory until
// it releases.
//
// ---------------------------------------------------------------------------
// D-010-13 — which sweep legs live here
// ---------------------------------------------------------------------------
//
// {@link EphemeralCloneService.cleanupTick} runs the CLONE legs:
//
//   (a) clones past their TTL are retired;
//   (b) clones whose owning workspace archived are retired;
//   (d) `retired` clones with no `cleaned_at` have their root removed and the
//       column stamped.
//
// Leg (c) — the inactive-mount cascade — is NOT here. It operates on
// `worktrees`, which T2.2 owns, and a sweep that reached into another task's
// table would give that table two writers. A clone on a detached mount is
// reached by leg (a) instead, when its TTL expires.
//
// (a) and (b) share one query and one retirement path: both are "this clone is
// live and should not be", and running them as one pass means a clone that is
// both expired and archived is retired once rather than twice.
//
// A per-row failure PROPAGATES rather than being collected — a tick that
// swallowed an `EACCES` would report a clean pass while a root accumulates
// forever. The tick is idempotent and re-entrant (the removal is `force`, the
// stamp is guarded on `cleaned_at IS NULL`, and the retirement is a
// compare-and-swap), so the next tick resumes from where this one stopped.
//
// ---------------------------------------------------------------------------
// The TTL is CONFIGURATION, and its comparison is a string comparison
// ---------------------------------------------------------------------------
//
// `Spec-010 §Resolved Questions and V1 Scope Decisions` fixes the TTL as daemon
// configuration with a 24-hour default and explicitly not a wire parameter —
// which is why it is a constructor dependency and why no method signature in
// this file accepts one. `packages/contracts/src/worktree.ts`'s prepare request
// is `.strict()` and carries no TTL field of any spelling, so the wire cannot
// smuggle one in either.
//
// `expires_at` is written as `Date.prototype.toISOString()` output and leg (a)
// compares it against `@now` with SQL `<=`. That is a lexicographic comparison
// on TEXT, which agrees with chronological order only because both sides are the
// same fixed-width UTC spelling. The constraint lands on the injected clock: see
// {@link EphemeralCloneServiceDeps.now}.
//
// ---------------------------------------------------------------------------
// RESIDUAL — a head-branch collision is REFUSED, and reported as a 500
// ---------------------------------------------------------------------------
//
// The four points this file can fail a prepare are told apart by
// {@link ClonePrepareFailureReason}, which T2.3 supplied to the carrier from
// these throw sites. What the discriminant does NOT settle is the policy behind
// one of them.
//
// `git clone` leaves HEAD on the source's default branch, so a prepare whose
// `branchName` equals that branch asks git to create a branch that already
// exists, and it fails — a request a caller would consider perfectly reasonable,
// reported as `head_branch_unavailable` with `clone.prepare_failed`'s notional
// 500. Creating the supplied head branch is the T2.3 task row's obligation —
// D-010-19 separately makes the name REQUIRED here rather than derivable — and
// this seam does not silently bind an existing one, which is the
// "user intent is never silently adapted" posture D-010-7 takes for worktree
// branch collisions — but the worktree surface answers its collision with a
// dedicated 409, and the clone surface's ratified registry has no such row.
//
// So the residual is the STATUS and the arm, not the taxonomy: whether a clone
// head-branch collision deserves a `clone.branch_collision` row of its own, and
// whether a bind arm should exist at all, are governance questions for the owner
// of the error contract rather than liberties this task may take. The suite pins
// today's outcome so it is a recorded decision rather than a discovery T2.6
// makes against real git.
//
// Refs: Plan-010 (worktree lifecycle and execution modes), Plan-009 (the
// `beginReprovision` primitive and the statement-per-transition precedent),
// `./worktree-service.ts` (the sibling this module's seams and git layer mirror).

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Database, Statement } from "better-sqlite3";

import {
  EphemeralCloneIdSchema,
  EphemeralCloneStateSchema,
  type EphemeralCloneDisposeResponse,
  type EphemeralCloneState,
  type ExecutionMode,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

import { RepoMountNotFoundError } from "../workspace/repo-errors.js";
import {
  DEFAULT_GIT_EXECUTABLE,
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
} from "../workspace/repo-root-resolver.js";
import { WorkspaceBusyError, WorkspaceNotFoundError } from "../workspace/workspace-service.js";

import { CloneNotFoundError, ClonePrepareFailedError } from "./worktree-errors.js";

// --------------------------------------------------------------------------
// Injected seams
// --------------------------------------------------------------------------

/** Captured stdio from one completed git invocation. */
export interface EphemeralCloneGitInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-invocation bounds. */
export interface EphemeralCloneGitInvocationOptions {
  /** Wall-clock ceiling; the child is killed past it. */
  readonly timeoutMs: number;
}

/**
 * The git process seam.
 *
 * Takes the COMPLETE argv — positionals and any `-C <dir>` alike — and no
 * working directory, which is what makes the argv the whole invocation. Not
 * every invocation carries `-C`: `clone` names its source and target
 * positionally and runs in no repository at all, while the base-branch read and
 * `checkout` both run inside the clone and need one. A `cwd` option would put
 * half the target outside the recorded argv, and I-010-10 is asserted by
 * inspecting recorded argvs: a suite that can see `clone` but not which
 * repository it ran against cannot tell a clone provisioning from a command
 * against the user's own checkout.
 *
 * Declared LOCALLY rather than imported from `./worktree-service.ts`, whose
 * `WorktreeGitRunner` is structurally identical. The two are interchangeable by
 * assignment wherever a composition root wants one implementation for both — TS
 * is structural — while the declaration keeps this module's git contract
 * readable without a hop into the sibling, and keeps a later change to one
 * service's invocation shape from silently retyping the other's. Same reasoning
 * `./worktree-service.ts` gives for not importing Plan-009's `GitFileExecutor`.
 *
 * Rejections are opaque to this module: nothing reads a field off the thrown
 * value, so a fake may reject with anything. That is deliberate — the git
 * `stderr` is exactly the value the `error-contracts.md §Ephemeral Clone`
 * no-path-echo rule keeps out of the typed carrier.
 */
export type EphemeralCloneGitRunner = (
  argv: readonly string[],
  options: EphemeralCloneGitInvocationOptions,
) => Promise<EphemeralCloneGitInvocationResult>;

/**
 * The filesystem seam. Two verbs, both idempotent: `createDirectory` creates
 * leading directories and tolerates an existing one, `removeDirectory` removes
 * recursively and tolerates a missing one. The tolerance is load-bearing for
 * I-010-9 — the tick's removal is retried until `cleaned_at` is stamped.
 */
export interface EphemeralCloneFilesystem {
  createDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
}

/**
 * The Plan-009 reprovision primitive (CP-010-2), narrowed to the two arguments
 * this service supplies.
 *
 * `WorkspaceService.beginReprovision` is assignable to it as written: its third
 * parameter is optional, and a function that ignores parameters its caller does
 * not pass is assignable to a shorter signature. So the composition root wires
 * `(workspaceId, targetMode) => workspaceService.beginReprovision(workspaceId, targetMode)`
 * — or the bound method itself.
 *
 * INJECTED rather than imported as a class, for two reasons. It keeps I-010-11
 * legible: this module cannot write `workspaces` because it holds no writer, not
 * because it refrains from calling one. And it keeps the Plan-010 `src/git/`
 * subtree free of a structural dependency on the Plan-009 service object, whose
 * constructor pulls in the event log and the signing-key source that a clone
 * sweep has no use for.
 *
 * The primitive is ASYNC because it appends `workspace.provisioning`, which is
 * the reason no `better-sqlite3` transaction can span the disposition and the
 * clone-row retirement: `transaction()` is synchronous, and awaiting inside one
 * is not a thing SQLite offers. See the header for what that leaves open and why
 * the ordering closes it.
 */
export type WorkspaceReprovisionBeginner = (
  workspaceId: string,
  targetMode: ExecutionMode,
) => Promise<void>;

export interface EphemeralCloneServiceDeps {
  /**
   * The daemon's SQLite handle. Statements are prepared once, in the
   * constructor.
   *
   * SHOULD be the same connection the injected {@link beginWorkspaceReprovision}
   * writes through. Nothing here can verify that — the primitive arrives as a
   * function — and unlike `./worktree-service.ts` nothing in this module joins
   * another component's transaction, so a divergent handle costs isolation
   * between the disposition and the retirement rather than atomicity that was
   * promised. The composition root owns the constraint either way.
   */
  readonly database: Database;
  /**
   * The daemon's execution-roots directory (D-010-6). Clone roots are placed at
   * `<executionRootsDirectory>/<repoMountId>/clones/<cloneId>`, and the
   * hook-neutralization directory is a sibling under the same root — the same
   * layout, and the same directory, `./worktree-service.ts` uses.
   *
   * Absolute by contract: it is the prefix of every `clone_root` this service
   * writes, and CP-009-8 hands the workspace's `fs_root` to Plan-012 as an
   * approval scope root — a relative one would be completed against whatever
   * working directory a tool process happens to hold. Not re-validated here; the
   * daemon's configuration layer owns that check, and duplicating it would put
   * one rule in two places.
   */
  readonly executionRootsDirectory: string;
  /**
   * Plan-009's `beginReprovision` (CP-010-2). Called for exactly one case — the
   * `Spec-010 §Fallback Behavior` disposition that returns a live clone-mode
   * workspace to `provisioning` when the clone backing its current root retires.
   */
  readonly beginWorkspaceReprovision: WorkspaceReprovisionBeginner;
  /**
   * Clone lifetime in milliseconds; defaults to
   * {@link DEFAULT_EPHEMERAL_CLONE_TTL_MS} (24 hours). Daemon CONFIGURATION, per
   * `Spec-010 §Resolved Questions and V1 Scope Decisions` — never a wire
   * parameter, which is why it is here and not on a method.
   */
  readonly ttlMs?: number;
  /** Git process seam; defaults to `execFile` against `git`. */
  readonly git?: EphemeralCloneGitRunner;
  /** Filesystem seam; defaults to `node:fs/promises`. */
  readonly filesystem?: EphemeralCloneFilesystem;
  /** Per-invocation git timeout; defaults to {@link DEFAULT_CLONE_GIT_TIMEOUT_MS}. */
  readonly gitCommandTimeoutMs?: number;
  /**
   * Wall clock for `created_at` / `updated_at` / `expires_at` / `cleaned_at`.
   * Injectable for tests.
   *
   * MUST return `Date.prototype.toISOString()` form — UTC, fixed width, `Z`
   * suffix. Leg (a) of the tick compares `expires_at <= @now` as SQL TEXT, and a
   * clock that returned an offset spelling (`+02:00`) or a variable-width one
   * would order wrong against the stored values, retiring live clones or
   * outliving expired ones with no error anywhere.
   */
  readonly now?: () => string;
  /** `ephemeral_clones.id` source. Injectable for deterministic tests; defaults to `randomUUID`. */
  readonly newCloneId?: () => string;
}

// --------------------------------------------------------------------------
// Inputs and results
// --------------------------------------------------------------------------

/**
 * Inputs for {@link EphemeralCloneService.prepare}.
 *
 * `branchName` is REQUIRED — the D-010-19 seam. The caller (T2.4's run-setup
 * gate) resolves the name first, through `deriveWorktreeBranchName` when it is a
 * derived one, so this service never sees a nameless request and derives
 * nothing.
 *
 * There is no `ttlMs` and no `expiresAt`: the TTL is daemon configuration
 * (`Spec-010 §Resolved Questions and V1 Scope Decisions`), and accepting one
 * here would make it a per-request value one wire-facing caller away.
 *
 * The workspace's `execution_mode` is NOT checked. Mode dispatch is the gate's
 * surface — it is what decides that a request is a clone-mode prepare at all —
 * and re-deciding it here would put one rule in two places, in the second of
 * which a legitimate mid-switch prepare would be refused.
 */
export interface PrepareEphemeralCloneInput {
  /** The workspace this clone belongs to. Resolves the mount to clone from. */
  readonly workspaceId: string;
  /** The head branch to create in the clone. REQUIRED (D-010-19). */
  readonly branchName: string;
  /**
   * What retires this clone. Defaults to `on_run_complete`: the disposable
   * per-run clone is the case `Spec-010 §Required Behavior` describes, and
   * `manual` is the opt-out a caller states explicitly. `manual` clones are
   * exempt from {@link EphemeralCloneService.retireForWorkspace} and are retired
   * by {@link EphemeralCloneService.dispose} or by their TTL.
   */
  readonly cleanupPolicy?: EphemeralCloneCleanupPolicy;
}

/**
 * The `ephemeral_clones.cleanup_policy` vocabulary.
 *
 * Spelled here rather than imported: `packages/contracts/src/worktree.ts` mints
 * `CleanupPolicySchema` but deliberately NO type alias, spelling the union
 * inline at every use site instead. This alias is local to the daemon service
 * and names the same two members the schema and the column's CHECK constraint
 * do; it exists because three signatures in this file would otherwise repeat the
 * union, and it is not exported as a contract.
 */
export type EphemeralCloneCleanupPolicy = "on_run_complete" | "manual";

/**
 * Why {@link EphemeralCloneService.retireForWorkspace} was called.
 *
 * A closed one-member union rather than a `string`: `on_run_complete` names the
 * condition that fired — the run reached a terminal state. `manual` is
 * deliberately not a member, because a manual-policy clone is retired by naming
 * it, through `dispose`, which is what "manual" means.
 *
 * Additively widenable: a later trigger (a session close, say) becomes a second
 * member here plus its row in {@link RETIREMENT_TRIGGER_POLICIES}, and every
 * existing caller still typechecks.
 */
export type EphemeralCloneRetirementTrigger = "on_run_complete";

/** A materialized, ready ephemeral clone. */
export interface PreparedEphemeralClone {
  readonly cloneId: string;
  readonly workspaceId: string;
  /** `<executionRootsDirectory>/<repoMountId>/clones/<cloneId>` (D-010-6). */
  readonly cloneRoot: string;
  /**
   * The branch that was created and persisted in `branch_name`. Reported back so
   * the caller's `branch_contexts` row does not have to reconstruct it.
   */
  readonly branchName: string;
  /**
   * The branch the clone's HEAD named BEFORE {@link branchName} was cut — what
   * the new branch descends from.
   *
   * Observed from the CLONE rather than from the mount's own checkout, and that
   * is not an implementation preference: reading the user's checkout admits a
   * race (the operator can switch branches between the read and the clone) and
   * would report a base the clone never had. The clone's HEAD is immutable
   * ground truth for the copy that was actually taken.
   *
   * ABSENT — the key omitted, never an empty string — when the CLONE's own
   * HEAD is detached: there is no branch name to report. That takes more than a
   * detached source: `git clone` resolves the remote HEAD to a branch naming
   * that commit, so a source merely detached at a branch tip still yields that
   * branch, and the clone lands detached only when no branch references the
   * source's HEAD commit (empirically confirmed on real git 2.50.1). A lawful
   * outcome, not a failure; the prepare succeeds and the caller self-anchors. A
   * read that FAILS is the other case entirely and raises
   * `base_branch_unreadable`.
   */
  readonly baseBranch?: string;
  /** The policy that landed on the row — the supplied one, or the default. */
  readonly cleanupPolicy: EphemeralCloneCleanupPolicy;
  /**
   * `now + ttlMs` at preparation, ISO-8601 UTC. Reported because the TTL itself
   * is daemon configuration the caller cannot see, and a caller surfacing "this
   * clone expires at …" would otherwise have to guess it.
   */
  readonly expiresAt: string;
  /** Always `ready`: a prepare that did not reach `ready` throws instead. */
  readonly state: Extract<EphemeralCloneState, "ready">;
}

/** What one {@link EphemeralCloneService.cleanupTick} did, in the order it did it. */
export interface EphemeralCloneCleanupTickResult {
  /** Clones retired by legs (a) and (b) — TTL expiry and workspace archival. */
  readonly retiredCloneIds: readonly string[];
  /** Clones whose root was removed and whose `cleaned_at` was stamped — leg (d). */
  readonly cleanedCloneIds: readonly string[];
  /**
   * Workspaces handed back to `provisioning` (`Spec-010 §Fallback Behavior`),
   * from EITHER disposition site: the retirement in legs (a)/(b), and leg (d)
   * for a clone whose disposition was still owed because `dispose` retired it
   * while the workspace was busy. Reported separately because it is the only
   * effect of a tick that reaches outside this service's own table, and a caller
   * reconciling daemon state wants it without re-querying.
   *
   * A workspace appears at most once per tick even though both legs can run for
   * the same clone: legs (a)/(b) dispose only a `ready` workspace, and the
   * disposition itself moves it to `provisioning`, which leg (d)'s own
   * `requiresReturnToProvisioning` check then declines.
   */
  readonly returnedToProvisioningWorkspaceIds: readonly string[];
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * The default clone lifetime: 24 hours, per `Spec-010 §Resolved Questions and V1
 * Scope Decisions`. Exported so a composition root can express a configured
 * override as a delta from the ratified default rather than re-spelling it.
 */
export const DEFAULT_EPHEMERAL_CLONE_TTL_MS: number = 24 * 60 * 60 * 1000;

// D-010-6's path shape: `<executionRootsDir>/<repoMountId>/clones/<id>`. The
// `worktrees` sibling segment is `./worktree-service.ts`'s; both hang off the
// same per-mount directory so a mount's roots can be reasoned about as a unit.
const CLONE_ROOTS_SEGMENT = "clones";

// The empty directory `core.hooksPath` points at (I-010-10). A dotted sibling of
// the per-mount root directories, so it can never collide with a mount id.
// Spelled identically to `./worktree-service.ts`'s: both services neutralize
// against the SAME directory under a shared execution-roots directory, and two
// spellings would mean two directories, either of which a reaper could remove.
const HOOK_NEUTRALIZATION_SEGMENT = ".hook-neutralization";

// Per-invocation git timeout. Five times `./worktree-service.ts`'s bound because
// the work is categorically larger: `worktree add` writes a working tree beside
// an object store that already exists, while `clone` copies the object store
// itself — on a large repository, a two-minute ceiling would kill a healthy
// provisioning.
//
// INVENTED rather than ratified: D-010-6 and Spec-010 fix the placement and the
// TTL, not an invocation ceiling. The direction of the risk is stated rather
// than hidden — a ceiling that is too high lets a wedged clone hold a `creating`
// row until it fires, while one that is too low fails a healthy prepare and
// parks the run in setup, and the second is the worse outcome because it is
// silent about being a timeout.
const DEFAULT_CLONE_GIT_TIMEOUT_MS = 600_000;

// stdout ceiling. Neither `clone` nor `checkout` writes progress to stdout when
// it is not a TTY, so nothing here approaches it; it is the same bound the
// sibling uses, kept identical so the two git layers cannot diverge on a limit
// that has the same meaning in both.
const GIT_STDIO_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

// The clone states a retirement may still act on. `retired` is excluded because
// it is the target, and `failed` because a failed prepare already disposed of
// whatever it left on disk — sweeping it again would retire rows whose only
// remaining value is the queryable failure record (D-010-11).
const RETIRABLE_CLONE_STATE_PREDICATE = "clones.state IN ('creating', 'ready')";

// The busy-holder deferral, spelled ONCE and interpolated into all three
// candidate reads (see the header's I-010-11 section for why deferral is the
// only branch available rather than a policy this module chose).
//
// `NOT EXISTS` rather than a `LEFT JOIN` plus a negated comparison: with an
// outer join, a clone whose workspace row is missing yields NULL on every
// workspace column, `NOT (NULL = 'busy' AND …)` evaluates to NULL, and the row
// silently drops out of the result — which on leg (d) would strand its directory
// forever. `NOT EXISTS` is two-valued and answers "no busy holder" for exactly
// that case.
//
// MODE-AGNOSTIC on purpose: the question is whether a run is executing in this
// directory, which `busy` plus `fs_root` answers whatever the row's
// `execution_mode` says. The narrower `Spec-010 §Fallback Behavior` question —
// the clone backing a live `ephemeral clone`-mode workspace's current root — is
// the DISPOSITION's, and carries the mode check separately.
const CLONE_NOT_HELD_BY_BUSY_WORKSPACE_PREDICATE = `NOT EXISTS (
       SELECT 1
         FROM workspaces AS holder
        WHERE holder.id = clones.workspace_id
          AND holder.state = 'busy'
          AND holder.fs_root = clones.clone_root
     )`;

// The two `workspaces` values the disposition is defined against. Written as
// annotated constants rather than inline literals so the comparison is checked
// against the contract vocabularies rather than against two hand-typed strings —
// `'ephemeral clone'` in particular carries a space, and a typo in it would
// silently make the disposition unreachable.
const EPHEMERAL_CLONE_EXECUTION_MODE: ExecutionMode = "ephemeral clone";
const READY_WORKSPACE_STATE: WorkspaceState = "ready";

// The default when a prepare names no policy — the disposable per-run clone.
const DEFAULT_CLEANUP_POLICY: EphemeralCloneCleanupPolicy = "on_run_complete";

// Which `cleanup_policy` each retirement trigger retires.
//
// Today's single entry is an identity mapping, and `retireForWorkspace` could
// bind its `trigger` argument straight into the query instead. It deliberately
// does not: that only works while the two vocabularies share a spelling, and the
// failure it sets up is silent. A second trigger — a session close, say — bound
// directly would compare against a `cleanup_policy` value no row can hold and
// retire NOTHING, with no error anywhere. Routing through a `Record` keyed by the
// trigger union makes that same widening a type error HERE, at the one place
// where the answer ("and which policies does that retire?") belongs.
const RETIREMENT_TRIGGER_POLICIES: Record<
  EphemeralCloneRetirementTrigger,
  EphemeralCloneCleanupPolicy
> = {
  on_run_complete: "on_run_complete",
};

// --------------------------------------------------------------------------
// Row and bind-parameter shapes
// --------------------------------------------------------------------------
//
// Declared as the type arguments on `prepare<Bind, Result>` rather than applied
// with `as` at each read. The claim is identical either way — the column list is
// the evidence — but stating it at the QUERY makes it fail as a type error at
// the read site if the two drift, and keeps the production paths cast-free.

interface WorkspaceMountRow {
  readonly id: string;
  readonly repo_mount_id: string;
}

interface AttachedMountRow {
  readonly id: string;
  readonly canonical_root: string;
}

/**
 * A retirement candidate, with the workspace facts the disposition decision
 * needs alongside it.
 *
 * One shape for all three retirement paths — `dispose`, `retireForWorkspace` and
 * the tick's legs (a)/(b) — so `#retireClone` takes one type and the disposition
 * rule is applied in one place.
 *
 * The workspace columns are NULLABLE because the reads LEFT-join: `workspace_id`
 * is a NOT NULL foreign key, so a missing workspace means corruption rather than
 * a legitimate absence, but an INNER join would make such a clone invisible to
 * `dispose` (reported as `clone.not_found`, sending an operator to look for a row
 * that is right there) and unreachable by the tick.
 */
interface CloneRetirementRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly clone_root: string;
  readonly state: string;
  readonly workspace_state: string | null;
  readonly workspace_execution_mode: string | null;
  readonly workspace_fs_root: string | null;
}

interface WorkspaceLookupParams {
  readonly workspace_id: string;
}

interface MountLookupParams {
  readonly repo_mount_id: string;
}

interface CloneLookupParams {
  readonly clone_id: string;
}

interface WorkspaceRetirementParams {
  readonly workspace_id: string;
  readonly cleanup_policy: string;
}

interface SweepParams {
  readonly now: string;
}

interface InsertCloneParams {
  readonly id: string;
  readonly workspace_id: string;
  readonly clone_root: string;
  readonly branch_name: string;
  readonly cleanup_policy: string;
  readonly expires_at: string;
  readonly now: string;
}

interface CloneTransitionParams {
  readonly clone_id: string;
  readonly now: string;
}

/** Everything the clone materialization needs, named so the four cannot be transposed. */
interface CloneMaterialization {
  readonly canonicalRoot: string;
  readonly cloneRootsDirectory: string;
  readonly cloneRoot: string;
  readonly branchName: string;
}

// --------------------------------------------------------------------------
// Default seam implementations
// --------------------------------------------------------------------------

/**
 * The strip list, keyed for case-insensitive lookup.
 *
 * The list itself is IMPORTED from `../workspace/repo-root-resolver.js` rather
 * than re-spelled. It is a security fact — which ambient variables can redirect
 * git's repository discovery — and two copies of a security fact drift, with the
 * copy that stopped being maintained silently handing a redirected `GIT_DIR` to
 * a `clone`. The ASSEMBLY below is local for the same reason
 * `./worktree-service.ts`'s is: its rationale is documented at that export.
 */
const DISCOVERY_REDIRECTING_GIT_ENV_KEYS_UPPERCASED = new Set(
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS.map((key) => key.toUpperCase()),
);

/**
 * The environment every git invocation runs under. Read at call time so a daemon
 * that mutates its own environment is followed rather than snapshotted.
 */
function buildCloneGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (DISCOVERY_REDIRECTING_GIT_ENV_KEYS_UPPERCASED.has(key.toUpperCase())) {
      continue;
    }
    environment[key] = value;
  }
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  // A `clone` of a local path never authenticates, but a git that decided to
  // prompt — a source path that resolves to a URL-like remote, say — would block
  // on a terminal the daemon does not have until the timeout fires.
  environment["GIT_TERMINAL_PROMPT"] = "0";
  return environment;
}

/** `execFile` with an argv ARRAY — never a shell string. See the header. */
function runCloneGitWithExecFile(
  argv: readonly string[],
  options: EphemeralCloneGitInvocationOptions,
): Promise<EphemeralCloneGitInvocationResult> {
  return new Promise<EphemeralCloneGitInvocationResult>((resolve, reject) => {
    execFile(
      DEFAULT_GIT_EXECUTABLE,
      [...argv],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: GIT_STDIO_MAX_BUFFER_BYTES,
        env: buildCloneGitEnvironment(),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

const DEFAULT_EPHEMERAL_CLONE_FILESYSTEM: EphemeralCloneFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};

// --------------------------------------------------------------------------
// Module helpers
// --------------------------------------------------------------------------

/**
 * The TTL deadline: `instant + milliseconds`, in the same ISO-8601 UTC spelling
 * the instant arrived in.
 *
 * Throws a plain `Error` on an unparsable instant rather than a domain carrier.
 * The only way to reach it is an injected clock that does not return
 * `toISOString()` output, which is a wiring defect rather than anything a caller
 * did — and it is better caught loudly at the first prepare than written into
 * `expires_at`, where it would make leg (a) compare garbage forever.
 */
function addMillisecondsToInstant(instant: string, milliseconds: number): string {
  const parsedInstant = Date.parse(instant);
  if (Number.isNaN(parsedInstant)) {
    throw new Error(
      `EphemeralCloneService: cannot compute a TTL deadline from "${instant}" — the injected ` +
        `clock must return Date.prototype.toISOString() output.`,
    );
  }
  return new Date(parsedInstant + milliseconds).toISOString();
}

/**
 * Whether retiring this clone must hand its workspace back to `provisioning`
 * (`Spec-010 §Fallback Behavior`).
 *
 * All three conditions are the sentence's: the workspace is LIVE (`ready` — a
 * `busy` one never reaches here, and an `archived` or `provisioning` one has no
 * live root to lose), it is in clone MODE, and the retiring clone is its CURRENT
 * root rather than a predecessor the workspace already moved off.
 *
 * `stale` is deliberately not a member. `Spec-010 §Fallback Behavior` reserves it
 * for fault paths, and `beginReprovision` would clear the `metadata.lastError`
 * that a stale workspace's repair path exists to surface — so a stale workspace
 * keeps its dangling `fs_root` until that repair reprovisions it, which is the
 * path that owns the field.
 */
function requiresReturnToProvisioning(row: CloneRetirementRow): boolean {
  return (
    row.workspace_state === READY_WORKSPACE_STATE &&
    row.workspace_execution_mode === EPHEMERAL_CLONE_EXECUTION_MODE &&
    row.workspace_fs_root === row.clone_root
  );
}

// --------------------------------------------------------------------------
// EphemeralCloneService
// --------------------------------------------------------------------------

/**
 * Owns every `ephemeral_clones` transition and every clone-scoped git
 * invocation.
 *
 * Statement-per-transition, following `../workspace/workspace-service.js`: each
 * `UPDATE` carries its own legal-predecessor set in its `WHERE` clause, so the
 * transition table lives in the statements rather than in branches that can
 * drift from them.
 */
export class EphemeralCloneService {
  readonly #executionRootsDirectory: string;
  readonly #hookNeutralizationDirectory: string;
  readonly #beginWorkspaceReprovision: WorkspaceReprovisionBeginner;
  readonly #ttlMs: number;
  readonly #git: EphemeralCloneGitRunner;
  readonly #filesystem: EphemeralCloneFilesystem;
  readonly #gitCommandTimeoutMs: number;
  readonly #now: () => string;
  readonly #newCloneId: () => string;

  readonly #selectWorkspaceStmt: Statement<WorkspaceLookupParams, WorkspaceMountRow>;
  readonly #selectAttachedMountStmt: Statement<MountLookupParams, AttachedMountRow>;
  readonly #selectCloneStmt: Statement<CloneLookupParams, CloneRetirementRow>;
  readonly #selectRetirableForWorkspaceStmt: Statement<
    WorkspaceRetirementParams,
    CloneRetirementRow
  >;
  readonly #selectSweepableStmt: Statement<SweepParams, CloneRetirementRow>;
  readonly #selectUncleanedRetiredStmt: Statement<[], CloneRetirementRow>;
  readonly #insertCloneStmt: Statement<InsertCloneParams>;
  readonly #markReadyStmt: Statement<CloneTransitionParams>;
  readonly #markFailedStmt: Statement<CloneTransitionParams>;
  readonly #retireStmt: Statement<CloneTransitionParams>;
  readonly #stampCleanedStmt: Statement<CloneTransitionParams>;

  constructor(deps: EphemeralCloneServiceDeps) {
    this.#executionRootsDirectory = deps.executionRootsDirectory;
    this.#hookNeutralizationDirectory = join(
      deps.executionRootsDirectory,
      HOOK_NEUTRALIZATION_SEGMENT,
    );
    this.#beginWorkspaceReprovision = deps.beginWorkspaceReprovision;
    this.#ttlMs = deps.ttlMs ?? DEFAULT_EPHEMERAL_CLONE_TTL_MS;
    this.#git = deps.git ?? runCloneGitWithExecFile;
    this.#filesystem = deps.filesystem ?? DEFAULT_EPHEMERAL_CLONE_FILESYSTEM;
    this.#gitCommandTimeoutMs = deps.gitCommandTimeoutMs ?? DEFAULT_CLONE_GIT_TIMEOUT_MS;
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newCloneId = deps.newCloneId ?? ((): string => randomUUID());

    const database = deps.database;

    // `ephemeral_clones` has no `repo_mount_id` column: the clone belongs to a
    // workspace, and the mount is reached THROUGH it. So a prepare resolves the
    // workspace first, and an unknown one is `workspace.not_found` rather than a
    // clone failure — the caller named a workspace that is not there.
    this.#selectWorkspaceStmt = database.prepare<WorkspaceLookupParams, WorkspaceMountRow>(
      `SELECT id, repo_mount_id
         FROM workspaces
        WHERE id = @workspace_id`,
    );

    // Scoped to `state = 'attached'`, the Plan-009 ordering obligation: a
    // detached mount is not a provisioning target, and `repo.not_found` is a
    // more honest answer than letting it reach the git layer.
    this.#selectAttachedMountStmt = database.prepare<MountLookupParams, AttachedMountRow>(
      `SELECT id, canonical_root
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    // `dispose`'s read. Unfiltered by state — an already-`retired` row is the
    // idempotent case and has to be readable to be recognized — and it carries
    // the workspace facts so an explicit disposal applies the same disposition
    // the sweep does (CP-009-8: a `ready` workspace whose `fs_root` names a
    // disposed root hands Plan-012 a stale approval scope root, whichever path
    // disposed of it).
    this.#selectCloneStmt = database.prepare<CloneLookupParams, CloneRetirementRow>(
      `SELECT clones.id, clones.workspace_id, clones.clone_root, clones.state,
              workspaces.state AS workspace_state,
              workspaces.execution_mode AS workspace_execution_mode,
              workspaces.fs_root AS workspace_fs_root
         FROM ephemeral_clones AS clones
         LEFT JOIN workspaces ON workspaces.id = clones.workspace_id
        WHERE clones.id = @clone_id`,
    );

    // The run-terminal path. Filtered by `cleanup_policy` rather than retiring
    // everything the workspace owns: a `manual` clone survives its run by
    // definition, and that filter is the whole content of the policy column.
    this.#selectRetirableForWorkspaceStmt = database.prepare<
      WorkspaceRetirementParams,
      CloneRetirementRow
    >(
      `SELECT clones.id, clones.workspace_id, clones.clone_root, clones.state,
              workspaces.state AS workspace_state,
              workspaces.execution_mode AS workspace_execution_mode,
              workspaces.fs_root AS workspace_fs_root
         FROM ephemeral_clones AS clones
         LEFT JOIN workspaces ON workspaces.id = clones.workspace_id
        WHERE clones.workspace_id = @workspace_id
          AND clones.cleanup_policy = @cleanup_policy
          AND ${RETIRABLE_CLONE_STATE_PREDICATE}
          AND ${CLONE_NOT_HELD_BY_BUSY_WORKSPACE_PREDICATE}
        ORDER BY clones.created_at ASC, clones.id ASC`,
    );

    // D-010-13 legs (a) and (b), as one query: TTL expiry OR an archived owning
    // workspace. One pass rather than two so a clone that is both is retired
    // once, and so the busy-holder deferral is applied identically to both.
    //
    // The expiry comparison is TEXT `<=`; see the header for the fixed-width UTC
    // constraint that makes it chronological.
    this.#selectSweepableStmt = database.prepare<SweepParams, CloneRetirementRow>(
      `SELECT clones.id, clones.workspace_id, clones.clone_root, clones.state,
              workspaces.state AS workspace_state,
              workspaces.execution_mode AS workspace_execution_mode,
              workspaces.fs_root AS workspace_fs_root
         FROM ephemeral_clones AS clones
         LEFT JOIN workspaces ON workspaces.id = clones.workspace_id
        WHERE ${RETIRABLE_CLONE_STATE_PREDICATE}
          AND (clones.expires_at <= @now OR workspaces.state = 'archived')
          AND ${CLONE_NOT_HELD_BY_BUSY_WORKSPACE_PREDICATE}
        ORDER BY clones.created_at ASC, clones.id ASC`,
    );

    // Leg (d). The busy guard rides here too, and not redundantly: `dispose`
    // retires a busy-held clone (see the header), so this is the leg that keeps
    // its directory until the run releases.
    //
    // Reads the FULL retirement shape rather than the root alone, because a
    // disposition can still be OWED at this point. `dispose` skips it for a
    // busy-held clone — a `busy` workspace is not a legal `beginReprovision`
    // predecessor — and when the run ends, Plan-009's `releaseBusy` returns the
    // workspace to `ready` without clearing `fs_root`, deliberately. That leaves
    // a `ready` workspace still naming the retired clone's root, and removing
    // the directory without first disposing of the workspace is precisely the
    // CP-009-8 strand: the row would keep advertising an execution root that is
    // no longer there, resolvable only by the health probe deriving `stale` —
    // the FAULT state, where `Spec-010 §Fallback Behavior` prescribes
    // `provisioning`.
    this.#selectUncleanedRetiredStmt = database.prepare<[], CloneRetirementRow>(
      `SELECT clones.id, clones.workspace_id, clones.clone_root, clones.state,
              workspaces.state AS workspace_state,
              workspaces.execution_mode AS workspace_execution_mode,
              workspaces.fs_root AS workspace_fs_root
         FROM ephemeral_clones AS clones
         LEFT JOIN workspaces ON workspaces.id = clones.workspace_id
        WHERE clones.state = 'retired'
          AND clones.cleaned_at IS NULL
          AND ${CLONE_NOT_HELD_BY_BUSY_WORKSPACE_PREDICATE}
        ORDER BY clones.updated_at ASC, clones.id ASC`,
    );

    // `state` is left to the column DEFAULT ('creating') rather than written:
    // the DDL already says a new row starts there, and naming it here would be a
    // second copy of that fact.
    this.#insertCloneStmt = database.prepare<InsertCloneParams>(
      `INSERT INTO ephemeral_clones (
         id, workspace_id, clone_root, branch_name, cleanup_policy,
         expires_at, created_at, updated_at
       ) VALUES (
         @id, @workspace_id, @clone_root, @branch_name, @cleanup_policy,
         @expires_at, @now, @now
       )`,
    );

    this.#markReadyStmt = database.prepare<CloneTransitionParams>(
      `UPDATE ephemeral_clones
          SET state = 'ready', updated_at = @now
        WHERE id = @clone_id AND state = 'creating'`,
    );

    // No event accompanies this one (D-010-11): the failure incident surfaces as
    // the caller's `workspace.stale`, which carries the detail.
    this.#markFailedStmt = database.prepare<CloneTransitionParams>(
      `UPDATE ephemeral_clones
          SET state = 'failed', updated_at = @now
        WHERE id = @clone_id AND state = 'creating'`,
    );

    // Every non-`retired` state is a legal predecessor, `failed` included —
    // admitting `failed` is what makes a failed prepare's row reachable by leg
    // (d), which only ever sees `retired` rows.
    //
    // Zero rows changed is the idempotent case rather than an error: it means a
    // concurrent retirement won, and the outcome this call wanted is the outcome
    // the row has.
    this.#retireStmt = database.prepare<CloneTransitionParams>(
      `UPDATE ephemeral_clones
          SET state = 'retired', updated_at = @now
        WHERE id = @clone_id AND state <> 'retired'`,
    );

    // Guarded on `cleaned_at IS NULL` so a concurrent tick that already stamped
    // the row does not have its timestamp overwritten.
    this.#stampCleanedStmt = database.prepare<CloneTransitionParams>(
      `UPDATE ephemeral_clones
          SET cleaned_at = @now, updated_at = @now
        WHERE id = @clone_id AND cleaned_at IS NULL`,
    );
  }

  // ------------------------------------------------------------------------
  // prepare
  // ------------------------------------------------------------------------

  /**
   * Provision a disposable clone: resolve the workspace's mount, record the
   * `creating` row, clone the canonical root to the D-010-6 path with hooks
   * neutralized, create the supplied head branch, then record `ready`.
   *
   * The ORDER is the contract, and each step sits where its failure is
   * survivable:
   *
   * 1. **Workspace and mount resolution happen before any row exists.** A
   *    request that cannot proceed leaves no `ephemeral_clones` row at all —
   *    there is nothing to mark `failed`, because nothing was created.
   * 2. **The `creating` row is durable before git runs.** A failed
   *    materialization marks it `failed` and throws, so the incident stays
   *    queryable through the status-read surface rather than vanishing — which
   *    is the only trail a clone failure has, since it emits nothing (D-010-11).
   * 3. **`ready` is a compare-and-swap from `creating`.** Nothing else can have
   *    moved the row except a concurrent disposal, which is treated as a failed
   *    preparation below.
   *
   * The caller — T2.4's execution-root orchestrator — is what turns the throw
   * into the workspace-level disposition, calling Plan-009's `failReprovision`
   * so the workspace goes `stale` with the detail and the run parks in setup
   * (`Spec-010 §Fallback Behavior`). This service never substitutes a different
   * execution mode, and it never touches `workspaces` (I-010-11).
   */
  async prepare(input: PrepareEphemeralCloneInput): Promise<PreparedEphemeralClone> {
    const workspace = this.#selectWorkspaceStmt.get({ workspace_id: input.workspaceId });
    if (workspace === undefined) {
      // Plan-009's carrier, not a Plan-010 re-mint: one code with two classes
      // would make `instanceof` discrimination depend on which module a throw
      // site imported.
      throw new WorkspaceNotFoundError(input.workspaceId);
    }

    const mount = this.#selectAttachedMountStmt.get({ repo_mount_id: workspace.repo_mount_id });
    if (mount === undefined) {
      throw new RepoMountNotFoundError(workspace.repo_mount_id);
    }

    const cloneId = this.#newCloneId();
    const cloneRootsDirectory = join(
      this.#executionRootsDirectory,
      workspace.repo_mount_id,
      CLONE_ROOTS_SEGMENT,
    );
    const cloneRoot = join(cloneRootsDirectory, cloneId);
    const cleanupPolicy = input.cleanupPolicy ?? DEFAULT_CLEANUP_POLICY;

    // ONE instant for the row and the deadline, rather than two clock reads:
    // `expires_at` is `created_at + ttlMs` by definition, and a second read
    // would make the stored deadline disagree with that definition by however
    // long the first statement took.
    const preparedAt = this.#now();
    const expiresAt = addMillisecondsToInstant(preparedAt, this.#ttlMs);

    this.#insertCloneStmt.run({
      id: cloneId,
      workspace_id: workspace.id,
      clone_root: cloneRoot,
      branch_name: input.branchName,
      cleanup_policy: cleanupPolicy,
      expires_at: expiresAt,
      now: preparedAt,
    });

    let observedBaseBranch: string | undefined;
    try {
      observedBaseBranch = await this.#materializeClone({
        canonicalRoot: mount.canonical_root,
        cloneRootsDirectory,
        cloneRoot,
        branchName: input.branchName,
      });
    } catch (materializationFailure) {
      await this.#recordPrepareFailure(cloneId, cloneRoot);
      throw materializationFailure;
    }

    if (this.#markReadyStmt.run({ clone_id: cloneId, now: this.#now() }).changes !== 1) {
      // The row left `creating` while git was running, which only a concurrent
      // `dispose` or `retireForWorkspace` can do. Reported as a preparation
      // failure — which is the honest answer, since no usable clone came out of
      // this call — rather than as a consistency error: the row is already
      // `retired`, so leg (d) removes the directory, and `#recordPrepareFailure`
      // is deliberately NOT called here because its `state = 'creating'`
      // predicate could not match and its removal would race that leg.
      throw new ClonePrepareFailedError("concurrently_retired");
    }

    return {
      cloneId,
      workspaceId: workspace.id,
      cloneRoot,
      branchName: input.branchName,
      // Conditional spread rather than `baseBranch: observedBaseBranch`:
      // `exactOptionalPropertyTypes` distinguishes an absent key from one
      // explicitly set to `undefined`, and the contract above says ABSENT.
      ...(observedBaseBranch === undefined ? {} : { baseBranch: observedBaseBranch }),
      cleanupPolicy,
      expiresAt,
      state: "ready",
    };
  }

  // ------------------------------------------------------------------------
  // dispose
  // ------------------------------------------------------------------------

  /**
   * Explicit disposal: record the clone's retirement, and hand its workspace
   * back to `provisioning` when the clone was that workspace's current execution
   * root. NOTHING on disk (I-010-9) — the root survives until a
   * {@link EphemeralCloneService.cleanupTick} removes it and stamps `cleaned_at`.
   *
   * IDEMPOTENT on an already-`retired` row: the same response, and no second
   * write. Every other state — `failed` included — is a legal predecessor;
   * admitting `failed` is what makes a failed preparation's leftover root
   * reachable by leg (d), which only ever sees `retired` rows.
   *
   * Does NOT refuse while a `busy` workspace holds the clone. There is no
   * ratified conflict code for it in `error-contracts.md §Ephemeral Clone` — the
   * clone surface has exactly two, `clone.not_found` and `clone.prepare_failed`
   * — and the running run is protected where it matters: leg (d) defers the disk
   * removal until the workspace releases.
   */
  async dispose(cloneId: string): Promise<EphemeralCloneDisposeResponse> {
    const row = this.#selectCloneStmt.get({ clone_id: cloneId });
    if (row === undefined) {
      throw new CloneNotFoundError(cloneId);
    }

    // Parses the ROW's id, not the argument, and deliberately AFTER the
    // not-found refusal. The brand is an outbound claim about the value this
    // service stored (always a `randomUUID()`), not an inbound validation of the
    // caller's string — so a malformed id gets `CloneNotFoundError`, the honest
    // answer, instead of a ZodError that names no domain fault.
    const parsedCloneId = EphemeralCloneIdSchema.parse(row.id);

    // Parsed rather than cast: the column's CHECK constraint makes an
    // out-of-vocabulary value reachable only through corruption, and the schema
    // enum is the honest narrowing from `string`.
    if (EphemeralCloneStateSchema.parse(row.state) !== "retired") {
      await this.#retireClone(row);
    }

    return { cloneId: parsedCloneId, state: "retired" };
  }

  // ------------------------------------------------------------------------
  // retireForWorkspace
  // ------------------------------------------------------------------------

  /**
   * The run-terminal path: retire the workspace's clones whose `cleanup_policy`
   * matches the trigger. Returns the ids retired, in creation order.
   *
   * The trigger selects the policies it retires through
   * {@link RETIREMENT_TRIGGER_POLICIES}; `on_run_complete` retires exactly the
   * `on_run_complete` clones, so a `manual` clone survives the run that created
   * it and waits for an explicit {@link EphemeralCloneService.dispose} or its
   * TTL.
   *
   * SELECTION never refuses: an unknown workspace, or one with no matching
   * clones, is a no-op. This is called on the terminal path of every run,
   * including runs in modes that never prepared a clone at all, so "there is
   * nothing to retire" is the ordinary answer rather than an exceptional one.
   *
   * The DISPOSITION can still throw, and the distinction matters to the caller.
   * On a clone-mode teardown the disposition is not an edge case — it is the
   * normal shape: the run has released, so the workspace is `ready` and still
   * names the clone root, which is exactly `requiresReturnToProvisioning`. Any
   * refusal from Plan-009's `beginReprovision` propagates, and it propagates
   * deliberately (see `#retireClone`): the workspace is the state this call
   * exists to correct, so swallowing would report a clean teardown over a
   * workspace still advertising a root about to be removed. A run-teardown
   * caller therefore owns this failure — the honest handling is to record it and
   * let the next `cleanupTick` converge, not to treat the call as infallible.
   *
   * Carries the busy-holder deferral like every other retirement path, which is
   * not vacuous on this path: a workspace released by one run can be claimed by
   * the next before this call lands, and the clone the next run is executing in
   * is exactly the one this call would otherwise retire. The deferred clone is
   * picked up by that run's own terminal call, or by its TTL.
   */
  async retireForWorkspace(
    workspaceId: string,
    trigger: EphemeralCloneRetirementTrigger,
  ): Promise<readonly string[]> {
    const retiredCloneIds: string[] = [];
    const candidates = this.#selectRetirableForWorkspaceStmt.all({
      workspace_id: workspaceId,
      cleanup_policy: RETIREMENT_TRIGGER_POLICIES[trigger],
    });
    for (const row of candidates) {
      await this.#retireClone(row);
      retiredCloneIds.push(row.id);
    }
    return retiredCloneIds;
  }

  // ------------------------------------------------------------------------
  // cleanupTick
  // ------------------------------------------------------------------------

  /**
   * One cleanup tick over the CLONE legs of D-010-13:
   *
   *   (a) clones past their TTL are retired;
   *   (b) clones whose owning workspace archived are retired; and
   *   (d) `retired` roots with no `cleaned_at` are removed from disk — after
   *       any workspace disposition still owed for them — and only then is the
   *       row stamped (I-010-9).
   *
   * (a) and (b) run as one query and before (d), so a clone retired by this tick
   * is cleaned in the same tick rather than waiting for the next one.
   *
   * Leg (c) — the inactive-mount cascade — belongs to `./worktree-service.ts`'s
   * `cleanupPass`, which owns `worktrees`. See the header.
   *
   * Per-row failures PROPAGATE, with ONE adjudicated exception argued at the
   * site: leg (d) skips a row whose disposition refuses with `workspace.busy`,
   * because that refusal means a run claimed the root in the window and the next
   * tick is the right place to retry. The tick is idempotent and re-entrant, so
   * the next one resumes where this stopped: the removal is `force`, the stamp
   * is guarded on `cleaned_at IS NULL`, and a retirement that failed at its
   * disposition left the clone live and the workspace untouched.
   *
   * RESIDUAL, stated rather than waved at: each leg's candidate list is a
   * snapshot, so between the read and a row's own disposition the workspace can
   * move. The window is the same for all three legs, and it has three outcomes.
   * None of them deletes a root under a running run, which is the property the
   * disposition-before-removal ordering buys:
   *
   *   1. The workspace completes a whole `provisioning -> ready` cycle onto a
   *      DIFFERENT root, and this tick hands it back to `provisioning` on the
   *      strength of a stale `fs_root` comparison. The removal that follows
   *      touches the retired clone's OWN root and no other, so the cost is the
   *      spurious reprovision itself: the workspace loses the root it had just
   *      adopted, and — because Plan-009's statement also rewrites
   *      `execution_mode` to the target mode and clears `metadata.lastError` —
   *      a mode selection and a recorded failure with it. The orphaned root is
   *      reclaimed by leg (a) at its TTL WHILE IT IS A CLONE. T3.1's
   *      mode-selection path can leave a WORKTREE root there instead, which has
   *      no row in this table and no TTL leg; that leak is acknowledged, not
   *      closed here, and nothing switches modes until Phase 3 ships.
   *   2. A run claims the workspace and the disposition refuses `workspace.busy`
   *      — the adjudicated skip below, which writes nothing and defers the row.
   *   3. Another provisioner reaches `beginReprovision` first, leaving the
   *      workspace `provisioning`; the disposition then refuses with an
   *      invariant error and the pass aborts. The next tick reads
   *      `provisioning`, declines the disposition, and removes + stamps.
   *
   * Closing the window entirely needs a transaction spanning an async event
   * append, which `better-sqlite3` cannot give (see `#retireClone`).
   */
  async cleanupTick(): Promise<EphemeralCloneCleanupTickResult> {
    // One clock read for the whole expiry comparison, so every row in this tick
    // is judged against the same instant.
    const sweptAt = this.#now();

    const retiredCloneIds: string[] = [];
    const returnedToProvisioningWorkspaceIds: string[] = [];
    for (const row of this.#selectSweepableStmt.all({ now: sweptAt })) {
      if (await this.#retireClone(row)) {
        returnedToProvisioningWorkspaceIds.push(row.workspace_id);
      }
      retiredCloneIds.push(row.id);
    }

    const cleanedCloneIds: string[] = [];
    for (const row of this.#selectUncleanedRetiredStmt.all()) {
      // The disposition owed to a clone `dispose` retired while its workspace
      // was busy — see the statement. It runs BEFORE the removal for the reason
      // `#retireClone` gives: `provisioning` is a state `markBusy` cannot claim,
      // so this is also the transactional barrier that keeps a run starting in
      // the window from having its execution root deleted underneath it.
      if (requiresReturnToProvisioning(row)) {
        try {
          await this.#beginWorkspaceReprovision(row.workspace_id, EPHEMERAL_CLONE_EXECUTION_MODE);
        } catch (dispositionFailure) {
          // ADJUDICATED: a `busy` refusal SKIPS the row; everything else
          // propagates.
          //
          // The candidate list is a snapshot, and `WorkspaceBusyError` here means
          // exactly one thing — a `markBusy` landed between the read and this
          // call, so a run is now executing in the very directory this iteration
          // was about to delete. Skipping is not a swallow: nothing has been
          // written, the row stays `retired` with `cleaned_at` NULL, and the next
          // tick's busy guard defers it until the run releases. Propagating
          // instead would abort the whole pass over an ordinary transient race
          // and strand every later row in the snapshot.
          //
          // The T2.2 cascade arm propagates, and that is not a contradiction:
          // its throw reports a cross-plan disagreement, whereas this one is a
          // race the next tick resolves by itself.
          //
          // The propagating arm is NOT claimed to be disagreement-only, because
          // it is not. It also catches an ordinary race: T2.4's prepare can call
          // `beginReprovision` in the same window, leaving the workspace
          // `provisioning` — neither a legal predecessor nor `busy` — so this
          // call gets `WorkspaceServiceInvariantError` and the pass aborts. That
          // outcome is fail-closed and self-correcting (the next tick reads
          // `provisioning`, declines the disposition, and removes + stamps), and
          // absorbing it is not worth widening the catch for: the same carrier
          // reports archived predecessors and genuine compare-and-swap anomalies,
          // which are precisely what the fail-closed arm exists to surface.
          if (!(dispositionFailure instanceof WorkspaceBusyError)) {
            throw dispositionFailure;
          }
          continue;
        }
        returnedToProvisioningWorkspaceIds.push(row.workspace_id);
      }
      await this.#filesystem.removeDirectory(row.clone_root);
      this.#stampCleanedStmt.run({ clone_id: row.id, now: this.#now() });
      cleanedCloneIds.push(row.id);
    }

    return { retiredCloneIds, cleanedCloneIds, returnedToProvisioningWorkspaceIds };
  }

  // ------------------------------------------------------------------------
  // Internals — retirement
  // ------------------------------------------------------------------------

  /**
   * Record one clone's retirement, with the workspace disposition first.
   * Returns whether the disposition was applied.
   *
   * The order is load-bearing and is argued at the header's I-010-9 section:
   * `beginReprovision` moves the workspace to `provisioning`, which `markBusy`
   * cannot claim, so the retirement that follows cannot strand a live run — and
   * a crash between the two leaves a recoverable state rather than a `ready`
   * workspace advertising a retired root (CP-009-8).
   *
   * The two writes are NOT one transaction, and cannot be: `beginReprovision` is
   * async because it appends an event, while `better-sqlite3`'s `transaction()`
   * is synchronous. What stands in for atomicity is that the read is a single
   * statement (so the disposition decision is taken against one consistent
   * observation) and both writes are compare-and-swap (so an interleaving writer
   * loses no update — it wins, and this call's write matches nothing).
   *
   * A failed disposition propagates, aborting the caller's pass. That is the
   * conservative direction: nothing has been written yet, the clone stays live
   * and expired, and the next tick retries the whole row.
   */
  async #retireClone(row: CloneRetirementRow): Promise<boolean> {
    const returnedToProvisioning = requiresReturnToProvisioning(row);
    if (returnedToProvisioning) {
      await this.#beginWorkspaceReprovision(row.workspace_id, EPHEMERAL_CLONE_EXECUTION_MODE);
    }
    // Zero rows changed means a concurrent retirement committed first, which is
    // the outcome this call wanted; see the statement's own note.
    this.#retireStmt.run({ clone_id: row.id, now: this.#now() });
    return returnedToProvisioning;
  }

  /**
   * Record a preparation failure on an existing `creating` row, and dispose of
   * whatever the failed attempt left behind.
   *
   * No event, by D-010-11. The best-effort root removal keeps a half-written
   * clone from being the reason a retried preparation fails on "path already
   * exists"; it is scoped to a path the daemon just minted under its own
   * execution-roots directory, keyed by a fresh clone id, so it can only reach
   * debris this call produced.
   */
  async #recordPrepareFailure(cloneId: string, cloneRoot: string): Promise<void> {
    // Zero rows changed is TOLERATED rather than asserted: the predicate can
    // only miss if the row already left `creating`, which means another writer
    // has already recorded a disposition for it — and a throw here would REPLACE
    // the typed preparation failure the caller is about to re-raise with a
    // consistency error that names neither the cause nor a repair.
    this.#markFailedStmt.run({ clone_id: cloneId, now: this.#now() });
    try {
      await this.#filesystem.removeDirectory(cloneRoot);
    } catch {
      // Swallowed deliberately, and ONLY here: the caller is already throwing
      // the preparation failure, and replacing it with a cleanup error would
      // hide the reason provisioning failed.
      //
      // What the swallow leaves behind, stated rather than waved at: the row is
      // `failed`, and a `failed` row is excluded from both tick queries — legs
      // (a)/(b) want a live state, leg (d) wants `retired` — so nothing
      // automatic disposes of this directory. It is bounded to one root per
      // failure whose cleanup ALSO failed, it stays visible through the
      // status-read surface (D-010-11), and the operator route out is the
      // ordinary one: `dispose` on the failed row, which is a legal transition
      // precisely so that leg (d) can then reach it.
    }
  }

  // ------------------------------------------------------------------------
  // Internals — git
  // ------------------------------------------------------------------------

  /**
   * The single git entry point. Prepends the hook-neutralization flag and
   * nothing else, so I-010-10's quantifier holds structurally (see the header).
   */
  async #runGit(argv: readonly string[]): Promise<EphemeralCloneGitInvocationResult> {
    await this.#filesystem.createDirectory(this.#hookNeutralizationDirectory);
    return this.#git(["-c", `core.hooksPath=${this.#hookNeutralizationDirectory}`, ...argv], {
      timeoutMs: this.#gitCommandTimeoutMs,
    });
  }

  /**
   * Materialize the clone: copy the mount's canonical root to the D-010-6 path,
   * observe the base branch it landed on, then create the requested head branch
   * in it. Returns the observed base, or `undefined` when the clone's own HEAD
   * lands detached (a source HEAD commit no branch references — see the
   * `baseBranch` contract).
   *
   * Only the PARENT directory is created here. `git clone` creates its own
   * target and refuses one that already exists and is non-empty, and creating
   * the leaf would put this module in the business of predicting which of those
   * git tolerates — the same reason `./worktree-service.ts` gives.
   *
   * A clone plus a cut rather than one `clone --branch`: `--branch` selects an
   * EXISTING ref in the source to check out, while this seam's contract is to
   * CREATE the supplied head branch. `clone -b` on a name the source does not
   * have fails, so the pair is not an implementation preference — it is the only
   * spelling that does what the task row asks. The base read sits between them,
   * for the reason argued at its site.
   *
   * Every failure here becomes `ClonePrepareFailedError`, each carrying its own
   * {@link ClonePrepareFailureReason}. The git `stderr` stops HERE: it is the
   * value most likely to name a filesystem path, and `error-contracts.md
   * §Ephemeral Clone` bans echoing one, so the discriminant is all that survives
   * the boundary.
   */
  async #materializeClone(materialization: CloneMaterialization): Promise<string | undefined> {
    try {
      await this.#filesystem.createDirectory(materialization.cloneRootsDirectory);
    } catch {
      throw new ClonePrepareFailedError("execution_root_unavailable");
    }

    try {
      // Both positionals are daemon-derived — the mount's canonical root and a
      // path minted under the execution-roots directory — so neither can carry
      // caller-controlled option syntax into the argv.
      //
      // `--no-hardlinks` because the source is always a local path, and a local
      // clone hardlinks `.git/objects/**` into the target instead of copying it.
      // Sharing object-store inodes with the user's own repository is not the
      // "disposable isolated clone" `Spec-010 §Required Behavior` describes, and
      // CP-009-8 hands this root to Plan-012 as an approval scope — an approval
      // scoped to the clone would reach files that ARE the user's repository.
      // T2.6's real-git tier is where "the object files are copies" gets
      // asserted against git rather than modelled.
      await this.#runGit([
        "clone",
        "--no-hardlinks",
        materialization.canonicalRoot,
        materialization.cloneRoot,
      ]);
    } catch {
      throw new ClonePrepareFailedError("clone_invocation_failed");
    }

    let observedBaseBranch: string | undefined;
    try {
      // BETWEEN the clone and the cut, and that ordering is forced: once
      // `checkout -b` lands, HEAD names the NEW branch and the base it descended
      // from is no longer recoverable from the clone.
      //
      // `branch --show-current` rather than `symbolic-ref --short HEAD`, and the
      // reason is this module's own seam rather than taste. A detached HEAD is a
      // lawful source shape, and `symbolic-ref` reports it by exiting NON-ZERO
      // with empty output — a signal {@link EphemeralCloneGitRunner} structurally
      // cannot carry, since it surfaces a failed invocation as an opaque
      // rejection with no exit code. Reading absence off that rejection would
      // mean treating every failure as "detached", which is exactly the swallow
      // `base_branch_unreadable` exists to prevent. `--show-current` exits 0 for
      // both shapes and reports absence as empty stdout, keeping the lawful case
      // and the failure case distinguishable at a seam that only sees stdout.
      // It is porcelain; its empty-on-detached contract is documented, was
      // verified on git 2.50.1 when this landed, and is re-pinned against real
      // git at T2.6's acceptance tier.
      const headBranchRead = await this.#runGit([
        "-C",
        materialization.cloneRoot,
        "branch",
        "--show-current",
      ]);
      const observedHead = headBranchRead.stdout.trim();
      observedBaseBranch = observedHead === "" ? undefined : observedHead;
    } catch {
      throw new ClonePrepareFailedError("base_branch_unreadable");
    }

    try {
      // `-C <cloneRoot>` rather than a `cwd`: the invocation is entirely in the
      // argv (see {@link EphemeralCloneGitRunner}). `branchName` rides the VALUE
      // slot of `-b`, which is what discharges the option-injection obligation
      // for the one caller-supplied element in any of the three argvs.
      await this.#runGit([
        "-C",
        materialization.cloneRoot,
        "checkout",
        "-b",
        materialization.branchName,
      ]);
    } catch {
      // Includes the reachable case of a name that already exists in the clone,
      // the source's own default branch being the obvious one — refused rather
      // than bound. See the header's residual for the open status question.
      throw new ClonePrepareFailedError("head_branch_unavailable");
    }

    return observedBaseBranch;
  }
}
