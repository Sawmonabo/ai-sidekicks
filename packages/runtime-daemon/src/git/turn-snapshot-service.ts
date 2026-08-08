// Turn-snapshot service — the daemon-side owner of the per-run snapshot refs
// under `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>` (Plan-010 Phase 5).
//
// This file lands in three passes. T5.1 (here) authors the CAPTURE leg; T5.2
// EXTENDS it with the non-mutating `resolveRestoreTarget` plus the mutating
// `restoreToTurn`, and T5.3 with the retention prune. The class, the git
// invocation layer, the ref builders and the diagnostic seam below are written
// once for all three.
//
// Spec coverage:
//   * `Spec-010 §Turn-Boundary Snapshots` — the capture temp-index recipe
//     (out-of-worktree `GIT_INDEX_FILE`, the two conversion pins plus
//     `GIT_ATTR_NOSYSTEM=1`, the single base OID reused for tree base AND
//     recorded parent, the untracked-embedded-repo `160000` normalization with
//     its unborn-`HEAD` skip, the encoding-pinned `commit-tree`, the six-var
//     host-independence env set), the epoch-namespaced create-only ref write and
//     its per-epoch idempotence, and the writable-modes-only applicability rule.
//   * `Spec-004 §Required Behavior` — the execution epoch `<E>`: `0` before any
//     rollback, advanced with each accepted `run.rolled_back`. SUPPLIED by the
//     caller and never derived here (CP-010-12).
//
// Verifies invariant: I-010-21 (snapshot refs live only under
// `refs/sidekicks/runs/…`, never `refs/heads/`, and are invisible to branch
// history by construction), I-010-22 (create-only per-epoch refs: the write is a
// compare-and-swap against ref ABSENCE, so a retried or duplicated capture never
// repoints an existing ref and a post-rollback re-execution's identical ordinal
// mints a fresh ref under its own `epoch-<E>` segment).
//
// Cross-plan obligations: CP-010-7 (this Plan-010-owned `src/git/` subtree),
// CP-010-12 (PURE CALLEE — see below).
//
// ---------------------------------------------------------------------------
// CP-010-12 — this service resolves NOTHING
// ---------------------------------------------------------------------------
//
// `executionRoot`, `runId`, `epoch`, `turnOrdinal` and `mode` all arrive as
// parameters. This module never reads `run_execution_contexts` (it holds no
// database handle at all in the capture leg), never derives the epoch from
// rollback history, and never infers the mode from the root's shape. The
// production call site — the Plan-004 run engine's turn boundary — is authored
// by the campaign's B9 bundle and owns every one of those resolutions.
//
// The `mode` self-guard is the one place the parameter is INTERPRETED rather
// than passed through, and it is deliberately a self-guard rather than a
// caller-side `if`: the Applicability bullet of `Spec-010 §Turn-Boundary
// Snapshots` makes "`read-only` runs snapshot nothing" a property of the
// mechanism, and a guard that lives only in the caller is one refactor away from
// a read-only run minting objects. It runs FIRST — before the base resolution,
// before the hook-neutralization directory, before the scratch-index directory —
// so the no-op is observable as zero git objects and zero refs rather than
// merely as an absent ref. It is also an ALLOWLIST over the writable modes named
// in that bullet, so a mode added to `ExecutionMode` later is inert here until
// somebody admits it deliberately (see {@link SNAPSHOT_APPLICABLE_MODES}).
//
// ---------------------------------------------------------------------------
// I-010-21 — the namespace is enforced at THIS layer, not by git
// ---------------------------------------------------------------------------
//
// Every ref this service writes is assembled by {@link buildTurnSnapshotRef}
// from a validated `runId` and two non-negative integers. The validation is not
// decoration: `refs/sidekicks/runs/<runId>/…` interpolates a caller-supplied
// string into a ref path, and a `runId` of `../../heads/main` would name a
// BRANCH. git's own `check-ref-format` rules do refuse that spelling ("refusing
// to update ref with bad name", confirmed on git 2.50.1), but a refusal that
// arrives from git is a capture FAILURE — which this service reports as a
// diagnostic and swallows — so relying on it would turn an invariant breach into
// a silent no-op rather than a typed refusal. The check runs before any git
// call, the same posture `./worktree-service.ts` takes for its `baseRef`
// leading-dash refusal.
//
// The second channel is the environment, and it threatens the invariant from a
// different direction than the ref PATH: an ambient `GIT_DIR` (or
// `GIT_WORK_TREE`) redirects the whole invocation at another repository, so a
// perfectly-spelled `refs/sidekicks/runs/…` would be written into a store the
// caller never named — empirically confirmed on git 2.50.1, where `-C <root>`
// does NOT win against it: `rev-parse --verify HEAD` resolves the redirected
// repository's `HEAD` and `write-tree` reports its index. `GIT_OBJECT_DIRECTORY`
// is cruder still: set WITHOUT `GIT_DIR`, the pipeline's first leg
// (`rev-parse --verify HEAD` through `-C <root>`) refuses with
// `not a git repository`, exit 128 — observed on that leg and on
// `hash-object -w`, and not generalized past them here, since one refused leg
// is already a capture that never happens. Both classes are stripped by the
// environment builder below.
//
// `GIT_NAMESPACE` is on the strip list too, but honesty about WHY matters more
// than the tidy story: it does NOT relocate these writes. Local ref plumbing —
// `update-ref`, `rev-parse`, `show-ref`, `for-each-ref` — ignores it entirely
// (empirically confirmed on git 2.50.1: a namespaced `update-ref` lands at the
// unprefixed path and reads back from a clean environment). The namespace lives
// in the pack protocol, where `upload-pack`/`receive-pack` apply it. It is
// stripped as defense in depth for a leg that may one day speak that protocol,
// not as the mechanism enforcing I-010-21. See
// {@link SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS}.
//
// ---------------------------------------------------------------------------
// I-010-22 — the CAS is the arbiter; nothing pre-checks it
// ---------------------------------------------------------------------------
//
// `git update-ref <ref> <commit> ""` — the trailing EMPTY old-value — is a
// compare-and-swap against ref absence (git 2.50.1: exit 128, "cannot lock ref
// …: reference already exists"). The capture pipeline runs unconditionally and
// the CAS decides; there is deliberately no "does the ref already exist" probe
// in front of it. A pre-check would be a SECOND arbiter racing the first, which
// is the read-then-write pattern `./worktree-service.ts`'s header refuses for
// the branch index for the same reason.
//
// The refusal is then INTERPRETED rather than parsed: on any `update-ref`
// failure the service asks `git show-ref --verify --hash <ref>`, and a ref that
// resolves is reported as idempotent success carrying the RECORDED OID — the one
// on disk, never the one this call just built. `--verify` plus a fully-qualified
// ref path keeps that read exact as defense in depth: the exit-status check in
// the runner and `#requireObjectId`'s hex pattern already refuse a bare
// `rev-parse`'s argument echo on a miss, so the flag is the third guard against
// a fabricated `already-captured`, not the sole one — the same posture the
// `GIT_NAMESPACE` entry above takes. Reading the ref rather than git's stderr
// also keeps the concurrent-capture race on the same path as the retry case:
// whoever lost the CAS reads the winner's OID.
//
// RESIDUAL, recorded rather than closed: because nothing pre-checks, a duplicate
// capture whose worktree has since changed writes a tree and a commit that no
// ref will ever point at. They are unreferenced objects, which is exactly what
// `git gc` collects, and the alternative — the pre-check — costs the arbiter.
//
// ---------------------------------------------------------------------------
// Capture NEVER throws into the turn boundary
// ---------------------------------------------------------------------------
//
// `Spec-010 §Turn-Boundary Snapshots` makes snapshots a recovery convenience,
// not a turn gate: "capture failure emits an OTel diagnostic and never blocks or
// fails the turn". So {@link TurnSnapshotService.captureTurnSnapshot} has no
// throwing path at all: the caller gets a typed result on every arm. THREE
// pieces carry that, not one, because the last two run where a `catch` cannot
// reach them:
//
//   * The mode allowlist and the ref-component validation run first and return
//     typed results directly. They spawn nothing and touch nothing, so there is
//     no rejection for a `catch` to catch.
//   * ONE `try` with a step cursor wraps every fallible leg — the scratch-index
//     directory, each git invocation, the ref write — so the caller's `failed`
//     result names the step. A cursor rather than a list of `catch`es, because a
//     leg added later inherits the reporting instead of needing its own.
//   * The `finally` and the diagnostic sink are guarded in turn, because both run
//     where that `catch` cannot see them: a `finally` runs after it has already
//     produced the result, and the sink is called from inside the failure
//     reporter itself. The `finally` takes its own `try`; the sink takes a `try`
//     AND an attached `.catch`, since its `(diagnostic) => void` type admits an
//     async implementation whose rejection no `try` would ever see (see `#emit`).
//
// Two statements sit between the validation and the `try` — building the ref
// string and minting the scratch-index path — and are deliberately outside it.
// Both are total on inputs the validation has already accepted (string
// concatenation and `randomUUID`), which is what lets the `try` start below them
// without leaving a hole in the contract.
//
// ---------------------------------------------------------------------------
// I-010-10 — hook neutralization is STRUCTURAL (D-010-10)
// ---------------------------------------------------------------------------
//
// Every git invocation goes through one private `#runGit` which prepends
// `-c core.hooksPath=<empty dir>` and `-c core.fsmonitor=false`, so the
// quantifier is discharged by there being no other way to reach git from here.
// The full rationale — why the second flag is not redundant, why the directory
// is created per invocation rather than once, and why the argv is an ARRAY and
// never a shell string — is at `./worktree-service.ts`'s header and is not
// repeated. The neutralization directory is spelled identically to that module's
// and `./ephemeral-clone-service.ts`'s on purpose: three spellings would mean
// three directories, any of which a temp reaper could remove.
//
// The shell-free rule is load-bearing here in a way it is not for the sibling
// services, because the ratified recipe is written as a PIPE
// (`git ls-files … -z | git update-index … --stdin`). It is executed as two
// `execFile` invocations with the first's stdout handed to the second's stdin —
// same data, same order, no shell — and the listing travels as a Buffer rather
// than a string so a path git emitted as raw bytes survives the hop.
//
// Refs: Plan-010 (worktree lifecycle and execution modes), Spec-010
// (§Turn-Boundary Snapshots — the normative recipe), Spec-004 (§Required
// Behavior — the execution epoch), Plan-006 (the daemon's event log, which
// snapshots deliberately do NOT append to: a snapshot is a git fact, and
// `Spec-006` registers no snapshot event).

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import {
  DEFAULT_GIT_EXECUTABLE,
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
} from "../workspace/repo-root-resolver.js";

// --------------------------------------------------------------------------
// Injected seams
// --------------------------------------------------------------------------

/**
 * Captured stdio from one SUCCESSFUL git invocation — a rejection carries its
 * own shape (see {@link TurnSnapshotGitRunner}), so nothing here describes one.
 *
 * `stdout` is a BUFFER, unlike the sibling services' string-typed results. The
 * capture pipeline's `-z` listings are byte streams — git emits path names
 * verbatim, and a path that is not valid UTF-8 would come back from a string
 * decode with replacement characters and be handed to `update-index --stdin` as
 * a path that does not exist.
 *
 * `stderr` is the EXIT-0 diagnostic channel, and it is on this shape precisely
 * because this module refuses to read it: `update-index --add --remove -z
 * --stdin` writes `Ignoring path nested/` and exits 0 on every capture that
 * contains an untracked embedded repository, so failure detection here is by
 * exit status alone. Surfacing that text on the success shape is what makes the
 * rule falsifiable — a wrapping runner can read the chatter off an invocation
 * this module treated as a success — rather than a claim only the prose makes.
 * A string, not a Buffer: it is human-facing text, never re-fed to a child.
 */
export interface TurnSnapshotGitInvocationResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Per-invocation bounds and inputs. */
export interface TurnSnapshotGitInvocationOptions {
  /** Wall-clock ceiling; the child is killed past it. */
  readonly timeoutMs: number;
  /**
   * Variables layered over the module's own git environment, AFTER its strip
   * list is applied — `GIT_INDEX_FILE` at the scratch index, `GIT_ATTR_NOSYSTEM`
   * on the staging legs, and the six-var author/committer set on `commit-tree`.
   *
   * Per-invocation rather than per-service because the recipe is not uniform:
   * `GIT_INDEX_FILE` must reach the index-touching legs and must NOT reach the
   * `rev-parse HEAD` this module runs INSIDE an embedded repository.
   */
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  /**
   * Written to the child's stdin, which is then closed. The `update-index
   * --stdin` leg is the only caller that supplies one.
   *
   * stdin is closed on EVERY invocation, supplied or not. `Spec-010
   * §Turn-Boundary Snapshots` calls out the failure mode: `commit-tree` without
   * `-m` reads its message from stdin and hangs wherever the daemon left stdin
   * open. This module always passes `-m`, so the close is the belt to that
   * braces — a hang that cannot be reintroduced by a later edit to the argv.
   */
  readonly stdin?: Buffer;
}

/**
 * The git process seam.
 *
 * Takes the COMPLETE argv — `-C <dir>` included — and no working directory, so
 * the argv is the whole invocation. Same reasoning, and the same deliberate
 * non-import of Plan-009's `GitFileExecutor`, that `./worktree-service.ts` and
 * `./ephemeral-clone-service.ts` each record at their own seam; this one differs
 * from both by carrying stdin and an environment overlay, which the snapshot
 * recipe needs and neither of theirs does.
 *
 * Rejections are opaque to this module: nothing reads a field off the thrown
 * value. Failure detection is BY EXIT STATUS ONLY, and that is not a stylistic
 * preference — `update-index --add --remove -z --stdin` writes
 * `Ignoring path nested/` to stderr and exits 0 on every capture that contains
 * an untracked embedded repository (confirmed on git 2.50.1), so a leg check
 * keyed on non-empty stderr would report a failure on exactly the input the
 * normalization pass below exists to handle.
 */
export type TurnSnapshotGitRunner = (
  argv: readonly string[],
  options: TurnSnapshotGitInvocationOptions,
) => Promise<TurnSnapshotGitInvocationResult>;

/**
 * The filesystem seam. Both verbs are idempotent: `createDirectory` creates
 * leading directories and tolerates an existing one, `removePath` removes a file
 * or a directory tree and tolerates a missing one. The tolerance is load-bearing
 * for the scratch-index cleanup, which runs in a `finally` and must not turn a
 * capture failure into a second one.
 */
export interface TurnSnapshotFilesystem {
  createDirectory(path: string): Promise<void>;
  removePath(path: string): Promise<void>;
}

/**
 * The capture pipeline's steps, in execution order. Named on the failure result
 * and on the diagnostic so a caller — and an operator reading the diagnostic —
 * learns WHERE a capture stopped without this module echoing git's stderr.
 *
 * `T5.2` adds the restore sequence's own step vocabulary as a sibling type
 * rather than by growing this one: `failedStep` on the restore result is pinned
 * name-identical to Plan-004's wire arms, and a shared union would leak capture
 * steps into a restore disposition.
 */
export type TurnSnapshotCaptureStep =
  | "validate-inputs"
  | "prepare-scratch-index"
  | "resolve-base"
  | "seed-index"
  | "list-paths"
  | "stage-paths"
  | "normalize-embedded-repositories"
  | "write-tree"
  | "commit-tree"
  | "write-ref";

/**
 * What the capture leg reports to the daemon's observability layer.
 *
 * The first two kinds are spec-named: `Spec-010 §Turn-Boundary Snapshots`
 * requires the failure diagnostic ("capture failure emits an OTel diagnostic and
 * never blocks or fails the turn") and requires the skipped commitless embedded
 * repositories to be "enumerated in the capture diagnostic" — which happens on a
 * capture that otherwise SUCCEEDED, hence the second kind rather than a field on
 * the first. The third is operational rather than spec-named: the scratch-index
 * cleanup is best-effort by construction (it must never convert a completed
 * capture into a failure), and best-effort with no report is how a daemon leaks
 * index files into its own execution-roots directory for months without a
 * signal. It is deliberately NOT a `capture-failed`: the capture it follows may
 * have fully succeeded, and the outcome is reported by the RESULT, not here.
 *
 * Paths appear here deliberately. The `error-contracts.md` no-path-echo rule
 * governs typed errors that reach the WIRE; a diagnostic is daemon-local
 * observability, and enumerating which repositories were skipped is the whole
 * content of the obligation.
 */
export type TurnSnapshotDiagnostic =
  | {
      readonly kind: "capture-failed";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      /** `null` only when the inputs were refused before a ref could be built. */
      readonly ref: string | null;
      readonly failedStep: TurnSnapshotCaptureStep;
      /** Free-form; the rejection's message when there was one. */
      readonly detail: string;
    }
  | {
      readonly kind: "embedded-repositories-skipped";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      readonly ref: string;
      /**
       * Worktree-relative paths of untracked embedded repositories that could
       * not be recorded as gitlinks — an unborn `HEAD` has no commit OID to
       * record. Porcelain `git add -A` hard-fails on this input
       * (`does not have a commit checked out`, exit 128 on git 2.50.1); capture
       * skips and enumerates instead, because capture never blocks the turn.
       */
      readonly skippedPaths: readonly string[];
    }
  | {
      readonly kind: "scratch-index-cleanup-failed";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      /** The scratch index that survived. Daemon-local, never a worktree path. */
      readonly scratchIndexPath: string;
      /** Free-form; the rejection's message when there was one. */
      readonly detail: string;
    };

export interface TurnSnapshotServiceDeps {
  /**
   * The daemon's execution-roots directory (D-010-6). Two of this service's own
   * directories hang off it: the shared hook-neutralization directory (empty, by
   * contract) and the scratch-index directory the temp-index recipe requires to
   * live OUTSIDE the worktree.
   *
   * Absolute by contract, as it is for `./worktree-service.ts`. Not re-validated
   * here; the daemon's configuration layer owns that check.
   */
  readonly executionRootsDirectory: string;
  /** Git process seam; defaults to {@link runTurnSnapshotGitWithExecFile}. */
  readonly git?: TurnSnapshotGitRunner;
  /** Filesystem seam; defaults to `node:fs/promises`. */
  readonly filesystem?: TurnSnapshotFilesystem;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /**
   * The turn-boundary instant, stamped into the snapshot commit's author and
   * committer dates. Injectable for tests.
   *
   * MUST return `Date.prototype.toISOString()` form. The value is converted to
   * git's raw `<unix-seconds> +0000` spelling, so the OFFSET never varies with
   * the host's timezone: author and committer dates are commit-object fields and
   * therefore OID inputs, and a `-0700` host would otherwise mint a different
   * snapshot OID than a `+0000` one for identical project state at the identical
   * instant (`Spec-010 §Turn-Boundary Snapshots`).
   */
  readonly now?: () => string;
  /**
   * Where capture diagnostics go. Defaults to a `console.warn` rendering.
   *
   * TRIPWIRE: `Spec-010 §Turn-Boundary Snapshots` names an OTel diagnostic, and
   * this package has no OpenTelemetry substrate yet — this seam is the
   * attachment point for one, and the default is the interim sink
   * `../pty/pty-host-selector.ts` uses for the same reason. Replace the default,
   * not the seam.
   *
   * A sink that throws is contained, and so is an `async` one that rejects —
   * this return type ADMITS a promise-returning implementation, which is what an
   * OTel exporter tends to be. See {@link TurnSnapshotService}'s `#emit`. Capture
   * never throws into the turn boundary (see the header), and an observability
   * failure is the last thing that should break a run.
   */
  readonly emitDiagnostic?: (diagnostic: TurnSnapshotDiagnostic) => void;
}

// --------------------------------------------------------------------------
// Inputs and results
// --------------------------------------------------------------------------

/**
 * Inputs for {@link TurnSnapshotService.captureTurnSnapshot}. Every field is
 * caller-resolved (CP-010-12); see the header.
 */
export interface CaptureTurnSnapshotInput {
  /**
   * The run's execution root — the worktree, the main checkout (`branch` mode)
   * or the ephemeral clone. Resolved by the caller from the
   * `run_execution_contexts` row (D-010-5); this service never reads that table.
   */
  readonly executionRoot: string;
  /**
   * The run this snapshot belongs to. Interpolated into the ref path, so it is
   * validated as a ref component before any git call (I-010-21; see the header).
   *
   * Typed `string` rather than the `RunId` brand: `packages/contracts` declares
   * that brand TYPE-ONLY until Plan-005 T4.2 ships its schema, and
   * `./worktree-service.ts` takes run provenance as a plain string for the same
   * reason.
   */
  readonly runId: string;
  /**
   * The run's execution epoch — `Spec-004 §Required Behavior`: `0` before any
   * rollback, advanced with each accepted `run.rolled_back`. SUPPLIED, never
   * derived: this service holds no rollback history and cannot reconstruct it.
   */
  readonly epoch: number;
  /** The turn position this snapshot records. Non-negative integer. */
  readonly turnOrdinal: number;
  /**
   * The run's execution mode, read by the caller from the same
   * `run_execution_contexts` row it read the root from. `read-only` returns the
   * typed no-op; `branch` / `worktree` / `ephemeral clone` run the pipeline (the
   * Applicability bullet of `Spec-010 §Turn-Boundary Snapshots`).
   */
  readonly mode: ExecutionMode;
}

/** A snapshot this call created. */
export interface TurnSnapshotCaptured {
  readonly outcome: "captured";
  /** `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>` (I-010-21). */
  readonly ref: string;
  /** The snapshot commit the ref now names. */
  readonly snapshotCommit: string;
  /**
   * The ONE base OID resolved at entry, used for both the tree base and the
   * recorded parent. Reported because the restore leg's fail-closed precondition
   * (T5.2 / I-010-23) is "current `HEAD` equals this", and a caller that wants to
   * know whether a later restore is still possible should not have to re-derive
   * it from the commit object.
   */
  readonly baseCommit: string;
  /**
   * Untracked embedded repositories that could not be recorded as gitlinks —
   * empty on the ordinary capture. The same list is enumerated in the diagnostic
   * (`Spec-010 §Turn-Boundary Snapshots`); it is repeated here so the caller can
   * record it on the turn without subscribing to the diagnostic sink.
   */
  readonly skippedEmbeddedRepositories: readonly string[];
}

/**
 * The create-only ref was already written — a retried or duplicated capture of
 * the same `(runId, epoch, turnOrdinal)` (I-010-22). Idempotent SUCCESS.
 */
export interface TurnSnapshotAlreadyCaptured {
  readonly outcome: "already-captured";
  readonly ref: string;
  /**
   * The RECORDED OID — read back off the ref, never the commit this call built.
   * That distinction is the invariant: the first successful write wins, and a
   * later capture of the same turn under the same epoch never repoints the ref
   * at later file state.
   */
  readonly snapshotCommit: string;
}

/**
 * The mode does not snapshot: nothing was captured, and nothing was written — no
 * git object, no ref, no directory (the Applicability bullet of `Spec-010
 * §Turn-Boundary Snapshots`).
 */
export interface TurnSnapshotNotApplicable {
  readonly outcome: "not-applicable";
  /**
   * `read-only-mode` is the spec-named case. `mode-not-snapshot-capable` is the
   * ALLOWLIST's default arm — reported for a mode that reaches
   * {@link SNAPSHOT_APPLICABLE_MODES} without being on it, which today is
   * unreachable and after a future `ExecutionMode` member is the deliberate
   * inert answer. Two reasons rather than one because the arms are not the same
   * fact: one is a decision the spec made, the other is a decision nobody has
   * made yet.
   */
  readonly reason: "read-only-mode" | "mode-not-snapshot-capable";
  readonly mode: ExecutionMode;
}

/**
 * Capture did not complete. The turn boundary completes anyway — this result is
 * a report, never a signal to retry or to fail the turn.
 */
export interface TurnSnapshotCaptureFailed {
  readonly outcome: "failed";
  /** `null` when the inputs were refused before a ref could be built. */
  readonly ref: string | null;
  /** Which step stopped. The detail travels on the diagnostic, not here. */
  readonly failedStep: TurnSnapshotCaptureStep;
}

/** Every outcome {@link TurnSnapshotService.captureTurnSnapshot} can report. */
export type TurnSnapshotCaptureResult =
  | TurnSnapshotCaptured
  | TurnSnapshotAlreadyCaptured
  | TurnSnapshotNotApplicable
  | TurnSnapshotCaptureFailed;

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * The ref namespace root (I-010-21). `refs/heads/` is the surface this
 * deliberately is not: snapshots stay invisible to branch history, PR
 * preparation and diff attribution, so `Spec-011` is unaffected.
 */
const SNAPSHOT_REF_ROOT = "refs/sidekicks/runs";

/**
 * The modes that snapshot — the Applicability bullet of `Spec-010
 * §Turn-Boundary Snapshots`, spelled as an ALLOWLIST.
 *
 * A denylist (`mode === "read-only"`) reads the same today and fails open
 * tomorrow: a mode added to `ExecutionMode` for some future execution surface
 * would start capturing by default, in a root nobody wrote this recipe against,
 * and the first report of it would be objects in a stranger's store. The
 * allowlist fails INERT instead — the new mode gets the typed no-op until
 * somebody adds it here on purpose. The trade-off is accepted deliberately: a
 * genuinely writable mode that nobody admits here silently stops snapshotting,
 * which costs a recovery convenience, where the denylist's failure costs a
 * guarantee.
 */
const SNAPSHOT_APPLICABLE_MODES: ReadonlySet<ExecutionMode> = new Set<ExecutionMode>([
  "worktree",
  "branch",
  "ephemeral clone",
]);

/**
 * The snapshot commit's message. FIXED — the same bytes for every snapshot, per
 * `Spec-010 §Turn-Boundary Snapshots`'s `-m <fixed snapshot message>`.
 *
 * Deliberately carries no run id, epoch or ordinal: the message is a commit-object
 * field and therefore an OID input, and identifying content in it would make two
 * snapshots of byte-identical project state at the identical instant hash
 * differently. The identity of a snapshot is its REF, which carries all three.
 */
const SNAPSHOT_COMMIT_MESSAGE = "sidekicks: turn-boundary snapshot";

/**
 * The daemon-owned author/committer identity stamped into every snapshot commit.
 *
 * Not the user's. `Spec-010 §Turn-Boundary Snapshots` records both failure modes
 * this closes: without explicit ident env, `commit-tree` hard-fails
 * (`Author identity unknown`) in a passwd-less daemon or CI container, and
 * silently stamps a passwd-derived OS ident elsewhere — machine-dependent
 * snapshot OIDs plus an identity leak into the object store.
 */
const SNAPSHOT_IDENTITY_NAME = "AI Sidekicks";
const SNAPSHOT_IDENTITY_EMAIL = "snapshots@ai-sidekicks.invalid";

// The empty directory `core.hooksPath` points at (I-010-10 / D-010-10). Spelled
// identically to `./worktree-service.ts`'s and `./ephemeral-clone-service.ts`'s:
// all three neutralize against the SAME directory under a shared execution-roots
// directory, and a third spelling would mean a third directory a reaper could
// remove out from under one of them.
const HOOK_NEUTRALIZATION_SEGMENT = ".hook-neutralization";

// Where the scratch indexes live. `Spec-010 §Turn-Boundary Snapshots` requires
// the temp index OUTSIDE the worktree — a worktree-resident scratch index would
// surface to the capture pipeline's own `ls-files -o` listing, to the restore's
// untracked-delete pass, and to the user's `git status` as stray untracked
// content. A dotted sibling of the per-mount root directories, so it can never
// collide with a mount id, exactly as the neutralization directory is; a
// `branch`-mode root is the user's own checkout somewhere else entirely, which
// this placement is trivially outside of too.
const SNAPSHOT_INDEX_SEGMENT = ".snapshot-indexes";

// Per-invocation git timeout. Matched to `./worktree-service.ts`'s bound rather
// than to the resolver's metadata-read bound: the staging legs walk the whole
// worktree, which is `worktree add`'s order of work, not `rev-parse`'s.
const DEFAULT_TURN_SNAPSHOT_GIT_TIMEOUT_MS = 120_000;

// stdout ceiling. Eight times `./worktree-service.ts`'s, because the `-z`
// listing this module reads is one NUL-terminated path per tracked-or-untracked
// file in the worktree — a repository large enough to overflow 8 MiB of
// `status --porcelain` is nowhere near the largest that can overflow 8 MiB of
// path listing. An overflow is a rejection, which the funnel reports as a
// `list-paths` failure: a capture that did not happen, never a capture that
// silently omitted the tail of the worktree.
const GIT_STDIO_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// A resolved object id, SHA-1 or SHA-256. Checked before an OID is interpolated
// into a later argv, so a leg that returned something other than an id — an
// echoed argument, a warning — stops the pipeline instead of naming a bogus
// object two commands later.
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * What a `runId` may contain to be safe as a ref path component (I-010-21).
 *
 * Deliberately far narrower than `git check-ref-format` admits. Run ids are
 * event-sourced UUIDs, so the cost of the narrow rule is zero and it needs no
 * reasoning about git's own rule set — no `..`, no `@{`, no control characters,
 * no leading dash, no path separator, by construction rather than by
 * enumeration. A caller whose id does not match gets a typed `validate-inputs`
 * failure before any git call.
 */
const SAFE_REF_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Variables stripped from the git environment IN ADDITION to
 * {@link DISCOVERY_REDIRECTING_GIT_ENV_KEYS}, which is IMPORTED rather than
 * re-spelled (two copies of a security fact drift — see that export).
 *
 * Each entry earns its place against an invariant this module carries:
 *
 *   * `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` — the snapshot
 *     tree and commit would be written to, or resolved from, an object store
 *     that is not the execution root's. A ref pointing at an object the
 *     repository cannot reach is a snapshot that restores nowhere. In practice
 *     git is blunter: `GIT_OBJECT_DIRECTORY` set without `GIT_DIR` makes every
 *     invocation refuse discovery (`not a git repository`, exit 128 on git
 *     2.50.1, `-C <root>` notwithstanding), so an unstripped one is a daemon
 *     that captures nothing anywhere.
 *   * `GIT_NAMESPACE` — defense in depth, and deliberately NOT claimed as the
 *     enforcement of I-010-21. Local ref plumbing ignores it (empirically
 *     confirmed on git 2.50.1: a namespaced `update-ref` writes the unprefixed
 *     path, and `rev-parse` / `show-ref` / `for-each-ref` read it back from a
 *     clean environment); the namespace applies in the pack protocol, so this
 *     entry is here for a future leg that speaks it rather than for the legs
 *     that exist. The invariant's environment exposure is the redirector class
 *     above — see the header.
 *   * `GIT_INDEX_FILE` — belt to the braces. Every index-touching leg sets it
 *     explicitly, so an ambient value can only reach the legs that do not use an
 *     index; stripping it keeps "the temp index is the only index this service
 *     touches" true of the whole invocation set rather than of most of it.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` are deliberately NOT here. Host
 * config is neutralized by the ratified `-c` pins — which outrank every config
 * source — and stripping the pointers as well would reach past both the spec
 * recipe and the plan row into config the daemon has no mandate over.
 *
 * EXPORTED for the suite's census, the same reason and the same shape as
 * `../workspace/repo-root-resolver.ts`'s own list: the suite keeps an
 * independent literal roster and pins the two together by set equality, so a key
 * added here and nowhere else fails rather than going silently unasserted. The
 * assertion is not circular — the roster is a second spelling, not a read of
 * this one — and the behavioral half of the coverage (a real capture run under
 * an ambient `GIT_DIR` and `GIT_OBJECT_DIRECTORY`, the two entries that
 * demonstrably redirect it) does not consult either list.
 */
export const SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS: readonly string[] = [
  ...DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_INDEX_FILE",
];

/**
 * The strip list keyed for case-insensitive lookup, and rebuilt-by-omission for
 * the Windows reason `../workspace/repo-root-resolver.ts` documents at its own
 * copy: a process that inherited `Git_Dir` would carry it past a
 * `delete environment["GIT_DIR"]` and hand it to the child, where a
 * case-insensitive process environment block makes git read it as `GIT_DIR` and
 * point the whole capture at another repository. `toUpperCase` rather than the
 * locale-sensitive variant, which maps `I` to `ı` under a Turkish locale and
 * would stop matching at all.
 */
const SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS_UPPERCASED = new Set(
  SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS.map((key) => key.toUpperCase()),
);

// --------------------------------------------------------------------------
// Ref builders
// --------------------------------------------------------------------------

/**
 * `refs/sidekicks/runs/<runId>/` — every snapshot ref of one run, and the prefix
 * T5.3's retention prune enumerates with `for-each-ref`.
 *
 * Assumes a validated `runId` (see {@link isSafeRefComponent}); both builders
 * are private to this module and both call sites validate first.
 */
function buildRunSnapshotRefPrefix(runId: string): string {
  return `${SNAPSHOT_REF_ROOT}/${runId}/`;
}

/**
 * `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>` — the ref namespace
 * `Spec-010 §Turn-Boundary Snapshots` pins, with the `epoch-<E>` segment that
 * makes create-only idempotence PER-EPOCH (I-010-22): a post-rollback
 * re-execution reuses turn ordinals, and without the segment its capture would
 * hit the superseded epoch's ref and silently resolve to the wrong tree.
 */
function buildTurnSnapshotRef(runId: string, epoch: number, turnOrdinal: number): string {
  return `${buildRunSnapshotRefPrefix(runId)}epoch-${String(epoch)}/turn-${String(turnOrdinal)}`;
}

/** See {@link SAFE_REF_COMPONENT_PATTERN}. */
function isSafeRefComponent(value: string): boolean {
  return SAFE_REF_COMPONENT_PATTERN.test(value);
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// --------------------------------------------------------------------------
// Default seam implementations
// --------------------------------------------------------------------------

/**
 * The environment every git invocation runs under: the daemon's own, minus the
 * strip list, plus the locale pin, the prompt block, and the caller's overlay.
 *
 * Read at CALL time rather than captured at construction, so a daemon that
 * mutates its own environment is followed rather than snapshotted — the
 * `../workspace/repo-root-resolver.ts` posture.
 *
 * The overlay is applied AFTER the strip, which is what lets this module set
 * `GIT_INDEX_FILE` on the legs that need it while the strip keeps an inherited
 * one off the legs that do not.
 */
function buildTurnSnapshotGitEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SNAPSHOT_NEUTRALIZED_GIT_ENV_KEYS_UPPERCASED.has(key.toUpperCase())) {
      continue;
    }
    environment[key] = value;
  }
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  // No leg here authenticates, but a git that decided to prompt would block on a
  // terminal the daemon does not have until the timeout fires.
  environment["GIT_TERMINAL_PROMPT"] = "0";
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      environment[key] = value;
    }
  }
  return environment;
}

/**
 * `execFile` with an argv ARRAY — never a shell string — carrying the stdin and
 * environment overlay the snapshot recipe needs.
 *
 * EXPORTED, unlike the sibling services' private defaults, because the T5.1
 * suite's injected-`HEAD`-advance case has to WRAP the production runner rather
 * than replace it: the assertion is that a real capture, run through the real
 * process seam, still records the base it resolved at entry when `HEAD` moves
 * between two of its legs. A suite that reimplemented the runner would be
 * asserting that against its own reimplementation.
 */
export const runTurnSnapshotGitWithExecFile: TurnSnapshotGitRunner = (
  argv: readonly string[],
  options: TurnSnapshotGitInvocationOptions,
): Promise<TurnSnapshotGitInvocationResult> => {
  return new Promise<TurnSnapshotGitInvocationResult>((resolve, reject) => {
    const child = execFile(
      DEFAULT_GIT_EXECUTABLE,
      [...argv],
      {
        encoding: "buffer",
        timeout: options.timeoutMs,
        maxBuffer: GIT_STDIO_MAX_BUFFER_BYTES,
        env: buildTurnSnapshotGitEnvironment(options.environmentOverrides),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const stderrText: string = stderr.toString("utf8");
        if (error !== null) {
          reject(Object.assign(error, { stderr: stderrText }));
          return;
        }
        resolve({ stdout, stderr: stderrText });
      },
    );
    const childStdin = child.stdin;
    if (childStdin !== null) {
      // A child that exits before draining its stdin — `update-index` refusing
      // its arguments, say — makes this write EPIPE. That is the invocation's
      // failure, already travelling on the exit status the callback rejects
      // with; an unhandled `error` event here would crash the daemon instead.
      childStdin.on("error", () => {
        /* see above */
      });
      if (options.stdin !== undefined) {
        childStdin.write(options.stdin);
      }
      childStdin.end();
    }
  });
};

const DEFAULT_TURN_SNAPSHOT_FILESYSTEM: TurnSnapshotFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removePath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};

/**
 * See {@link TurnSnapshotServiceDeps.emitDiagnostic}'s TRIPWIRE.
 *
 * Renders the identity every kind shares and hands the WHOLE record over as the
 * second argument rather than formatting per-kind. Deliberate: a per-kind
 * `switch` puts a rendering branch behind every future diagnostic member, and
 * the one that gets forgotten is silently the one nobody reads. This shape also
 * matches what the OTel sink replacing it will want — a message plus a
 * structured attribute bag — so the swap is not a rewrite.
 */
function warnDiagnostic(diagnostic: TurnSnapshotDiagnostic): void {
  console.warn(
    `turn-snapshot ${diagnostic.kind}: run=${diagnostic.runId} ` +
      `epoch=${String(diagnostic.epoch)} turn=${String(diagnostic.turnOrdinal)}`,
    diagnostic,
  );
}

/** The failure funnel's `detail`, without assuming the rejection is an `Error`. */
function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}

/**
 * `Date.prototype.toISOString()` form to git's raw `<unix-seconds> +0000`.
 *
 * The FIXED offset is the point: `git-commit-tree` resolves author and committer
 * dates from the environment, timezone included, and both are commit-object
 * fields — so an ISO string carrying the host's offset would mint a different
 * snapshot OID on a `-0700` machine than on a `+0000` one for the identical
 * instant. The raw spelling is git's own internal format and is accepted
 * verbatim (confirmed on git 2.50.1), which also sidesteps every ambiguity in
 * git's ISO parser.
 *
 * `null` for an unparseable clock — an injected `now` that did not honour the
 * contract — which the funnel reports as a `commit-tree` failure rather than
 * stamping an `Invalid Date`.
 */
function toRawGitDate(isoInstant: string): string | null {
  const milliseconds: number = Date.parse(isoInstant);
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  return `${String(Math.floor(milliseconds / 1000))} +0000`;
}

/**
 * Split a NUL-terminated `ls-files -z` listing into worktree-relative paths.
 *
 * Splits on the BUFFER rather than on a decoded string so a path git emitted as
 * raw non-UTF-8 bytes round-trips to `update-index --stdin` unchanged; the
 * decoded form is only ever used for the embedded-repository classification
 * below, where a mangled decode can at worst mis-classify a path git will report
 * again on the next capture.
 */
function splitNulTerminatedListing(listing: Buffer): readonly string[] {
  const entries: string[] = [];
  let start = 0;
  for (let index = 0; index < listing.length; index += 1) {
    if (listing[index] === 0) {
      if (index > start) {
        entries.push(listing.toString("utf8", start, index));
      }
      start = index + 1;
    }
  }
  // A listing that did not end in NUL is not a shape git produces; tolerated
  // rather than refused, because dropping a trailing path would silently omit it
  // from the snapshot.
  if (start < listing.length) {
    entries.push(listing.toString("utf8", start));
  }
  return entries;
}

// --------------------------------------------------------------------------
// TurnSnapshotService
// --------------------------------------------------------------------------

/**
 * Owns the `refs/sidekicks/runs/…` namespace and every git invocation that
 * writes into it.
 *
 * Stateless between calls by design: each capture resolves its own base, mints
 * its own scratch index and removes it again, so two concurrent captures — of
 * different runs, or of the same run's different turns — share nothing but the
 * hook-neutralization directory, which is empty by contract.
 */
export class TurnSnapshotService {
  readonly #hookNeutralizationDirectory: string;
  readonly #snapshotIndexDirectory: string;
  readonly #git: TurnSnapshotGitRunner;
  readonly #filesystem: TurnSnapshotFilesystem;
  readonly #gitCommandTimeoutMs: number;
  readonly #now: () => string;
  readonly #emitDiagnostic: (diagnostic: TurnSnapshotDiagnostic) => void;

  constructor(deps: TurnSnapshotServiceDeps) {
    this.#hookNeutralizationDirectory = join(
      deps.executionRootsDirectory,
      HOOK_NEUTRALIZATION_SEGMENT,
    );
    this.#snapshotIndexDirectory = join(deps.executionRootsDirectory, SNAPSHOT_INDEX_SEGMENT);
    this.#git = deps.git ?? runTurnSnapshotGitWithExecFile;
    this.#filesystem = deps.filesystem ?? DEFAULT_TURN_SNAPSHOT_FILESYSTEM;
    this.#gitCommandTimeoutMs = deps.gitCommandTimeoutMs ?? DEFAULT_TURN_SNAPSHOT_GIT_TIMEOUT_MS;
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#emitDiagnostic = deps.emitDiagnostic ?? warnDiagnostic;
  }

  // ------------------------------------------------------------------------
  // Capture (T5.1)
  // ------------------------------------------------------------------------

  /**
   * Record the execution root's project state — tracked plus non-ignored
   * untracked — as a snapshot commit under
   * `refs/sidekicks/runs/<runId>/epoch-<E>/turn-<N>`.
   *
   * NEVER THROWS. Every failure — an invalid input, a git leg, the ref write,
   * even a diagnostic sink that throws or rejects — becomes a typed `failed`
   * result, plus a diagnostic wherever the sink accepts one, because
   * `Spec-010 §Turn-Boundary Snapshots` makes the turn boundary complete
   * regardless: snapshots are a recovery convenience, not a turn gate.
   *
   * The recipe is `Spec-010 §Turn-Boundary Snapshots`'s, leg for leg. Its two
   * non-obvious properties, both spec-mirrored:
   *
   *   * ONE base OID, resolved once at entry and passed to both `read-tree` and
   *     `commit-tree -p`. Handing symbolic `HEAD` to both legs lets them
   *     re-resolve independently, which records an old-`HEAD` TREE under a
   *     new-`HEAD` PARENT if the branch moves mid-capture — a snapshot whose
   *     restore precondition can never be satisfied by the state it came from.
   *   * The untracked-embedded-repo normalization pass. `update-index --add`
   *     silently DROPS the trailing-slash directory entry `ls-files -o` reports
   *     for a non-ignored embedded repository (`Ignoring path nested/`, exit 0),
   *     so the bare pipeline would omit a whole repository that existed at the
   *     boundary. Each is re-recorded as a `160000` gitlink — porcelain
   *     `git add -A`'s own representation — and a commitless one is skipped and
   *     enumerated.
   */
  async captureTurnSnapshot(input: CaptureTurnSnapshotInput): Promise<TurnSnapshotCaptureResult> {
    // The mode self-guard runs FIRST — see the header. Nothing above this line
    // touches the filesystem or spawns git, which is what makes the read-only
    // no-op assertable as an unchanged object count and an unchanged ref count.
    // An ALLOWLIST, so an unrecognized mode is inert rather than captured; see
    // {@link SNAPSHOT_APPLICABLE_MODES}.
    if (!SNAPSHOT_APPLICABLE_MODES.has(input.mode)) {
      return {
        outcome: "not-applicable",
        reason: input.mode === "read-only" ? "read-only-mode" : "mode-not-snapshot-capable",
        mode: input.mode,
      };
    }

    if (
      !isSafeRefComponent(input.runId) ||
      !isNonNegativeInteger(input.epoch) ||
      !isNonNegativeInteger(input.turnOrdinal)
    ) {
      return this.#failCapture(input, null, "validate-inputs", "unusable ref components");
    }

    const ref: string = buildTurnSnapshotRef(input.runId, input.epoch, input.turnOrdinal);
    const scratchIndexPath: string = join(this.#snapshotIndexDirectory, `${randomUUID()}.index`);
    // The cursor the funnel reports. Advanced immediately before each leg, so a
    // leg added later inherits the reporting rather than needing its own catch —
    // and it starts on the FIRST statement inside the `try`, not on the first
    // git leg: the scratch-index directory is where an EACCES on the daemon's
    // own execution-roots directory lands, and reporting that as `resolve-base`
    // would send an operator to look at the repository.
    let step: TurnSnapshotCaptureStep = "prepare-scratch-index";

    try {
      await this.#filesystem.createDirectory(this.#snapshotIndexDirectory);

      step = "resolve-base";
      const baseCommit: string = await this.#resolveBaseCommit(input.executionRoot);

      step = "seed-index";
      await this.#runGit(["-C", input.executionRoot, "read-tree", baseCommit], {
        environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath },
      });

      step = "list-paths";
      // `-c` re-lists the temp index's seeded base paths so `--add --remove`
      // re-stats each one (staging tracked modifications AND deletions), while
      // `-o --exclude-per-directory=.gitignore` lists untracked files honouring
      // IN-TREE `.gitignore` rules only. `ls-files` consults no other exclude
      // source unless asked to, which is precisely why the recipe is plumbing
      // rather than `git add -A`: porcelain also honours `core.excludesFile` and
      // `$GIT_DIR/info/exclude`, with no off-switch, and a developer's private
      // ignore patterns are not project declarations (the Scope bullet of
      // `Spec-010 §Turn-Boundary Snapshots`).
      const listing: Buffer = (
        await this.#runGit(
          [
            "-C",
            input.executionRoot,
            "ls-files",
            "-co",
            "--exclude-per-directory=.gitignore",
            "-z",
          ],
          { environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath } },
        )
      ).stdout;

      step = "stage-paths";
      await this.#runGit(
        [
          "-C",
          input.executionRoot,
          // `core.autocrlf=false` pins check-in conversion off — git's own
          // default, neutralized by pinning: a host `core.autocrlf=input` or
          // `true` re-hashes CRLF worktree bytes to LF blobs, changing blob,
          // tree and snapshot OIDs for identical worktree bytes.
          // `core.attributesFile=/dev/null` plus `GIT_ATTR_NOSYSTEM=1` take the
          // user and system attribute files out of the conversion decision,
          // while in-tree `.gitattributes` — a project declaration, checked in
          // and identical on every host — stays deliberately honoured.
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.attributesFile=/dev/null",
          "update-index",
          "--add",
          "--remove",
          "-z",
          "--stdin",
        ],
        {
          environmentOverrides: {
            GIT_INDEX_FILE: scratchIndexPath,
            GIT_ATTR_NOSYSTEM: "1",
          },
          stdin: listing,
        },
      );

      step = "normalize-embedded-repositories";
      const skippedEmbeddedRepositories: readonly string[] =
        await this.#normalizeEmbeddedRepositories(input.executionRoot, scratchIndexPath, listing);

      step = "write-tree";
      const treeObjectId: string = this.#requireObjectId(
        (
          await this.#runGit(["-C", input.executionRoot, "write-tree"], {
            environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath },
          })
        ).stdout,
      );

      step = "commit-tree";
      const snapshotCommit: string = await this.#commitSnapshotTree(
        input.executionRoot,
        treeObjectId,
        baseCommit,
      );

      step = "write-ref";
      const recordedCommit: string | null = await this.#writeCreateOnlyRef(
        input.executionRoot,
        ref,
        snapshotCommit,
      );
      if (recordedCommit !== null) {
        return { outcome: "already-captured", ref, snapshotCommit: recordedCommit };
      }

      if (skippedEmbeddedRepositories.length > 0) {
        this.#emit({
          kind: "embedded-repositories-skipped",
          runId: input.runId,
          epoch: input.epoch,
          turnOrdinal: input.turnOrdinal,
          ref,
          skippedPaths: skippedEmbeddedRepositories,
        });
      }

      return {
        outcome: "captured",
        ref,
        snapshotCommit,
        baseCommit,
        skippedEmbeddedRepositories,
      };
    } catch (reason: unknown) {
      return this.#failCapture(input, ref, step, describeRejection(reason));
    } finally {
      // The scratch index is per-capture and never outlives it, on the failure
      // path as much as the success one — otherwise a daemon that fails captures
      // accumulates index files in its own execution-roots directory forever.
      // The seam's removal tolerates a missing path, so a failure BEFORE the
      // index was written costs nothing here.
      //
      // Its OWN try/catch, because a `finally` is the one place a rejection
      // escapes the funnel above: an EPERM/EBUSY from an antivirus scanner or a
      // filesystem seam that throws would replace the typed result on EVERY arm
      // — including the failure arm, where the diagnostic has already been
      // emitted and the report would be thrown away — and break the
      // never-throws contract from the one statement written to be
      // inconsequential. Best-effort, and reported rather than silent: an
      // undeletable scratch index is a real operational condition.
      try {
        await this.#filesystem.removePath(scratchIndexPath);
      } catch (reason: unknown) {
        this.#emit({
          kind: "scratch-index-cleanup-failed",
          runId: input.runId,
          epoch: input.epoch,
          turnOrdinal: input.turnOrdinal,
          scratchIndexPath,
          detail: describeRejection(reason),
        });
      }
    }
  }

  // ------------------------------------------------------------------------
  // Internals — capture legs
  // ------------------------------------------------------------------------

  /**
   * `<base>` — resolved ONCE, used for both the tree base and the recorded
   * parent (see {@link TurnSnapshotService.captureTurnSnapshot}).
   *
   * `--verify` tightens `Spec-010`'s `git rev-parse HEAD` without changing the
   * question: it demands a single revision and prints nothing on a miss, where
   * the bare form echoes its own argument (`HEAD`) to stdout with a non-zero
   * exit. The exit status is what this module reads either way; the flag plus
   * the {@link OBJECT_ID_PATTERN} check make an echoed argument unable to reach
   * a later argv even if a future git changed that.
   *
   * An unborn `HEAD` — an execution root with no commits — lands here as a
   * `resolve-base` failure, which is the honest answer: there is no parent to
   * record, so there is no snapshot to restore against.
   */
  async #resolveBaseCommit(executionRoot: string): Promise<string> {
    const result = await this.#runGit(["-C", executionRoot, "rev-parse", "--verify", "HEAD"], {});
    return this.#requireObjectId(result.stdout);
  }

  /**
   * The untracked-embedded-repo normalization pass.
   *
   * The trailing-slash entries in the listing are the directories `ls-files`
   * does not descend into — a non-ignored embedded git repository is the case
   * `Spec-010 §Turn-Boundary Snapshots` names, and `update-index --add` has
   * already silently dropped each of them.
   *
   * The classification is FAIL-SAFE rather than unborn-specific: any such entry
   * whose `rev-parse HEAD` does not yield an object id is skipped and
   * enumerated. That covers the commitless embedded repository the spec calls
   * out — porcelain `git add -A` hard-fails on it, so capture skipping honours
   * capture-never-blocks — and any other trailing-slash entry that is not a
   * repository at all, without a second code path whose behaviour nothing pins.
   *
   * `GIT_INDEX_FILE` is deliberately absent from the `rev-parse` overlay: that
   * invocation runs INSIDE the embedded repository, and pointing it at the
   * superproject's scratch index would be a category error even where it is
   * harmless.
   */
  async #normalizeEmbeddedRepositories(
    executionRoot: string,
    scratchIndexPath: string,
    listing: Buffer,
  ): Promise<readonly string[]> {
    const skipped: string[] = [];
    for (const entry of splitNulTerminatedListing(listing)) {
      if (!entry.endsWith("/")) {
        continue;
      }
      const embeddedPath: string = entry.slice(0, -1);
      let embeddedHead: string;
      try {
        embeddedHead = this.#requireObjectId(
          (
            await this.#runGit(
              ["-C", join(executionRoot, embeddedPath), "rev-parse", "--verify", "HEAD"],
              {},
            )
          ).stdout,
        );
      } catch {
        skipped.push(embeddedPath);
        continue;
      }
      // `<mode>,<object>,<path>` is a direct index insert, and the `160000`
      // gitlink is git's superproject submodule representation — the same entry
      // porcelain staging writes. The object lives in the EMBEDDED repository's
      // store and is absent from the superproject's; git records the gitlink
      // anyway (confirmed on git 2.50.1), exactly as it does for a submodule
      // whose objects were never fetched.
      await this.#runGit(
        [
          "-C",
          executionRoot,
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${embeddedHead},${embeddedPath}`,
        ],
        { environmentOverrides: { GIT_INDEX_FILE: scratchIndexPath } },
      );
    }
    return skipped;
  }

  /**
   * `commit-tree` under the encoding pin and the six-var host-independence env
   * set, so the snapshot OID is a function of project state and the turn-boundary
   * instant alone.
   *
   * `i18n.commitEncoding` pinned to UTF-8 — git's default — because a host that
   * set it to anything else writes an `encoding` header into the commit object,
   * changing the OID for identical project state. The six variables are the
   * author and committer name, email and DATE: the dates are commit-object
   * fields too, so ident env alone would still leak the host's wall-clock
   * timezone into every snapshot OID.
   */
  async #commitSnapshotTree(
    executionRoot: string,
    treeObjectId: string,
    baseCommit: string,
  ): Promise<string> {
    const stampedDate: string | null = toRawGitDate(this.#now());
    if (stampedDate === null) {
      throw new Error("turn-snapshot clock did not return an ISO-8601 instant");
    }
    const result = await this.#runGit(
      [
        "-C",
        executionRoot,
        "-c",
        "i18n.commitEncoding=utf-8",
        "commit-tree",
        treeObjectId,
        "-p",
        baseCommit,
        "-m",
        SNAPSHOT_COMMIT_MESSAGE,
      ],
      {
        environmentOverrides: {
          GIT_AUTHOR_NAME: SNAPSHOT_IDENTITY_NAME,
          GIT_AUTHOR_EMAIL: SNAPSHOT_IDENTITY_EMAIL,
          GIT_AUTHOR_DATE: stampedDate,
          GIT_COMMITTER_NAME: SNAPSHOT_IDENTITY_NAME,
          GIT_COMMITTER_EMAIL: SNAPSHOT_IDENTITY_EMAIL,
          GIT_COMMITTER_DATE: stampedDate,
        },
      },
    );
    return this.#requireObjectId(result.stdout);
  }

  /**
   * The create-only ref write (I-010-22).
   *
   * Returns `null` when this call wrote the ref, or the RECORDED OID when the
   * CAS found one already there — the idempotent-success arm. Any other failure
   * (the ref does not resolve either) propagates to the funnel.
   *
   * See the header for why the existence probe runs only AFTER the CAS refuses,
   * and why it reads the ref rather than git's stderr.
   */
  async #writeCreateOnlyRef(
    executionRoot: string,
    ref: string,
    snapshotCommit: string,
  ): Promise<string | null> {
    try {
      // The trailing EMPTY old-value is the compare-and-swap against absence.
      await this.#runGit(["-C", executionRoot, "update-ref", ref, snapshotCommit, ""], {});
      return null;
    } catch (reason: unknown) {
      const recorded: string | null = await this.#readRefIfPresent(executionRoot, ref);
      if (recorded !== null) {
        return recorded;
      }
      throw reason instanceof Error ? reason : new Error(describeRejection(reason));
    }
  }

  /** The recorded OID, or `null` when the ref does not resolve. */
  async #readRefIfPresent(executionRoot: string, ref: string): Promise<string | null> {
    try {
      // `--verify` against a FULLY-QUALIFIED ref path: no abbreviation, no
      // search path, no echo of the argument on a miss.
      const result = await this.#runGit(
        ["-C", executionRoot, "show-ref", "--verify", "--hash", ref],
        {},
      );
      return this.#requireObjectId(result.stdout);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------
  // Internals — plumbing
  // ------------------------------------------------------------------------

  /**
   * The single git entry point. Prepends the two hook-neutralization flags and
   * nothing else, so I-010-10's quantifier holds structurally (see the header
   * and `./worktree-service.ts`'s fuller treatment).
   */
  async #runGit(
    argv: readonly string[],
    options: {
      readonly environmentOverrides?: Readonly<Record<string, string>>;
      readonly stdin?: Buffer;
    },
  ): Promise<TurnSnapshotGitInvocationResult> {
    await this.#filesystem.createDirectory(this.#hookNeutralizationDirectory);
    return this.#git(
      [
        "-c",
        `core.hooksPath=${this.#hookNeutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
        ...argv,
      ],
      {
        timeoutMs: this.#gitCommandTimeoutMs,
        ...(options.environmentOverrides === undefined
          ? {}
          : { environmentOverrides: options.environmentOverrides }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      },
    );
  }

  /** See {@link OBJECT_ID_PATTERN}. Throws into the funnel on anything else. */
  #requireObjectId(stdout: Buffer): string {
    const candidate: string = stdout.toString("utf8").trim();
    if (!OBJECT_ID_PATTERN.test(candidate)) {
      throw new Error("git did not report an object id");
    }
    return candidate;
  }

  /** The one place a capture failure is reported: diagnostic, then typed result. */
  #failCapture(
    input: CaptureTurnSnapshotInput,
    ref: string | null,
    failedStep: TurnSnapshotCaptureStep,
    detail: string,
  ): TurnSnapshotCaptureFailed {
    this.#emit({
      kind: "capture-failed",
      runId: input.runId,
      epoch: input.epoch,
      turnOrdinal: input.turnOrdinal,
      ref,
      failedStep,
      detail,
    });
    return { outcome: "failed", ref, failedStep };
  }

  /**
   * Diagnostics are best-effort. A sink that throws must not become the
   * turn-blocking failure the whole capture path is written to avoid — and on
   * the failure path it would arrive from inside the failure reporter itself.
   *
   * The `try` contains the SYNCHRONOUS half. `Promise.resolve(…).catch(…)`
   * contains the other half, which the `try` cannot see: the seam is declared
   * `(diagnostic) => void`, and TypeScript's void-return assignability admits an
   * `async` implementation — an OTel exporter, most likely — whose returned
   * promise nobody is holding. A transient export failure then rejects a promise
   * with no handler, and Node's default `--unhandled-rejections=throw` takes the
   * daemon down: precisely the turn-blocking outcome this method exists to
   * prevent, arriving by the one path a `try` misses. Repo-wide ESLint is
   * non-type-aware, so `no-misused-promises` is not standing here either.
   */
  #emit(diagnostic: TurnSnapshotDiagnostic): void {
    try {
      void Promise.resolve(this.#emitDiagnostic(diagnostic)).catch(() => {
        // See the docblock: an async sink's rejection is swallowed as well.
      });
    } catch {
      // See the docblock: swallowed on purpose.
    }
  }
}
