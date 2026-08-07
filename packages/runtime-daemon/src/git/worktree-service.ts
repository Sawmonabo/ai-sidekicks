// Worktree lifecycle service — the daemon-side owner of the `worktrees` table
// and of every git invocation that provisions or inspects a worktree root
// (Plan-010 Phase 2, T2.2).
//
// Spec coverage:
//   * `Spec-010 §Required Behavior` — reuse of an existing checkout is
//     explicit, and it preserves branch and provenance context.
//   * `Spec-010 §Default Behavior` — the daemon-derived branch name
//     (`sidekicks/<session-short-id>/<task-slug>`), the hook-neutralized
//     invocation layer, and retirement preserving metadata even when filesystem
//     cleanup later removes the checkout.
//   * `Spec-010 §State And Data Implications` — the row this service writes:
//     branch name, owning repo mount, lifecycle state, and provenance to the
//     creating session and run, with every `fs_root` under the daemon's own
//     execution-roots directory rather than inside the attached checkout.
//   * `Spec-010 §Fallback Behavior` — a dirty or incompatible reuse candidate
//     requires explicit user choice; a failed provisioning parks rather than
//     substitutes; the sweep's retirement disposition.
//   * `Spec-010 §Resolved Questions and V1 Scope Decisions` — the slug rule,
//     the provenance-split collision policy, and the base-ref policy.
//
// Verifies invariant: I-010-3 (creating-session / creating-run provenance is
// recorded and preserved), I-010-4 (at most one live checkout per (mount,
// branch), arbitrated by the partial-unique index rather than by a read),
// I-010-6 (the main checkout is never mutated), I-010-8 (reuse is explicit),
// I-010-9 (retirement is recorded before any disk mutation and the sweep stamps
// `cleaned_at` afterwards), I-010-10 (every provisioning git invocation is
// hook-neutralized), I-010-13 (exactly-once events; `-> failed` emits none).
//
// Cross-plan obligations consumed here: CP-010-7 (this Plan-010-owned `src/git/`
// subtree). CP-010-2 — the Plan-009 reprovision primitives a prepare brackets
// itself with — is named here only to record that it is NOT discharged in this
// file: its Tasks column reads T2.4 / T3.1, and this service holds no
// `workspaces` write at all (I-010-11). The caller wraps these calls.
//
// ---------------------------------------------------------------------------
// I-010-4 is arbitrated by the INDEX, never by a read
// ---------------------------------------------------------------------------
//
// The candidate name is not pre-checked with a `SELECT` and then inserted. Two
// concurrent prepares that both read "free" would both proceed, and the second
// would either overwrite the first's row or hand git a branch it cannot create.
// `idx_worktrees_active_branch` (`UNIQUE (repo_mount_id, branch_name) WHERE
// state NOT IN ('retired', 'failed')`) is the race arbiter: `create` attempts
// the INSERT and reads the UNIQUE violation as the collision signal.
//
// That is also what makes the retry loop safe rather than a crash path. A
// violation aborts the append transaction BEFORE the event row lands (see the
// prelude contract on `WorktreeEventEmitter`), so a losing attempt leaves
// neither a `worktrees` row nor a `worktree.created` event — the next ordinal
// is tried against a clean slate, and I-010-13's exactly-once claim survives an
// arbitrary number of collisions.
//
// A UNIQUE violation is CONFIRMED against a live-row re-read before it is
// interpreted as a branch collision, rather than trusted from the error code
// alone. `worktrees.id` is also unique (TEXT PRIMARY KEY), so an id collision —
// reachable from an injected id source — raises a constraint error too, and
// treating it as a branch collision would silently suffix the branch name and
// report a plausible wrong answer. Anything not confirmed as a live row on the
// same (mount, branch) re-throws unchanged.
//
// The two checks are not redundant, and which of them refuses a given failure
// is a property of SQLite's EXTENDED result codes rather than of the statement.
// Verified against the pinned better-sqlite3 build: a violation of the
// partial-unique branch index reports `SQLITE_CONSTRAINT_UNIQUE`, a violation
// of the `id` primary key's autoindex reports `SQLITE_CONSTRAINT_PRIMARYKEY`,
// and an INSERT violating BOTH reports the branch index. So the CODE check is
// what refuses a pure id collision, and the live-row read is what refuses a
// UNIQUE-coded failure that no live row on this (mount, branch) explains — a
// distinction only reachable with an injected append seam, which is how the
// suite drives each arm separately.
//
// ---------------------------------------------------------------------------
// D-010-7 — the collision policy arrives as `onCollision`; PROVENANCE lives in
// the caller
// ---------------------------------------------------------------------------
//
// The provenance split is the decision's content: a CALLER-SUPPLIED name is
// user intent and is never silently adapted (`worktree.branch_collision`),
// while a DAEMON-DERIVED name is a default, takes the first free ordinal (`-2`,
// then `-3`, …) and reports the chosen name verbatim. The two arms are exactly
// `onCollision: 'refuse'` and `onCollision: 'suffix'` — wire prepares always
// pass `refuse`, the run-setup gate's derived-name path passes `suffix`.
//
// The parameter is EXPLICIT rather than inferred from whether a `branchName`
// was supplied, because by D-010-19 this service never sees a request without
// one: the gate resolves the name first — it is the sole holder of the
// queue-item summary the slug rule prefers — so the mode services below that
// seam always receive an explicit name. A presence-based discriminant would
// therefore read "caller-supplied" on every production call, leaving the suffix
// arm unreachable and turning a derived-name collision into a refusal: the
// exact inversion of the decision.
//
// Knowing which arm a request is IS provenance knowledge, and it lives one
// layer up because that is the layer that derived — or did not derive — the
// name. This service holds no derivation inputs at all (no `taskSummary`), so
// it cannot reconstruct the answer and does not try.
//
// ---------------------------------------------------------------------------
// I-010-6 — what "never mutates the main checkout" means here
// ---------------------------------------------------------------------------
//
// This module issues exactly four invocation shapes over three git verbs, and
// the invariant is a property of that list rather than of a runtime guard:
//
//   * `symbolic-ref --quiet --short HEAD` against the mount's canonical root —
//     a READ. It resolves the default base ref (D-010-8).
//   * `worktree add -b <branch> <root> <base-ref>` against the mount's
//     canonical root — writes the NEW root and registers it in the repository's
//     administrative area. It does not touch the main checkout's working tree,
//     its index, or its `HEAD`.
//   * `worktree prune` against the mount's canonical root — drops the
//     administrative entries of worktrees whose directory is already gone,
//     which is the only thing that ever unregisters what `worktree add` wrote.
//     It reads the main checkout's working tree not at all and writes only
//     inside the administrative area its sibling created the entry in.
//   * `status --porcelain` against a WORKTREE root (never the mount's) — a
//     read, for the reuse cleanliness verdict.
//
// No `checkout`, no `switch`, no `branch`, no `merge`, no `reset`, no `stash`.
// The `branch`-mode counterpart of this invariant — verify the checkout's
// current branch, never switch it — is carried by
// `WorkspaceBranchMismatchError` on the path that owns that mode.
//
// ---------------------------------------------------------------------------
// I-010-10 — hook neutralization is STRUCTURAL
// ---------------------------------------------------------------------------
//
// Every git invocation in this module goes through one private `#runGit`, and
// that method is the only place an argv is assembled. It prepends
// `-c core.hooksPath=<empty dir>` unconditionally, so the invariant's "every
// provisioning git invocation" quantifier is discharged by there being no other
// way to reach git from here — not by remembering the flag at each call site. A
// command-line `-c` outranks repository, global and system config and the
// `GIT_CONFIG_*` injection channel alike, so a repo-local `core.hooksPath`
// cannot win it back.
//
// The neutralization directory is created (recursively, idempotently) before
// each invocation rather than once at construction: an EMPTY directory is the
// mechanism, and a temp-file reaper that removed it between invocations would
// silently restore the repository's own hooks.
//
// Every invocation is `execFile` with an argv ARRAY — never a shell string — so
// a branch name, base ref or path containing shell metacharacters is one
// argument rather than a command. The `baseRef` leading-dash refusal below
// closes the remaining channel, which is option injection rather than shell
// injection.
//
// ---------------------------------------------------------------------------
// I-010-9 — recorded, then cleaned
// ---------------------------------------------------------------------------
//
// `retire` writes `state = 'retired'`, appends `worktree.retired`, and stops.
// `cleaned_at` stays NULL and the root stays on disk. `cleanupPass` is what
// removes the directory, prunes the repository's now-dangling administrative
// entry, and stamps the column, in that order — so a crash between them leaves
// a row the next pass retries (the removal is `force`, hence idempotent), and
// never a row claiming a cleanup that did not happen.
//
// BOTH retirement decisions — already-retired and busy-holder — are taken
// INSIDE the retirement transaction, in `#emitRetirement`'s prelude. A probe
// outside it decides against a state a concurrent writer can still change: the
// append path awaits a signing-key unseal and the per-session append lock
// between the read and the transaction, so a `markBusy` landing in that window
// would have its worktree retired out from under a live run — after which the
// sweep's leg (d) removes the running run's execution root. The prelude is the
// only place where the decision and the write are the same transaction, and it
// is where a throw still aborts before anything persists. `#runDetachCascade`
// in `../workspace/repo-mount-service.js` closes the equivalent race the same
// way, with the same reasoning at its own header.
//
// ---------------------------------------------------------------------------
// RESIDUAL — a branch name can be free in the INDEX and taken in GIT
// ---------------------------------------------------------------------------
//
// Removing a worktree does not delete the branch it held. Verified against git
// 2.50.1 on a scratch repository: once the worktree is gone, a second
// `git worktree add -b <same-name> …` fails with `fatal: a branch named
// '<name>' already exists` (exit 255) even though the branch is checked out
// NOWHERE, while `git worktree add <path> <same-name>` — without `-b` — binds
// the surviving branch and succeeds.
//
// THREE paths reach that state, and only the first involves a cleanup at all:
//
//   * RETIREMENT plus `cleanupPass` leg (d). `-> retired` takes the row out of
//     the index predicate and the pass then removes the checkout the branch was
//     created alongside.
//   * `create`'s READY-EMISSION recovery. `worktree add -b` had already
//     succeeded in full, so the branch certainly exists; the recovery removes
//     the root and lands the row `failed`, which the index predicate excludes
//     exactly as it excludes `retired`.
//   * `create`'s MATERIALIZATION-failure recovery, whenever `worktree add -b`
//     failed after creating the branch ref and before finishing the checkout.
//     Whether the ref survives is git's business and this module never sees it,
//     so on this arm the state is possible rather than certain.
//
// So a caller can find `idx_worktrees_active_branch` reporting the name free
// while git refuses it — including immediately after a transient event-log
// failure, with no retirement and no sweep anywhere in the story. What each
// D-010-7 arm then reports:
//
//   * `refuse` — the INSERT succeeds (no live row to collide with) and
//     materialization fails, so the caller sees `worktree.create_failed` (500)
//     where `worktree.branch_collision` (409) is the honest answer.
//   * `suffix` — the ordinal loop cannot advance at all: it retries only on a
//     SQLite UNIQUE violation, and this failure never reaches the database.
//
// Deliberately NOT closed here by a second arbiter or by reading git's stderr.
// D-010-7 ratifies the index as THE arbiter, a second one would reintroduce the
// read-then-insert race the index exists to close, and this module walls off
// `stderr` by design (`error-contracts.md §Worktree`'s no-path-echo rule). It
// is recorded and handed forward instead: T2.6's real-git acceptance tier is
// the first place the behavior is observable at all, and the disposition — bind
// the surviving branch, delete it during cleanup, or widen the failure taxonomy
// — is a D-010-5 / D-010-7 governance question rather than an implementation
// liberty this task may take.
//
// Refs: Plan-010 (worktree lifecycle and execution modes), Plan-009 (the
// service, statement-per-transition and git-invocation precedents), Plan-006
// (the append path this service's events ride).

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Database, Statement } from "better-sqlite3";

import {
  WorktreeIdSchema,
  WorktreeStateSchema,
  type WorktreeRetireResponse,
  type WorktreeState,
} from "@ai-sidekicks/contracts";

import { RepoMountNotFoundError } from "../workspace/repo-errors.js";
import {
  DEFAULT_GIT_EXECUTABLE,
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
} from "../workspace/repo-root-resolver.js";

import {
  WorktreeBranchCollisionError,
  WorktreeCreateFailedError,
  WorktreeNotFoundError,
  WorktreeRetireConflictError,
  WorktreeReuseConflictError,
} from "./worktree-errors.js";
import type { WorktreeEventEmitter } from "./worktree-event-emitter.js";

// --------------------------------------------------------------------------
// Injected seams
// --------------------------------------------------------------------------

/** Captured stdio from one completed git invocation. */
export interface WorktreeGitInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-invocation bounds. */
export interface WorktreeGitInvocationOptions {
  /** Wall-clock ceiling; the child is killed past it. */
  readonly timeoutMs: number;
}

/**
 * The git process seam.
 *
 * Takes the COMPLETE argv — including `-C <dir>` — and no working directory,
 * which is what makes the argv the whole invocation. A `cwd` option would put
 * half the target outside the recorded argv, and I-010-6 / I-010-10 are both
 * asserted by inspecting recorded argvs: a suite that can see `worktree add`
 * but not which repository it ran against cannot tell a worktree provisioning
 * from a mutation of the main checkout.
 *
 * Declared LOCALLY rather than imported from Plan-009's `GitFileExecutor`
 * (`../workspace/repo-root-resolver.js`), whose shape is close but not equal:
 * that seam takes the executable as its first parameter and a full
 * `GitCommandOptions` (env, maxBuffer, windowsHide) as its third, because the
 * repo-root resolver's env scrub is per-call policy. Here the executable and
 * the environment are fixed by this module, and the argv prefix is fixed by
 * `#runGit`. Same reasoning `worktree-event-emitter.ts` gives for declaring its
 * own append seam.
 *
 * Rejections are opaque to this module: nothing reads a field off the thrown
 * value, so a fake may reject with anything. That is deliberate — the git
 * `stderr` is exactly the value the `error-contracts.md §Worktree` no-path-echo
 * rule keeps out of the typed carrier.
 */
export type WorktreeGitRunner = (
  argv: readonly string[],
  options: WorktreeGitInvocationOptions,
) => Promise<WorktreeGitInvocationResult>;

/**
 * The filesystem seam. Two verbs, both idempotent: `createDirectory` creates
 * leading directories and tolerates an existing one, `removeDirectory` removes
 * recursively and tolerates a missing one. The tolerance is load-bearing for
 * I-010-9 — the sweep's removal is retried until `cleaned_at` is stamped.
 */
export interface WorktreeFilesystem {
  createDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
}

export interface WorktreeServiceDeps {
  /**
   * The daemon's SQLite handle. Statements are prepared once, in the
   * constructor.
   *
   * MUST be the same connection the event log behind {@link events} appends
   * through. Every transition writes its row as a `transactionalPrelude`, and
   * a statement prepared on a DIFFERENT connection does not join the event
   * transaction — so I-010-13's row/event atomicity would silently vanish,
   * with no exception raised anywhere. The retirement path rests on it twice
   * over: `#emitRetirement`'s prelude also READS through this handle (the
   * already-retired re-check and the busy-holder probe), and those reads are
   * race-closing only because they observe the same transaction the retire
   * compare-and-swap commits in.
   *
   * Nothing here can verify handle identity — the event log sits behind the
   * emitter seam — so the composition root owns the constraint, and no test
   * in this package can catch a violation of it. Same posture, and the same
   * Phase-3 wiring obligation, as `../workspace/workspace-service.js`.
   */
  readonly database: Database;
  /** The T2.1 emission seam — this service constructs no envelopes of its own. */
  readonly events: WorktreeEventEmitter;
  /**
   * The daemon's execution-roots directory (D-010-6). Worktree roots are placed
   * at `<executionRootsDirectory>/<repoMountId>/worktrees/<worktreeId>`, and
   * the hook-neutralization directory is a sibling under the same root.
   *
   * Absolute by contract: it is the prefix of every `fs_root` this service
   * writes, and CP-009-8 hands `fs_root` to Plan-012 as an approval scope root
   * — a relative one would be completed against whatever working directory a
   * tool process happens to hold. Not re-validated here; the daemon's
   * configuration layer owns that check, and duplicating it would put one rule
   * in two places.
   */
  readonly executionRootsDirectory: string;
  /** Git process seam; defaults to `execFile` against `git`. */
  readonly git?: WorktreeGitRunner;
  /** Filesystem seam; defaults to `node:fs/promises`. */
  readonly filesystem?: WorktreeFilesystem;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /** Wall clock for `created_at` / `updated_at` / `cleaned_at`. Injectable for tests. */
  readonly now?: () => string;
  /** `worktrees.id` source. Injectable for deterministic tests; defaults to `randomUUID`. */
  readonly newWorktreeId?: () => string;
}

// --------------------------------------------------------------------------
// Inputs and results
// --------------------------------------------------------------------------

/**
 * Inputs for {@link WorktreeService.create}.
 *
 * `branchName` is REQUIRED and `onCollision` is explicit — the D-010-19 seam
 * and the D-010-7 policy respectively. This service derives no names and holds
 * no derivation inputs; see the header.
 *
 * There is no `workspaceId`. The worktree is a checkout of a MOUNT, and the
 * workspace association lives one layer up in the execution-root orchestrator —
 * the same seam boundary `EmitWorktreeEventInput.workspaceId` documents.
 */
export interface CreateWorktreeInput {
  /** The mount to check out from. Must be `attached`. */
  readonly repoMountId: string;
  /** Creating-session provenance — `created_by_session_id`, NOT NULL (I-010-3). */
  readonly sessionId: string;
  /**
   * Creating-run provenance — `worktrees.created_by_run_id`, NULLABLE by
   * design: `null` records a pre-run explicit prepare, which is a fact about
   * the worktree rather than missing data. PROVENANCE ONLY on this seam: the
   * `run-<short-id>` fallback this value also feeds is applied by
   * {@link deriveWorktreeBranchName}, at the layer that derives.
   */
  readonly runId?: string | null;
  /**
   * The branch to create. REQUIRED (D-010-19): the caller resolves the name
   * first — through {@link deriveWorktreeBranchName} when it is a derived one —
   * so this service never sees a nameless request.
   */
  readonly branchName: string;
  /**
   * What a live-checkout collision on `branchName` does (D-010-7). `refuse`
   * raises {@link WorktreeBranchCollisionError}; `suffix` takes the first free
   * ordinal and reports the chosen name verbatim.
   *
   * REQUIRED, with no default. A default would decide the provenance question
   * for a caller who omitted the field — and whichever default were chosen,
   * that omission would silently adapt a user-typed name or silently refuse a
   * daemon-derived one.
   */
  readonly onCollision: "refuse" | "suffix";
  /**
   * Explicit base ref for the new branch. Omitted, the mount's current HEAD
   * branch is used (D-010-8). A value beginning with `-` is REFUSED before any
   * git call — see `WorktreeCreateFailureReason`.
   */
  readonly baseRef?: string;
  /** Envelope actor for the emitted events; defaults to the system actor. */
  readonly actor?: string | null;
  /** Envelope linkage back to the causing event, when the caller has one. */
  readonly correlationId?: string | null;
}

/** A materialized, ready worktree. */
export interface CreatedWorktree {
  readonly worktreeId: string;
  readonly repoMountId: string;
  /**
   * The branch that was actually created — the requested name, or the
   * ordinal-suffixed one an `onCollision: 'suffix'` collision resolved to.
   * Reported VERBATIM (D-010-7) so a caller never has to reconstruct it.
   */
  readonly branchName: string;
  /** `<executionRootsDirectory>/<repoMountId>/worktrees/<worktreeId>` (D-010-6). */
  readonly fsRoot: string;
  /**
   * The ref the branch was cut from — supplied, or the mount's resolved HEAD
   * branch. Returned because the caller's `branch_contexts` row needs a
   * `base_branch` (NOT NULL) and re-resolving it there could observe a
   * different HEAD.
   */
  readonly baseRef: string;
  /** Always `ready`: a create that did not reach `ready` throws instead. */
  readonly state: Extract<WorktreeState, "ready">;
}

/** Inputs for {@link WorktreeService.validateReuse}. */
export interface ValidateWorktreeReuseInput {
  /** The explicitly named candidate (D-010-15). */
  readonly worktreeId: string;
  /**
   * The mount the caller expects the candidate to belong to. REQUIRED, and the
   * reason this method takes a mount at all: `packages/contracts/src/worktree.ts`
   * assigns the mount-consistency check to this method by name, because a
   * candidate from another mount would place the execution root inside a
   * different repository.
   */
  readonly repoMountId: string;
  /** The branch the caller intends to execute against. */
  readonly branchName: string;
  /** Explicit acknowledgement that a dirty candidate may still bind (D-010-15). */
  readonly acknowledgeDirtyCandidate?: boolean;
}

/** A candidate that passed every compatibility check and may be bound. */
export interface ReusableWorktreeCandidate {
  readonly worktreeId: string;
  readonly repoMountId: string;
  readonly branchName: string;
  readonly fsRoot: string;
  readonly state: WorktreeState;
  /** Provenance, preserved from creation (I-010-3). */
  readonly createdBySessionId: string;
  readonly createdByRunId: string | null;
  /**
   * Whether the checkout holds uncommitted work. `true` here means the caller
   * acknowledged it — an unacknowledged dirty candidate throws rather than
   * returning.
   *
   * Reported rather than acted on: the `-> dirty` ROW transition and its
   * `worktree.dirty` event belong to the binder, not to a validation call. A
   * check that wrote state would make the Phase-3 `repo.worktreeReuseCheck`
   * query mutating.
   */
  readonly dirty: boolean;
}

/** Options for {@link WorktreeService.retire}. */
export interface RetireWorktreeOptions {
  readonly actor?: string | null;
  readonly correlationId?: string | null;
}

/** What one {@link WorktreeService.cleanupPass} did, in the order it did it. */
export interface WorktreeCleanupPassResult {
  /** Worktrees retired by the inactive-mount cascade (D-010-13). */
  readonly retiredWorktreeIds: readonly string[];
  /** Worktrees whose root was removed and whose `cleaned_at` was stamped. */
  readonly cleanedWorktreeIds: readonly string[];
}

/** Inputs for {@link deriveWorktreeBranchName}. */
export interface WorktreeBranchNameInput {
  /** The session whose first 8 hex digits form the `<session-short-id>` segment. */
  readonly sessionId: string;
  /** The run behind the `run-<run-short-id>` fallback; `null` when there is none. */
  readonly runId: string | null;
  /** The queue-item summary, the preferred `<task-slug>` source. */
  readonly taskSummary?: string | null;
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

// D-010-6's path shape: `<executionRootsDir>/<repoMountId>/worktrees/<id>`.
// Per-mount rather than flat, so a mount's roots can be reasoned about (and
// swept) as a unit.
const WORKTREE_ROOTS_SEGMENT = "worktrees";

// The empty directory `core.hooksPath` points at (I-010-10). A dotted sibling
// of the per-mount root directories, so it can never collide with a mount id.
const HOOK_NEUTRALIZATION_SEGMENT = ".hook-neutralization";

// `Spec-010 §Default Behavior`'s pattern: `sidekicks/<session-short-id>/<task-slug>`.
const DERIVED_BRANCH_NAME_PREFIX = "sidekicks";
const SHORT_ID_LENGTH = 8;
const TASK_SLUG_MAX_LENGTH = 40;

// The D-010-7 `suffix`-arm ordinal budget. The first attempt uses the bare
// name, so the suffixes run `-2` … `-100`. A bound rather than an unbounded
// loop: past this many live checkouts of one name the daemon is looping on a
// condition it cannot resolve, and a typed `branch_name_unavailable` is a
// better answer than an indefinite retry against the database.
//
// The bound is INVENTED rather than ratified — D-010-7 fixes the policy, not a
// ceiling — and it is the conservative direction: a budget that is too small
// yields a typed refusal, where no budget at all yields a hang.
const MAX_BRANCH_NAME_ORDINAL = 100;

// Per-invocation git timeout. An order of magnitude above Plan-009's
// `DEFAULT_GIT_COMMAND_TIMEOUT_MS` because that bound covers metadata READS
// (`rev-parse`) while this one has to cover `worktree add`, which materializes
// a full checkout — on a large repository a 10-second ceiling would kill a
// healthy provisioning.
const DEFAULT_WORKTREE_GIT_TIMEOUT_MS = 120_000;

// stdout ceiling. Only `status --porcelain` can approach it, and an overflow is
// a rejection — which the cleanliness path reads as `cleanliness_unresolved`
// and refuses on. Fail-closed by construction: a working tree with more than
// this much status output is emphatically not clean, so the refusal agrees with
// the verdict the daemon could not compute.
const GIT_STDIO_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

// The live-row predicate, spelled to match `idx_worktrees_active_branch`'s
// predicate exactly. Any divergence between this and the index would make the
// "live" reads disagree with the arbiter, which is the one thing I-010-4 rests
// on. One constant, interpolated at both call sites: the QUALIFIED spelling is
// valid at the single-table read as well as at the JOIN, so there is no second
// spelling for the two to drift apart on.
const LIVE_WORKTREE_STATE_PREDICATE = "worktrees.state NOT IN ('retired', 'failed')";

// --------------------------------------------------------------------------
// Internal abort signal
// --------------------------------------------------------------------------

/**
 * Module-private abort signal for `#emitRetirement`'s in-prelude re-read of the
 * row's state.
 *
 * The append path runs the prelude and then INSERTs the event row
 * UNCONDITIONALLY — only a THROW rolls the transaction back. So a prelude that
 * merely recorded "the row is already retired" and returned would still commit
 * a second `worktree.retired` for one transition, which is exactly the I-010-13
 * duplicate the compare-and-swap exists to prevent. Throwing is the only way to
 * say "abort, but this is not an error".
 *
 * Caught by EXACTLY this class at both call sites — `retire` turns it into the
 * idempotent response, `cleanupPass` skips the row and continues the pass —
 * while anything else propagates. Not a `DaemonDomainError` and not exported:
 * it names an internal concurrency event rather than anything a caller did
 * wrong, and it never escapes this module. Modelled on
 * `../workspace/workspace-service.js`'s `StaleTransitionRaceError` and
 * `../workspace/repo-mount-service.js`'s `MountDetachRaceError`.
 */
class WorktreeAlreadyRetiredError extends Error {
  constructor(worktreeId: string) {
    super(
      `WorktreeService: worktree ${worktreeId} was already retired when the retirement ` +
        `transaction opened; aborting so no second worktree.retired event is appended for one ` +
        `transition.`,
    );
    this.name = "WorktreeAlreadyRetiredError";
  }
}

// --------------------------------------------------------------------------
// Row and bind-parameter shapes
// --------------------------------------------------------------------------
//
// Declared as the type arguments on `prepare<Bind, Result>` rather than applied
// with `as` at each read. The claim is identical either way — the column list
// is the evidence — but stating it at the QUERY makes it fail as a type error
// at the read site if the two drift, and keeps the production paths cast-free.

interface WorktreeRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
  readonly state: string;
  readonly cleaned_at: string | null;
}

interface AttachedMountRow {
  readonly id: string;
  readonly canonical_root: string;
}

interface WorktreeIdRow {
  readonly id: string;
}

interface WorktreeRootRow {
  readonly id: string;
  readonly fs_root: string;
  /**
   * The owning mount's canonical root, for the administrative-entry prune.
   * NULLABLE because the read LEFT-joins, not because a mount is expected to be
   * missing: the schema and this package's write set make the NULL unreachable,
   * and `#selectUncleanedRetiredStmt` records why it is modelled anyway.
   */
  readonly canonical_root: string | null;
}

interface HoldingWorkspaceRow {
  readonly workspace_id: string;
}

interface MountLookupParams {
  readonly repo_mount_id: string;
}

interface WorktreeLookupParams {
  readonly worktree_id: string;
}

interface BranchLookupParams {
  readonly repo_mount_id: string;
  readonly branch_name: string;
}

interface InsertWorktreeParams {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
  readonly now: string;
}

interface WorktreeTransitionParams {
  readonly worktree_id: string;
  readonly now: string;
}

/**
 * One `create` call's worth of state for the D-010-7 arbitration loop.
 *
 * The requested name and the collision policy are NOT copied out of `input`:
 * both live on it (`branchName` required, `onCollision` explicit), and a copy
 * would be a second place either could be set.
 */
interface CreatingRowAttempt {
  readonly worktreeId: string;
  readonly fsRoot: string;
  readonly input: CreateWorktreeInput;
}

/**
 * What a failed `create` has to dispose of, named for the same reason
 * {@link WorktreeMaterialization} is. `fsRoot` and `canonicalRoot` are both
 * absolute directory paths of the same type, and transposing them would aim
 * `#recordCreateFailure`'s `removeDirectory` at the USER's repository root —
 * a mistake the compiler cannot see through three positional strings.
 */
interface CreateFailureRecovery {
  readonly worktreeId: string;
  /** The worktree root this attempt minted, under the execution-roots directory. */
  readonly fsRoot: string;
  /** The MOUNT's root, for the administrative-entry prune — never a removal target. */
  readonly canonicalRoot: string;
}

/** Everything `git worktree add` needs, named so the five cannot be transposed. */
interface WorktreeMaterialization {
  readonly canonicalRoot: string;
  readonly worktreeRootsDirectory: string;
  readonly fsRoot: string;
  readonly branchName: string;
  readonly baseRef: string;
}

// --------------------------------------------------------------------------
// Branch-name derivation — the `Spec-010 §Default Behavior` pattern, filled in
// by the `Spec-010 §Resolved Questions and V1 Scope Decisions` slug rule
// --------------------------------------------------------------------------

/**
 * Derive the daemon's default branch name:
 * `sidekicks/<session-short-id>/<task-slug>`.
 *
 * The `<task-slug>` is the queue-item summary lowercased, with non-alphanumeric
 * runs collapsed to `-`, leading/trailing `-` trimmed, and the result truncated
 * to 40 characters at a `-` boundary. With no usable summary it is
 * `run-<run-short-id>`.
 *
 * SIGNATURE. The plan's T2.2 row writes this helper's inputs as the shorthand
 * `(summary?, runId)` and its output as the slug. Both are expanded here, and
 * both expansions are forced by the rule itself rather than chosen:
 *
 *   * It takes an OBJECT including `sessionId`, because `<session-short-id>` is
 *     a segment of the pattern and the shorthand names no input that could
 *     produce it. Three positional strings of which two are optional would also
 *     be transposable at the call site; a named object is not.
 *   * It returns the FULL `sidekicks/<session-short-id>/<task-slug>`, not the
 *     slug segment alone. A helper returning only the segment would leave every
 *     caller re-spelling the prefix and the short-id derivation, which is how
 *     one naming rule becomes three subtly different ones.
 *
 * This is also the shape T2.4 wants: the run-setup gate holds the session, the
 * run and the queue-item summary, and needs a branch NAME to hand
 * {@link WorktreeService.create}, whose `branchName` is required (D-010-19).
 *
 * Throws `WorktreeCreateFailedError` with `branch_name_underivable` when neither
 * input is usable, so the rule's precondition is enforced where the rule lives —
 * and only here, since `create` no longer derives.
 *
 * Exported for the gate, for T2.4, and for the suite: the table-driven cases are
 * the readable form of the spec rule, and they cannot be written against a
 * private function.
 */
export function deriveWorktreeBranchName(input: WorktreeBranchNameInput): string {
  const taskSlug = slugifyTaskSummary(input.taskSummary ?? null) ?? runFallbackSlug(input.runId);
  if (taskSlug === null) {
    throw new WorktreeCreateFailedError("branch_name_underivable");
  }
  return `${DERIVED_BRANCH_NAME_PREFIX}/${shortId(input.sessionId)}/${taskSlug}`;
}

/**
 * First {@link SHORT_ID_LENGTH} hex digits of an identifier.
 *
 * Hyphens are stripped before slicing so the canonical UUID form and its
 * unhyphenated spelling yield the same short id, and the result is lowercased
 * because a branch name should not vary with the casing a caller happened to
 * pass. A shorter-than-8 id yields whatever it has rather than padding — a
 * short id is a display convenience, and the row's own `id` column is what
 * anything durable joins on.
 */
function shortId(identifier: string): string {
  return identifier.replace(/-/g, "").slice(0, SHORT_ID_LENGTH).toLowerCase();
}

/**
 * The `run-<run-short-id>` fallback, or `null` when there is no run — the
 * pre-run explicit prepare, which is exactly the case D-010-19 requires a
 * caller-supplied `branchName` for.
 */
function runFallbackSlug(runId: string | null): string | null {
  if (runId === null || runId.length === 0) {
    return null;
  }
  return `run-${shortId(runId)}`;
}

/**
 * The slug rule, applied to a summary. `null` when there is no summary or
 * nothing survives normalization (a summary of `"..."` collapses to empty).
 *
 * ASCII-only alphanumerics. Git refs may carry UTF-8, but the slug becomes a
 * directory-adjacent identifier that has to round-trip across the three
 * platforms the daemon supports — where normalization form, case folding and
 * encoding all differ — so a non-ASCII letter is treated as a separator rather
 * than transliterated. `toLowerCase` runs first so the character class only has
 * to name lowercase letters.
 */
function slugifyTaskSummary(taskSummary: string | null): string | null {
  if (taskSummary === null) {
    return null;
  }
  const collapsed = taskSummary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (collapsed.length === 0) {
    return null;
  }
  return truncateSlugAtBoundary(collapsed, TASK_SLUG_MAX_LENGTH);
}

/**
 * Truncate to `maxLength`, preferring a `-` boundary so the tail is not a
 * half-word.
 *
 * Three cases, in order:
 *   1. Already short enough — returned unchanged.
 *   2. The character AT `maxLength` is a `-`, so the clip already lands on a
 *      word end and the full `maxLength` characters are kept. Without this case
 *      the boundary search below would drop a complete trailing word for
 *      nothing.
 *   3. Otherwise the last `-` inside the clip is the cut point. A slug with no
 *      interior `-` (one long word) has no boundary to prefer and is cut hard
 *      at `maxLength` rather than to nothing.
 */
function truncateSlugAtBoundary(slug: string, maxLength: number): string {
  if (slug.length <= maxLength) {
    return slug;
  }
  const clipped = slug.slice(0, maxLength);
  if (slug.charAt(maxLength) === "-") {
    return clipped;
  }
  const lastBoundary = clipped.lastIndexOf("-");
  if (lastBoundary <= 0) {
    return clipped;
  }
  return clipped.slice(0, lastBoundary);
}

// --------------------------------------------------------------------------
// Default seam implementations
// --------------------------------------------------------------------------

/**
 * The strip list, keyed for case-insensitive lookup.
 *
 * The list itself is IMPORTED from `../workspace/repo-root-resolver.js` rather
 * than re-spelled. It is a security fact — which ambient variables can redirect
 * git's repository discovery — and two copies of a security fact drift, with
 * the copy that stopped being maintained silently handing a redirected
 * `GIT_DIR` to a `worktree add`. This is a same-package import of an
 * already-exported constant, not a new cross-plan module edge; the ASSEMBLY
 * below is local because its rationale (uppercased comparison,
 * rebuild-by-omission) is documented at that export.
 */
const DISCOVERY_REDIRECTING_GIT_ENV_KEYS_UPPERCASED = new Set(
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS.map((key) => key.toUpperCase()),
);

/**
 * The environment every git invocation runs under. Read at call time so a
 * daemon that mutates its own environment is followed rather than snapshotted.
 */
function buildWorktreeGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (DISCOVERY_REDIRECTING_GIT_ENV_KEYS_UPPERCASED.has(key.toUpperCase())) {
      continue;
    }
    environment[key] = value;
  }
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  // `worktree add` never authenticates, but a git that decided to prompt would
  // block on a terminal the daemon does not have until the timeout fires.
  environment["GIT_TERMINAL_PROMPT"] = "0";
  return environment;
}

/** `execFile` with an argv ARRAY — never a shell string. See the header. */
function runGitWithExecFile(
  argv: readonly string[],
  options: WorktreeGitInvocationOptions,
): Promise<WorktreeGitInvocationResult> {
  return new Promise<WorktreeGitInvocationResult>((resolve, reject) => {
    execFile(
      DEFAULT_GIT_EXECUTABLE,
      [...argv],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: GIT_STDIO_MAX_BUFFER_BYTES,
        env: buildWorktreeGitEnvironment(),
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

const DEFAULT_WORKTREE_FILESYSTEM: WorktreeFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};

// --------------------------------------------------------------------------
// WorktreeService
// --------------------------------------------------------------------------

/**
 * Owns every `worktrees` transition and every worktree-scoped git invocation.
 *
 * Statement-per-transition, following `../workspace/workspace-service.js`: each
 * `UPDATE` carries its own legal-predecessor set in its `WHERE` clause, so the
 * transition table lives in the statements rather than in branches that can
 * drift from them.
 */
export class WorktreeService {
  readonly #events: WorktreeEventEmitter;
  readonly #executionRootsDirectory: string;
  readonly #hookNeutralizationDirectory: string;
  readonly #git: WorktreeGitRunner;
  readonly #filesystem: WorktreeFilesystem;
  readonly #gitCommandTimeoutMs: number;
  readonly #now: () => string;
  readonly #newWorktreeId: () => string;

  readonly #selectAttachedMountStmt: Statement<MountLookupParams, AttachedMountRow>;
  readonly #selectWorktreeStmt: Statement<WorktreeLookupParams, WorktreeRow>;
  readonly #selectLiveWorktreeOnBranchStmt: Statement<BranchLookupParams, WorktreeIdRow>;
  readonly #selectBusyHolderStmt: Statement<WorktreeLookupParams, HoldingWorkspaceRow>;
  readonly #selectSweepableStmt: Statement<[], WorktreeRow>;
  readonly #selectUncleanedRetiredStmt: Statement<[], WorktreeRootRow>;
  readonly #insertWorktreeStmt: Statement<InsertWorktreeParams>;
  readonly #markReadyStmt: Statement<WorktreeTransitionParams>;
  readonly #markFailedStmt: Statement<WorktreeTransitionParams>;
  readonly #retireStmt: Statement<WorktreeTransitionParams>;
  readonly #stampCleanedStmt: Statement<WorktreeTransitionParams>;

  constructor(deps: WorktreeServiceDeps) {
    this.#events = deps.events;
    this.#executionRootsDirectory = deps.executionRootsDirectory;
    this.#hookNeutralizationDirectory = join(
      deps.executionRootsDirectory,
      HOOK_NEUTRALIZATION_SEGMENT,
    );
    this.#git = deps.git ?? runGitWithExecFile;
    this.#filesystem = deps.filesystem ?? DEFAULT_WORKTREE_FILESYSTEM;
    this.#gitCommandTimeoutMs = deps.gitCommandTimeoutMs ?? DEFAULT_WORKTREE_GIT_TIMEOUT_MS;
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newWorktreeId = deps.newWorktreeId ?? ((): string => randomUUID());

    const database = deps.database;

    // Scoped to `state = 'attached'`, the Plan-009 ordering obligation: a
    // detached mount is not a provisioning target, and `repo.not_found` is a
    // more honest answer than letting it reach the git layer.
    this.#selectAttachedMountStmt = database.prepare<MountLookupParams, AttachedMountRow>(
      `SELECT id, canonical_root
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    this.#selectWorktreeStmt = database.prepare<WorktreeLookupParams, WorktreeRow>(
      `SELECT id, repo_mount_id, created_by_session_id, created_by_run_id,
              branch_name, fs_root, state, cleaned_at
         FROM worktrees
        WHERE id = @worktree_id`,
    );

    // The UNIQUE-violation confirmation read. Its predicate is the index's
    // predicate, so "live" here means exactly what the arbiter means by it.
    this.#selectLiveWorktreeOnBranchStmt = database.prepare<BranchLookupParams, WorktreeIdRow>(
      `SELECT id
         FROM worktrees
        WHERE repo_mount_id = @repo_mount_id
          AND branch_name = @branch_name
          AND ${LIVE_WORKTREE_STATE_PREDICATE}
        LIMIT 1`,
    );

    // The retire-conflict probe, executed INSIDE the retirement transaction
    // (`#emitRetirement`'s prelude) rather than before it — see the header's
    // I-010-9 section for the window an outside probe leaves open.
    // `branch_contexts` is the ONLY link between a worktree and a workspace —
    // `worktrees` has no `workspace_id` column — and a `busy` workspace is
    // precisely CP-009-7's "a run is holding this root".
    this.#selectBusyHolderStmt = database.prepare<WorktreeLookupParams, HoldingWorkspaceRow>(
      `SELECT workspaces.id AS workspace_id
         FROM branch_contexts
         JOIN workspaces ON workspaces.id = branch_contexts.workspace_id
        WHERE branch_contexts.worktree_id = @worktree_id
          AND workspaces.state = 'busy'
        LIMIT 1`,
    );

    // D-010-13's inactive-mount cascade. `state <> 'attached'` rather than
    // `= 'detached'` so an archived mount cascades too — both mean the daemon
    // no longer has a live attachment to check out from.
    //
    // The busy probe is STRUCTURAL on this arm rather than absent: it lives in
    // `#emitRetirement`'s prelude, which both callers share. It is expected to
    // find nothing here — Plan-009's detach refuses while a dependent workspace
    // is busy, so a non-attached mount cannot have one — and a conflict firing
    // on this arm therefore reports a real inconsistency between the two plans'
    // tables, correctly propagated fail-closed rather than swept past.
    this.#selectSweepableStmt = database.prepare<[], WorktreeRow>(
      `SELECT worktrees.id, worktrees.repo_mount_id, worktrees.created_by_session_id,
              worktrees.created_by_run_id, worktrees.branch_name, worktrees.fs_root,
              worktrees.state, worktrees.cleaned_at
         FROM worktrees
         JOIN repo_mounts ON repo_mounts.id = worktrees.repo_mount_id
        WHERE repo_mounts.state <> 'attached'
          AND ${LIVE_WORKTREE_STATE_PREDICATE}
        ORDER BY worktrees.created_at ASC, worktrees.id ASC`,
    );

    // The mount's canonical root rides along for the `worktree prune` that
    // unregisters the administrative entry `worktree add` left in the USER's
    // repository. LEFT joined, deliberately: an INNER join would let a row whose
    // mount is missing drop out of the sweep entirely, so a cosmetic cleanup
    // would silently shrink the row set of the load-bearing one and strand the
    // directory forever. A NULL canonical root skips the prune and nothing else.
    //
    // The NULL arm is UNREACHABLE through this package's own code, under any
    // pragma setting, for two independent reasons: `worktrees.repo_mount_id` is
    // `NOT NULL REFERENCES repo_mounts(id)` with no `ON DELETE` clause — so
    // NO ACTION refuses the parent delete while a child row exists — and no
    // `DELETE FROM repo_mounts` is issued anywhere in the daemon regardless.
    // It is kept for what those two facts do NOT cover: an out-of-band mutation
    // (a repair script, a future writer, a handle opened without
    // `applyPragmas`, hence without `foreign_keys = ON`). On such a row the
    // load-bearing removal must still run, which is the whole argument for the
    // LEFT join — so the arm is defense in depth rather than a live case.
    this.#selectUncleanedRetiredStmt = database.prepare<[], WorktreeRootRow>(
      `SELECT worktrees.id, worktrees.fs_root, repo_mounts.canonical_root
         FROM worktrees
         LEFT JOIN repo_mounts ON repo_mounts.id = worktrees.repo_mount_id
        WHERE worktrees.state = 'retired' AND worktrees.cleaned_at IS NULL
        ORDER BY worktrees.updated_at ASC, worktrees.id ASC`,
    );

    // `state` is left to the column DEFAULT ('creating') rather than written:
    // the DDL and the D-010-12 mapping already agree that a new row starts
    // there, and naming it here would be a second copy of that fact.
    this.#insertWorktreeStmt = database.prepare<InsertWorktreeParams>(
      `INSERT INTO worktrees (
         id, repo_mount_id, created_by_session_id, created_by_run_id,
         branch_name, fs_root, created_at, updated_at
       ) VALUES (
         @id, @repo_mount_id, @created_by_session_id, @created_by_run_id,
         @branch_name, @fs_root, @now, @now
       )`,
    );

    this.#markReadyStmt = database.prepare<WorktreeTransitionParams>(
      `UPDATE worktrees
          SET state = 'ready', updated_at = @now
        WHERE id = @worktree_id AND state = 'creating'`,
    );

    // No event accompanies this one (D-010-11 / I-010-13): the failure incident
    // is evented as `workspace.stale` by the coupled `failReprovision`.
    this.#markFailedStmt = database.prepare<WorktreeTransitionParams>(
      `UPDATE worktrees
          SET state = 'failed', updated_at = @now
        WHERE id = @worktree_id AND state = 'creating'`,
    );

    // Every non-`retired` state is a legal predecessor, `failed` included. The
    // idempotent no-op for an already-`retired` row is taken by the prelude's
    // own state re-read, two statements earlier in the SAME transaction, so
    // `state <> 'retired'` matching nothing here means the row moved under a
    // read this transaction already performed — a genuine invariant violation
    // rather than "already done", which is why it keeps the plain assert.
    this.#retireStmt = database.prepare<WorktreeTransitionParams>(
      `UPDATE worktrees
          SET state = 'retired', updated_at = @now
        WHERE id = @worktree_id AND state <> 'retired'`,
    );

    // Guarded on `cleaned_at IS NULL` so a concurrent pass that already stamped
    // the row does not have its timestamp overwritten.
    this.#stampCleanedStmt = database.prepare<WorktreeTransitionParams>(
      `UPDATE worktrees
          SET cleaned_at = @now, updated_at = @now
        WHERE id = @worktree_id AND cleaned_at IS NULL`,
    );
  }

  // ------------------------------------------------------------------------
  // create
  // ------------------------------------------------------------------------

  /**
   * Provision a worktree: resolve the base ref, record the row and its
   * `worktree.created` event, materialize the checkout, then record `ready` and
   * its `worktree.ready` event.
   *
   * The ORDER is the contract, and each step sits where its failure is
   * survivable:
   *
   * 1. **Mount resolution and base-ref refusals happen before any row exists.**
   *    A request that cannot proceed leaves no `worktrees` row at all — there
   *    is nothing to mark `failed`, because nothing was created.
   * 2. **Row + `worktree.created` commit together**, through the emitter's
   *    transactional prelude (I-010-13). This is where I-010-4's arbitration
   *    happens.
   * 3. **Materialization runs with the row already durable.** A failure here
   *    marks the row `failed` (no event, D-010-11) and throws, so the incident
   *    is queryable through `repo.worktreeStatusRead` rather than vanishing.
   * 4. **The `-> ready` flip and `worktree.ready` commit together**, and a
   *    failure here takes the SAME recovery as step 3 rather than propagating
   *    bare. `creating` is a LIVE state to `idx_worktrees_active_branch` and no
   *    sweep leg can reach a row sitting in it, so a bare throw would wedge the
   *    (mount, branch) pair for the daemon's lifetime.
   *
   * The caller — the execution-root orchestrator — is what turns the throw into
   * the workspace-level disposition, calling Plan-009's `failReprovision` so the
   * workspace goes `stale` with the detail and the run parks in setup
   * (`Spec-010 §Fallback Behavior`). This service never substitutes a different
   * execution mode (I-010-7).
   */
  async create(input: CreateWorktreeInput): Promise<CreatedWorktree> {
    const mount = this.#requireAttachedMount(input.repoMountId);

    // `#resolveBaseRef` refuses an option-like `baseRef` before spawning
    // anything, so a request that cannot proceed never reaches a process. Its
    // other arm — D-010-8's default resolution — IS a git call, and a read-only
    // one. No branch-name derivation happens here or anywhere below this seam.
    const baseRef = await this.#resolveBaseRef(mount.canonical_root, input.baseRef);

    // Minted once, before the arbitration loop: the id is the row's primary key
    // AND the last segment of `fs_root`, and re-minting per attempt would move
    // the root for a reason that has nothing to do with the root.
    const worktreeId = this.#newWorktreeId();
    const worktreeRootsDirectory = join(
      this.#executionRootsDirectory,
      input.repoMountId,
      WORKTREE_ROOTS_SEGMENT,
    );
    const fsRoot = join(worktreeRootsDirectory, worktreeId);

    const branchName = await this.#insertCreatingRow({ worktreeId, fsRoot, input });

    try {
      await this.#materializeWorktree({
        canonicalRoot: mount.canonical_root,
        worktreeRootsDirectory,
        fsRoot,
        branchName,
        baseRef,
      });
    } catch (materializationFailure) {
      await this.#recordCreateFailure({
        worktreeId,
        fsRoot,
        canonicalRoot: mount.canonical_root,
      });
      throw materializationFailure;
    }

    try {
      await this.#events.emitWorktreeReady({
        sessionId: input.sessionId,
        worktreeId,
        repoMountId: input.repoMountId,
        actor: input.actor ?? null,
        ...(input.correlationId != null ? { correlationId: input.correlationId } : {}),
        transactionalPrelude: () => {
          assertSingleRowChanged(
            this.#markReadyStmt.run({ worktree_id: worktreeId, now: this.#now() }),
            worktreeId,
            "mark ready",
          );
        },
      });
    } catch (readyEmissionFailure) {
      // The SAME recovery the materialization failure gets, and for a sharper
      // reason. A ready emission can fail for causes that have nothing to do
      // with this worktree — a signing-key read, an administrative ingest halt,
      // a disk error on the event INSERT — and every one of them would
      // otherwise leave the row in `creating`. `creating` is LIVE under
      // `idx_worktrees_active_branch`, so the (mount, branch) pair would be
      // wedged permanently, and NO sweep leg can reach such a row: leg (c)
      // wants a non-attached mount and leg (d) wants `retired`.
      //
      // `#markFailedStmt`'s `state = 'creating'` predicate matches here because
      // a rejected append committed nothing: the prelude's `-> ready` write and
      // the event row share one transaction, and the only post-commit work the
      // append path does is an `event.shredded` callback this type never
      // reaches. Re-throws the ORIGINAL failure, so the caller still learns why
      // provisioning failed rather than what the recovery did about it.
      //
      // What the recovery cannot undo is the BRANCH: `worktree add -b` already
      // created it and no verb in this module deletes one (I-010-6), so this arm
      // is one of the header residual's three producers — the name reads free in
      // the index and is taken in git, with no retirement in the story at all.
      await this.#recordCreateFailure({
        worktreeId,
        fsRoot,
        canonicalRoot: mount.canonical_root,
      });
      throw readyEmissionFailure;
    }

    return {
      worktreeId,
      repoMountId: input.repoMountId,
      branchName,
      fsRoot,
      baseRef,
      state: "ready",
    };
  }

  // ------------------------------------------------------------------------
  // validateReuse
  // ------------------------------------------------------------------------

  /**
   * Decide whether an explicitly named candidate may be bound as an execution
   * root (D-010-15; I-010-8). Returns the candidate on success and throws
   * `WorktreeReuseConflictError` otherwise — a REFUSAL, never a substituted
   * fresh worktree.
   *
   * The check order is fixed and is part of the contract: mount, liveness,
   * branch, cleanliness. It runs cheapest-and-most-fundamental first so no git
   * process is spawned for a candidate that is already doomed, and so a
   * candidate wrong in several ways reports the most fundamental reason —
   * telling a caller their candidate is dirty when it also belongs to another
   * repository sends them to fix the wrong thing.
   *
   * A candidate id that resolves to NO row raises `WorktreeNotFoundError`
   * rather than a conflict: 409 for an id that names nothing would send a caller
   * to repair a row that is not there.
   */
  async validateReuse(input: ValidateWorktreeReuseInput): Promise<ReusableWorktreeCandidate> {
    const row = this.#selectWorktreeStmt.get({ worktree_id: input.worktreeId });
    if (row === undefined) {
      throw new WorktreeNotFoundError(input.worktreeId);
    }

    if (row.repo_mount_id !== input.repoMountId) {
      throw new WorktreeReuseConflictError(input.worktreeId, "mount_mismatch");
    }

    // Parsed rather than cast: the column's CHECK constraint makes an
    // out-of-vocabulary value reachable only through corruption, and the schema
    // enum is the honest narrowing from `string`.
    const state = WorktreeStateSchema.parse(row.state);
    if (state === "retired" || state === "failed") {
      throw new WorktreeReuseConflictError(input.worktreeId, "not_live");
    }

    // Checked BEFORE cleanliness and independently of the acknowledgement: an
    // incompatible candidate is never bindable, with or without one.
    if (row.branch_name !== input.branchName) {
      throw new WorktreeReuseConflictError(input.worktreeId, "branch_mismatch");
    }

    const dirty = await this.#isWorkingTreeDirty(input.worktreeId, row.fs_root);
    if (dirty && input.acknowledgeDirtyCandidate !== true) {
      throw new WorktreeReuseConflictError(input.worktreeId, "dirty_unacknowledged");
    }

    return {
      worktreeId: row.id,
      repoMountId: row.repo_mount_id,
      branchName: row.branch_name,
      fsRoot: row.fs_root,
      state,
      createdBySessionId: row.created_by_session_id,
      createdByRunId: row.created_by_run_id,
      dirty,
    };
  }

  // ------------------------------------------------------------------------
  // retire
  // ------------------------------------------------------------------------

  /**
   * Record a worktree's retirement: `-> retired` plus `worktree.retired`,
   * committed together, and NOTHING on disk (I-010-9). The root survives until
   * a {@link WorktreeService.cleanupPass} removes it and stamps `cleaned_at`.
   *
   * Refuses with `WorktreeRetireConflictError` while a `busy` workspace is bound
   * to the worktree — `error-contracts.md §Worktree`'s "the execution root held
   * by an active run". That refusal is decided INSIDE the retirement
   * transaction, which is what makes it a guarantee rather than a sample; see
   * the header's I-010-9 section.
   *
   * IDEMPOTENT on an already-`retired` row: the same response, and no second
   * event (I-010-13 counts one event per real transition, and there is no
   * transition here). Every other state — `failed` included — IS a legal
   * predecessor. Admitting `failed` is deliberate: it is the only route by which
   * a failed creation's row becomes sweep-eligible, and it does not contradict
   * `packages/contracts/src/worktree.ts`'s note that `failed` is not a retire
   * OUTCOME, since the response state is `retired` either way.
   */
  async retire(
    worktreeId: string,
    options: RetireWorktreeOptions = {},
  ): Promise<WorktreeRetireResponse> {
    const row = this.#selectWorktreeStmt.get({ worktree_id: worktreeId });
    if (row === undefined) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    // Parses the ROW's id, not the argument, and deliberately AFTER the
    // not-found refusal. The brand is an outbound claim about the value this
    // service stored (always a `randomUUID()`), not an inbound validation of
    // the caller's string — so a malformed id gets `WorktreeNotFoundError`,
    // the honest answer, instead of a ZodError that names no domain fault.
    const parsedWorktreeId = WorktreeIdSchema.parse(row.id);
    // A FAST PATH, not the authority. The prelude re-reads the same state
    // inside the retirement transaction and is what actually decides; this read
    // only spares an already-retired row the per-session append lock, the
    // signing-key unseal and the envelope construction — sequentially, before
    // any of that starts.
    if (WorktreeStateSchema.parse(row.state) === "retired") {
      return { worktreeId: parsedWorktreeId, state: "retired" };
    }

    try {
      await this.#emitRetirement(row, options);
    } catch (retirementFailure) {
      // EXACTLY the sentinel: a concurrent retirement committed between the
      // fast path above and the transaction, and ITS event is the one this
      // transition gets. The response is the same either way, which is what
      // makes the method idempotent rather than racy. Anything else — the busy
      // refusal, a failed append, the CAS assert — propagates.
      if (!(retirementFailure instanceof WorktreeAlreadyRetiredError)) {
        throw retirementFailure;
      }
    }
    return { worktreeId: parsedWorktreeId, state: "retired" };
  }

  // ------------------------------------------------------------------------
  // cleanupPass
  // ------------------------------------------------------------------------

  /**
   * One cleanup tick over the WORKTREE legs of D-010-13:
   *
   *   (c) worktrees on a mount that is no longer `attached` are retired —
   *       recorded and evented like any other retirement; and
   *   (d) `retired` roots with no `cleaned_at` are removed from disk, their
   *       administrative entry is pruned from the repository, and only then is
   *       the row stamped (I-010-9).
   *
   * The ephemeral-clone legs (TTL expiry and `on_run_complete` disposal) are NOT
   * here: they operate on `ephemeral_clones`, which T2.3 owns, and a sweep that
   * reached into another task's table would give that table two writers.
   *
   * (c) runs before (d) within a pass, so a cascade-retired root is cleaned in
   * the same tick rather than waiting for the next one.
   *
   * Per-row failures PROPAGATE rather than being collected: a sweep that
   * swallowed an `EACCES` would report a clean pass while a root accumulates
   * forever. The pass is idempotent and re-entrant — the removal is `force` and
   * the stamp is guarded on `cleaned_at IS NULL` — so the next tick resumes from
   * where this one stopped.
   *
   * TWO deliberate exceptions to that propagation, each narrow. A row a
   * concurrent `retire` already retired is SKIPPED on leg (c) rather than
   * failing the pass — the outcome the sweep wanted is the outcome it got, and
   * the row still reaches leg (d) in this same tick. And the administrative
   * prune on leg (d) is best-effort; see `#pruneWorktreeAdministrativeEntries`.
   */
  async cleanupPass(): Promise<WorktreeCleanupPassResult> {
    const retiredWorktreeIds: string[] = [];
    for (const row of this.#selectSweepableStmt.all()) {
      try {
        await this.#emitRetirement(row, {});
      } catch (retirementFailure) {
        if (retirementFailure instanceof WorktreeAlreadyRetiredError) {
          continue;
        }
        throw retirementFailure;
      }
      retiredWorktreeIds.push(row.id);
    }

    const cleanedWorktreeIds: string[] = [];
    for (const row of this.#selectUncleanedRetiredStmt.all()) {
      await this.#filesystem.removeDirectory(row.fs_root);
      // AFTER the removal, never before: `worktree prune` drops the entries
      // whose working tree is MISSING, so run against a directory that is still
      // there it would correctly do nothing.
      await this.#pruneWorktreeAdministrativeEntries(row.canonical_root);
      this.#stampCleanedStmt.run({ worktree_id: row.id, now: this.#now() });
      cleanedWorktreeIds.push(row.id);
    }

    return { retiredWorktreeIds, cleanedWorktreeIds };
  }

  // ------------------------------------------------------------------------
  // Internals — row writes
  // ------------------------------------------------------------------------

  #requireAttachedMount(repoMountId: string): AttachedMountRow {
    const mount = this.#selectAttachedMountStmt.get({ repo_mount_id: repoMountId });
    if (mount === undefined) {
      // Plan-009's carrier, not a Plan-010 re-mint of `repo.not_found`: one code
      // with two classes would make `instanceof` discrimination depend on which
      // module a throw site imported.
      throw new RepoMountNotFoundError(repoMountId);
    }
    return mount;
  }

  /**
   * Insert the `creating` row and append `worktree.created` in one transaction,
   * applying the request's `onCollision` policy when the index arbitrates a
   * collision (D-010-7). Returns the branch name that actually landed.
   */
  async #insertCreatingRow(attempt: CreatingRowAttempt): Promise<string> {
    const { input } = attempt;

    for (let ordinal = 1; ordinal <= MAX_BRANCH_NAME_ORDINAL; ordinal += 1) {
      const candidateBranchName =
        ordinal === 1 ? input.branchName : `${input.branchName}-${ordinal}`;

      try {
        await this.#events.emitWorktreeCreated({
          sessionId: input.sessionId,
          worktreeId: attempt.worktreeId,
          repoMountId: input.repoMountId,
          actor: input.actor ?? null,
          ...(input.correlationId != null ? { correlationId: input.correlationId } : {}),
          transactionalPrelude: () => {
            this.#insertWorktreeStmt.run({
              id: attempt.worktreeId,
              repo_mount_id: input.repoMountId,
              created_by_session_id: input.sessionId,
              // Explicit `null` rather than omission: NULL records a pre-run
              // explicit prepare, which is a fact about the worktree (I-010-3).
              created_by_run_id: input.runId ?? null,
              branch_name: candidateBranchName,
              fs_root: attempt.fsRoot,
              now: this.#now(),
            });
          },
        });
        return candidateBranchName;
      } catch (appendFailure) {
        // Anything that is not a CONFIRMED live-branch collision re-throws
        // unchanged. Two checks, neither redundant: the CODE refuses a failure
        // no unique constraint raised (a primary-key collision among them), and
        // the live-row read refuses a UNIQUE-coded one this (mount, branch)
        // cannot account for. Either, laundered into a suffix or a 409, would
        // report a plausible wrong answer. See the header for which SQLite
        // extended code arrives when.
        if (!isUniqueConstraintViolation(appendFailure)) {
          throw appendFailure;
        }
        const liveRow = this.#selectLiveWorktreeOnBranchStmt.get({
          repo_mount_id: input.repoMountId,
          branch_name: candidateBranchName,
        });
        if (liveRow === undefined) {
          throw appendFailure;
        }
        if (input.onCollision === "refuse") {
          throw new WorktreeBranchCollisionError(input.repoMountId, candidateBranchName);
        }
        // `suffix`: take the next ordinal. The failed attempt left neither a row
        // nor an event, so the retry starts clean.
      }
    }

    throw new WorktreeCreateFailedError("branch_name_unavailable");
  }

  /**
   * Record a creation failure on an existing `creating` row, and dispose of
   * whatever the failed attempt left behind.
   *
   * Reached from BOTH of `create`'s recovery arms — a failed materialization
   * and a failed `worktree.ready` emission — so the debris it faces differs:
   * the first may have left a half-written checkout, while the second follows a
   * `worktree add` that SUCCEEDED, and therefore always has a real directory and
   * a real administrative entry to dispose of.
   *
   * No event, by D-010-11. The best-effort root removal keeps a half-written
   * checkout from being the reason a retried provisioning fails on "path already
   * exists"; it is scoped to a path the daemon just minted under its own
   * execution-roots directory, keyed by a fresh worktree id, so it can only
   * reach debris this call produced.
   */
  async #recordCreateFailure(recovery: CreateFailureRecovery): Promise<void> {
    // Zero rows changed is TOLERATED rather than asserted, the same tolerance
    // `#stampCleanedStmt` carries and for a stronger reason: `assertSingleRowChanged`
    // would throw, and the throw would REPLACE the typed creation failure the
    // caller is about to re-raise with a consistency error that names neither
    // the cause nor a repair. The predicate can only miss if the row already
    // left `creating`, which on both recovery arms means some other writer has
    // already recorded a disposition for it.
    this.#markFailedStmt.run({ worktree_id: recovery.worktreeId, now: this.#now() });
    try {
      await this.#filesystem.removeDirectory(recovery.fsRoot);
      // Only once the directory is gone does the entry become prunable.
      await this.#pruneWorktreeAdministrativeEntries(recovery.canonicalRoot);
    } catch {
      // Swallowed deliberately, and ONLY here: the caller is already throwing
      // the creation failure, and replacing it with a cleanup error would hide
      // the reason provisioning failed.
      //
      // What the swallow leaves behind, stated rather than waved at: the row is
      // `failed`, and a `failed` row is excluded from BOTH sweep queries — leg
      // (c) wants a non-attached mount, leg (d) wants `retired` — so nothing
      // automatic ever disposes of this directory. It is bounded to one root
      // per failure whose cleanup ALSO failed, it stays visible through
      // `repo.worktreeStatusRead` (D-010-11), and the operator route out is the
      // ordinary one: `repo.worktreeRetire` on the failed row, which is a legal
      // transition precisely so that leg (d) can then reach it.
    }
  }

  /**
   * Append `worktree.retired` with the whole retirement decision in its prelude.
   *
   * THREE steps, in this order, all inside the one transaction the event row
   * lands in — which is what makes each of them a decision rather than a sample
   * (see the header's I-010-9 section):
   *
   *   1. RE-READ the state. Already `retired` means a concurrent retirement won
   *      between the caller's read and this transaction; the sentinel aborts so
   *      no second event is appended for one transition (I-010-13).
   *   2. BUSY PROBE. A `busy` workspace holding this worktree refuses here, and
   *      because the throw precedes the event INSERT the refusal persists
   *      nothing at all — no row flip, no `worktree.retired`.
   *   3. RETIRE. With both preceding checks having passed inside this same
   *      transaction, a compare-and-swap that moves no row is a genuine
   *      invariant violation, so it keeps the plain assert.
   */
  async #emitRetirement(row: WorktreeRow, options: RetireWorktreeOptions): Promise<void> {
    await this.#events.emitWorktreeRetired({
      // The row's OWN provenance, never a caller-supplied session: the event
      // belongs to the session that created the worktree (I-010-3), and the
      // sweep has no caller session at all.
      sessionId: row.created_by_session_id,
      worktreeId: row.id,
      repoMountId: row.repo_mount_id,
      actor: options.actor ?? null,
      ...(options.correlationId != null ? { correlationId: options.correlationId } : {}),
      transactionalPrelude: () => {
        const current = this.#selectWorktreeStmt.get({ worktree_id: row.id });
        if (current === undefined) {
          // No `DELETE` path exists on this table, so a row that read once and
          // then vanished is corruption rather than a race — and it must not
          // become a `worktree.retired` for a worktree that is not there.
          throw new Error(
            `cannot retire worktree "${row.id}": its row disappeared before the write committed`,
          );
        }
        if (WorktreeStateSchema.parse(current.state) === "retired") {
          throw new WorktreeAlreadyRetiredError(row.id);
        }

        const holder = this.#selectBusyHolderStmt.get({ worktree_id: row.id });
        if (holder !== undefined) {
          throw new WorktreeRetireConflictError(row.id, holder.workspace_id);
        }

        assertSingleRowChanged(
          this.#retireStmt.run({ worktree_id: row.id, now: this.#now() }),
          row.id,
          "retire",
        );
      },
    });
  }

  // ------------------------------------------------------------------------
  // Internals — git
  // ------------------------------------------------------------------------

  /**
   * The single git entry point. Prepends the hook-neutralization flag and
   * nothing else, so I-010-10's quantifier holds structurally (see the header).
   */
  async #runGit(argv: readonly string[]): Promise<WorktreeGitInvocationResult> {
    await this.#filesystem.createDirectory(this.#hookNeutralizationDirectory);
    return this.#git(["-c", `core.hooksPath=${this.#hookNeutralizationDirectory}`, ...argv], {
      timeoutMs: this.#gitCommandTimeoutMs,
    });
  }

  /**
   * Drop the administrative entries of worktrees whose directory is already
   * gone — the only thing that ever unregisters what `worktree add` wrote.
   *
   * Every `worktree add` leaves a `$GIT_DIR/worktrees/<name>` entry in the
   * USER's repository. Removing the directory does not remove it, so without
   * this call the entries accumulate without bound and show up in every
   * `git worktree list` the user runs. `prune` is repo-wide and idempotent, so a
   * later successful pass on the same mount clears everything earlier passes
   * left.
   *
   * INVENTED rather than ratified, in the sense `MAX_BRANCH_NAME_ORDINAL` uses:
   * D-010-13(d) authorizes the DISK removal and names no administrative-entry
   * prune, so this leg is the un-ratified inverse of the ratified `worktree
   * add`. It is taken because nothing else in the daemon ever clears those
   * entries, and the alternative is unbounded litter in the user's own
   * repository. The accepted cost is the repo-wide scope stated above: `prune`
   * takes no path selector, so it acts on the repository's whole worktree list
   * rather than only on the entry this pass orphaned.
   *
   * BEST-EFFORT, and the swallow is the design rather than an oversight. The
   * load-bearing half of the cleanup — the directory removal — has already
   * succeeded by the time this runs, and this half is bookkeeping in someone
   * else's repository: a detached mount's root may be unreadable or gone
   * entirely, and propagating that would wedge the whole sweep, leaving every
   * LATER row uncleaned over a cosmetic failure on an earlier one. The bounded
   * swallow in `#recordCreateFailure` takes the same shape for the same reason.
   *
   * A `null` root means the sweep's LEFT JOIN found no mount row — the arm
   * `#selectUncleanedRetiredStmt` documents as unreachable through this
   * package's own writes. There is nothing to prune against and nothing to
   * report, and the removal that matters has already happened.
   */
  async #pruneWorktreeAdministrativeEntries(canonicalRoot: string | null): Promise<void> {
    if (canonicalRoot === null) {
      return;
    }
    try {
      await this.#runGit(["-C", canonicalRoot, "worktree", "prune"]);
    } catch {
      // See the docblock: swallowed on purpose, and never at the expense of the
      // `cleaned_at` stamp the caller writes next.
    }
  }

  /**
   * D-010-8's base-ref policy: the supplied ref, else the mount's current HEAD
   * branch, else a typed refusal — never a guess.
   *
   * The leading-dash check runs before ANY git call, discharging the
   * option-injection obligation `packages/contracts/src/worktree.ts` assigns to
   * this task. A ref beginning with `-` reaches `git worktree add` in the
   * positional commit-ish slot, where git's option parser would still read it as
   * a flag. The alternative discharge that file names — a `--` separator before
   * the positionals — is not taken here: it would have to be verified against
   * `git worktree add`'s own argument handling, which this seam cannot do.
   *
   * A `symbolic-ref` that fails and one that succeeds with empty output both
   * land on `base_ref_unresolved`. Detached HEAD is the headline case and the
   * one D-010-8 names; a query that did not complete is deliberately folded in,
   * because both leave the daemon with no base and the decision they force is
   * the same one — refuse rather than guess.
   */
  async #resolveBaseRef(
    canonicalRoot: string,
    suppliedBaseRef: string | undefined,
  ): Promise<string> {
    if (suppliedBaseRef !== undefined) {
      if (suppliedBaseRef.startsWith("-")) {
        throw new WorktreeCreateFailedError("base_ref_option_like");
      }
      return suppliedBaseRef;
    }

    let result: WorktreeGitInvocationResult;
    try {
      result = await this.#runGit([
        "-C",
        canonicalRoot,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
    } catch {
      throw new WorktreeCreateFailedError("base_ref_unresolved");
    }

    const headBranch = result.stdout.trim();
    if (headBranch.length === 0) {
      throw new WorktreeCreateFailedError("base_ref_unresolved");
    }
    return headBranch;
  }

  /**
   * Materialize the checkout.
   *
   * Only the PARENT directory is created here. `git worktree add` refuses a
   * target that already exists and is non-empty, and creating the leaf would put
   * this module in the business of predicting which of those git tolerates.
   */
  async #materializeWorktree(materialization: WorktreeMaterialization): Promise<void> {
    try {
      await this.#filesystem.createDirectory(materialization.worktreeRootsDirectory);
    } catch {
      throw new WorktreeCreateFailedError("execution_root_unavailable");
    }

    try {
      // `-C <canonicalRoot>` rather than a `cwd`: the invocation is entirely in
      // the argv (see `WorktreeGitRunner`). `-b <branch>` creates the branch as
      // part of the add, which is what makes the branch and the checkout appear
      // together — the condition `idx_worktrees_active_branch` models.
      await this.#runGit([
        "-C",
        materialization.canonicalRoot,
        "worktree",
        "add",
        "-b",
        materialization.branchName,
        materialization.fsRoot,
        materialization.baseRef,
      ]);
    } catch {
      // The git `stderr` stops HERE. It is the value most likely to name a
      // filesystem path, and `error-contracts.md §Worktree` bans echoing one.
      throw new WorktreeCreateFailedError("git_invocation_failed");
    }
  }

  /**
   * Cleanliness verdict for a reuse candidate.
   *
   * `--porcelain` is stable across git versions and locales, and any output at
   * all means uncommitted work. A query that does not complete — including an
   * stdout overflow, which can only happen on an enormous working tree — is
   * refused rather than guessed: the acknowledgement gate is meaningless without
   * a verdict, and binding on an unknown one is the silent bind D-010-15
   * forbids.
   */
  async #isWorkingTreeDirty(worktreeId: string, fsRoot: string): Promise<boolean> {
    let result: WorktreeGitInvocationResult;
    try {
      result = await this.#runGit(["-C", fsRoot, "status", "--porcelain"]);
    } catch {
      throw new WorktreeReuseConflictError(worktreeId, "cleanliness_unresolved");
    }
    return result.stdout.trim().length > 0;
  }
}

// --------------------------------------------------------------------------
// Module helpers
// --------------------------------------------------------------------------

/**
 * Whether a thrown value is a SQLite UNIQUE-constraint violation.
 *
 * Written with `in`-operator narrowing rather than a cast: `in` narrows an
 * `object`-typed value to one carrying the key, so `thrown.code` reads as
 * `unknown` and the `typeof` check does the rest. A cast would assert a shape of
 * a value whose shape is exactly what is in question.
 *
 * The code alone is NOT treated as proof of a branch collision — see the header.
 * The caller confirms with a live-row read.
 */
function isUniqueConstraintViolation(thrown: unknown): boolean {
  if (typeof thrown !== "object" || thrown === null) {
    return false;
  }
  if (!("code" in thrown)) {
    return false;
  }
  const code: unknown = thrown.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE";
}

/**
 * Assert a compare-and-swap moved exactly one row.
 *
 * Called from inside a `transactionalPrelude`, where a throw aborts the
 * transaction and takes the event row with it — which is the point. A row that
 * moved between the read and the write must not produce a state/event pair that
 * disagree (I-010-13).
 *
 * A plain `Error` rather than a `DaemonDomainError`: this is an internal
 * consistency failure with no ratified code and no caller repair, so giving it a
 * wire identity would advertise a contract `error-contracts.md` does not carry.
 * The `WorkspaceServiceInvariantError` posture, without the export — nothing
 * downstream discriminates on this type.
 */
function assertSingleRowChanged(
  result: { readonly changes: number },
  worktreeId: string,
  attemptedAction: string,
): void {
  if (result.changes !== 1) {
    throw new Error(
      `cannot ${attemptedAction} worktree "${worktreeId}": it left its expected state before the write committed`,
    );
  }
}
