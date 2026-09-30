/**
 * The shapes a turn snapshot service takes and returns: injected git and filesystem seams,
 * diagnostics, and the capture and retention results.
 */

import type { Database } from "better-sqlite3";

/**
 * Stdio of one successful git call. `stdout` is a Buffer because `-z` listings are bytes. `stderr`
 * is unread: `update-index` prints `Ignoring path nested/` and exits 0, so failure is by exit
 * status.
 */
export interface TurnSnapshotGitInvocationResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** The per-call options for one git invocation. */
export interface TurnSnapshotGitInvocationOptions {
  readonly timeoutMs: number;
  /**
   * Layered over the stripped environment. Per call: the embedded-repository `rev-parse HEAD` must
   * not get the scratch `GIT_INDEX_FILE`.
   */
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  /** Written to stdin, which is always closed (`commit-tree -F -` hangs on an open one). */
  readonly stdin?: Buffer;
}

/** The git process seam: the full argv, `-C <dir>` included; failure is by exit status only. */
export type TurnSnapshotGitRunner = (
  argv: readonly string[],
  options: TurnSnapshotGitInvocationOptions,
) => Promise<TurnSnapshotGitInvocationResult>;

/**
 * The filesystem-mutation seam; both verbs are idempotent, so cleanup in a `finally` cannot turn a
 * capture failure into a second one.
 */
export interface TurnSnapshotFilesystem {
  createDirectory(path: string): Promise<void>;
  removePath(path: string): Promise<void>;
}

/**
 * The capture steps in order, named on the failure result. `detect-sparse-root` and
 * `check-sparse-rules` (matcher failed, or git older than 2.41) fail closed, never non-sparse.
 */
export type TurnSnapshotCaptureStep =
  | "validate-inputs"
  | "prepare-scratch-index"
  | "resolve-base"
  | "detect-sparse-root"
  | "seed-index"
  | "list-paths"
  | "check-sparse-rules"
  | "stage-paths"
  | "normalize-embedded-repositories"
  | "write-tree"
  | "commit-tree"
  | "write-ref";

/** Why one run's snapshot refs were not pruned. */
export type TurnSnapshotRetentionSkipReason =
  | "unsafe-run-id"
  | "run-context-absent"
  /** The row read failed (closed handle, schema fault); unlike absent, retry the prune. */
  | "run-context-unreadable"
  /** The recorded `git_common_dir` is gone (repository removed). */
  | "git-dir-absent"
  /** The recorded dir exists but enumeration failed: permissions, bad store, no `git`/hook dir. */
  | "git-dir-unusable"
  /** Enumeration succeeded but an `update-ref -d` did not; refs already deleted still count. */
  | "ref-delete-failed";

/** One run the sweep declined to finish. */
export interface TurnSnapshotRetentionSkip {
  readonly runId: string;
  readonly reason: TurnSnapshotRetentionSkipReason;
  readonly detail: string;
}

/**
 * What this service reports to observability. Paths appear on purpose: a diagnostic is
 * daemon-local, unlike the typed errors that reach the wire.
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
      readonly detail: string;
    }
  | {
      readonly kind: "embedded-repositories-skipped";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      readonly ref: string;
      /**
       * Untracked embedded repositories not recorded as gitlinks: an unborn `HEAD` has no OID, or
       * the object format differs from the superproject's (measured on git 2.50.1).
       */
      readonly skippedPaths: readonly string[];
    }
  | {
      readonly kind: "scratch-index-cleanup-failed";
      readonly runId: string;
      readonly epoch: number;
      readonly turnOrdinal: number;
      /** Best-effort cleanup reports here so a surviving index file is noticed. Daemon-local. */
      readonly scratchIndexPath: string;
      readonly detail: string;
    }
  | {
      /**
       * One per sweep pass that skipped a run. Carries no `runId`, `epoch` or `turnOrdinal`;
       * {@link warnDiagnostic} branches on that.
       */
      readonly kind: "retention-prune-skipped";
      /** Every skip of the pass. Never empty: the sweep does not emit an empty enumeration. */
      readonly skipped: readonly TurnSnapshotRetentionSkip[];
      readonly examinedRunCount: number;
    }
  | {
      /**
       * A retention read failed: the sweep's candidate read or clock (no `runId`; the timer-driven
       * sweep never throws, so this is its only signal), or one run's row (carries `runId`).
       */
      readonly kind: "retention-sweep-failed";
      readonly detail: string;
      readonly runId?: string;
    };

/** Constructor dependencies of {@link TurnSnapshotService}. */
export interface TurnSnapshotServiceDeps {
  /** Absolute; holds the hook-neutralization and scratch-index directories. */
  readonly executionRootsDirectory: string;
  /** Retention only. Without it the sweep methods throw `TypeError`, not "nothing to prune". */
  readonly database?: Database;
  /** How long refs outlive a run's terminal release, in ms; defaults to a week. */
  readonly retentionWindowMs?: number;
  /** Git process seam; defaults to {@link runTurnSnapshotGitWithExecFile}. */
  readonly git?: TurnSnapshotGitRunner;
  /** Filesystem seam; defaults to `node:fs/promises`. */
  readonly filesystem?: TurnSnapshotFilesystem;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /**
   * The turn-boundary instant in `toISOString()` form. It becomes a fixed `+0000` commit date so
   * the OID never depends on the host timezone; retention compares it as text with `released_at`.
   */
  readonly now?: () => string;
  /** Defaults to `console.warn`; a sink that throws or rejects is contained. */
  readonly emitDiagnostic?: (diagnostic: TurnSnapshotDiagnostic) => void;
}

/** Inputs for {@link TurnSnapshotService.captureTurnSnapshot}; every field is caller-resolved. */
export interface CaptureTurnSnapshotInput {
  /** The worktree, or the main checkout in `bound-root` mode. */
  readonly executionRoot: string;
  /** Validated as a ref component before any git call. */
  readonly runId: string;
  /** 0 before any rollback, advanced per accepted `run.rolled_back`; the caller supplies it. */
  readonly epoch: number;
  /** Non-negative integer. */
  readonly turnOrdinal: number;
}

/** A snapshot this call created. */
export interface TurnSnapshotCaptured {
  readonly outcome: "captured";
  readonly ref: string;
  /** The snapshot commit the ref now names. */
  readonly snapshotCommit: string;
  /** The one base OID resolved at entry: both the tree base and the recorded parent. */
  readonly baseCommit: string;
  /** Not recorded as gitlinks; repeated from the diagnostic so the caller can record them. */
  readonly skippedEmbeddedRepositories: readonly string[];
}

/** The create-only ref was already written: a retry or duplicate of the same turn. */
interface TurnSnapshotAlreadyCaptured {
  readonly outcome: "already-captured";
  readonly ref: string;
  /**
   * The OID read back off the ref, not the commit this call built: the first write wins. With a
   * writer that has repository access it need not be an OID this service recorded.
   */
  readonly snapshotCommit: string;
}

/** Capture did not complete; the turn boundary completes anyway. A report, not a retry signal. */
export interface TurnSnapshotCaptureFailed {
  readonly outcome: "failed";
  /** `null` when the inputs were refused before a ref could be built. */
  readonly ref: string | null;
  /** The detail travels on the diagnostic, not here. */
  readonly failedStep: TurnSnapshotCaptureStep;
}

/** Every outcome {@link TurnSnapshotService.captureTurnSnapshot} can report. */
export type TurnSnapshotCaptureResult =
  | TurnSnapshotCaptured
  | TurnSnapshotAlreadyCaptured
  | TurnSnapshotCaptureFailed;

/**
 * What one {@link TurnSnapshotService.pruneSnapshotsForRun} did. Flat, not a union: a prune can
 * delete four refs and then be refused on the fifth.
 */
export interface TurnSnapshotRetentionPruneResult {
  readonly runId: string;
  readonly deletedRefs: readonly string[];
  /** `null` when the prune completed; otherwise why it stopped. */
  readonly skipped: TurnSnapshotRetentionSkip | null;
}

/** What one {@link TurnSnapshotService.sweepPrunableRuns} pass did. */
export interface TurnSnapshotRetentionSweepResult {
  /** Every run whose window had closed at the cutoff, skips included. */
  readonly examinedRunIds: readonly string[];
  /** The subset that completed with no skip. */
  readonly prunedRunIds: readonly string[];
  readonly deletedRefs: readonly string[];
  /** The enumeration the `retention-prune-skipped` diagnostic carries. */
  readonly skipped: readonly TurnSnapshotRetentionSkip[];
}
